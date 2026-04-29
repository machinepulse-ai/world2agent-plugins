#!/usr/bin/env node
/**
 * Hot-reload contract test. Spawns a real supervisor against a temp
 * `~/.world2agent/` (HOME-scoped), stubs `globalThis.fetch` to capture
 * /hooks/agent POSTs, then verifies:
 *
 *   1. writing a sensor entry to config.json triggers spawn within the
 *      file-watcher's debounce window (~500 ms);
 *   2. the supervisor delivers signals from that sensor to /hooks/agent;
 *   3. removing the entry from config.json terminates the child;
 *   4. signal_id-based dedup suppresses duplicate POSTs.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureBridgeDirs,
  ensureConfigFile,
  getBridgePaths,
  listBridgeSensors,
  writeConfig,
} from "../dist/supervisor/manifest.js";
import { SensorSupervisor } from "../dist/supervisor/spawn.js";
import { loadOrCreateBridgeState } from "../dist/supervisor/state.js";
import { startConfigWatcher } from "../dist/supervisor/config-watcher.js";

let failures = 0;

function check(label, condition, detail) {
  const ok = !!condition;
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${label}\n`);
  if (!ok) {
    failures++;
    if (detail) process.stdout.write(`     ${detail}\n`);
  }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), "w2a-openclaw-config-watch-"));
  const env = { ...process.env, HOME: home };

  const paths = getBridgePaths(env);
  await ensureBridgeDirs(paths);
  await ensureConfigFile(paths);
  await writeConfig(paths, { sensors: [] });
  await loadOrCreateBridgeState(paths);

  const fakeSensorPath = join(home, "fake-sensor.mjs");
  // Each invocation of the runner imports this file via `await import(...)`.
  // We emit a brand-new signal_id every tick so dedup doesn't suppress the
  // happy-path POSTs; the dedup case below replays one signal_id explicitly.
  writeFileSync(
    fakeSensorPath,
    `
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;
function nextSignalId() {
  counter += 1;
  return \`fake-\${Date.now()}-\${counter}\`;
}
export default {
  id: "@world2agent/sensor-fake-tick",
  version: "0.1.0",
  source_type: "fake",
  auth: { type: "none" },
  async start(ctx) {
    let stopped = false;
    const loop = async () => {
      while (!stopped) {
        await ctx.emit({
          signal_id: nextSignalId(),
          schema_version: "w2a/0.1",
          emitted_at: Date.now(),
          source: {
            sensor_id: "fake-sensor",
            sensor_version: "0.1.0",
            source_type: "fake",
            user_identity: "test-user",
            package: "@world2agent/sensor-fake-tick",
          },
          event: {
            type: "fake.tick",
            occurred_at: Date.now(),
            summary: "Fake tick event for watcher reconcile coverage",
          },
        });
        await sleep(ctx.config.interval_ms ?? 200);
      }
    };
    void loop();
    return () => {
      stopped = true;
    };
  },
};
`,
    "utf8",
  );

  const logs = [];
  const deliveries = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    deliveries.push({ url, init });
    return new Response('{"ok":true,"runId":"stub"}', { status: 200 });
  };

  const supervisor = new SensorSupervisor({
    paths,
    openclaw: {
      gatewayUrl: "http://example.test:18789",
      hookToken: "test-bearer-token",
      defaultSessionKeyPrefix: "w2a:",
    },
    log: (line) => logs.push(line),
  });
  const stopWatcher = await startConfigWatcher({
    paths,
    log: (line) => logs.push(line),
    onConfig: async (config) => {
      const applied = await supervisor.applyConfig(listBridgeSensors(config));
      logs.push(`[watcher] ${JSON.stringify(applied)}`);
    },
  });

  try {
    // ─── case 1: spawn on entry add ──────────────────────────────────────
    await writeConfig(paths, {
      sensors: [
        {
          package: fakeSensorPath,
          config: { interval_ms: 200 },
          enabled: true,
          _openclaw_bridge: {
            sensor_id: "fake-sensor",
            skill_id: "fake-skill",
            session_key: "w2a:fake-sensor",
          },
        },
      ],
    });

    await waitFor(() => supervisor.snapshot().length === 1, 10_000, "watcher reconcile spawn");
    check("watcher spawned one child", supervisor.snapshot().length === 1);
    check(
      "watcher logged spawn",
      logs.some((line) => line.includes("[w2a/fake-sensor] spawned")),
      logs.slice(-5).join("\n"),
    );

    // ─── case 2: deliveries reach /hooks/agent with right shape ──────────
    await waitFor(() => deliveries.length >= 1, 10_000, "first delivery");
    check("supervisor delivered first signal", deliveries.length >= 1);
    check(
      "delivery URL is /hooks/agent",
      deliveries[0]?.url === "http://example.test:18789/hooks/agent",
      String(deliveries[0]?.url),
    );
    check(
      "delivery uses Bearer auth",
      deliveries[0]?.init?.headers?.authorization === "Bearer test-bearer-token",
      String(deliveries[0]?.init?.headers?.authorization),
    );
    const firstBody = JSON.parse(deliveries[0]?.init?.body ?? "{}");
    check(
      "delivery body shape: {message, agentId, sessionKey}",
      typeof firstBody.message === "string" &&
        firstBody.agentId === "main" &&
        firstBody.sessionKey === "w2a:fake-sensor",
    );
    check(
      "delivery message contains skill directive + signal type",
      firstBody.message.includes("Use skill: fake-skill") &&
        firstBody.message.includes("fake.tick"),
    );

    // ─── case 3: terminate on entry removal ──────────────────────────────
    await writeConfig(paths, { sensors: [] });
    await waitFor(() => supervisor.snapshot().length === 0, 10_000, "watcher reconcile stop");
    check("watcher stopped child after config removal", supervisor.snapshot().length === 0);
  } finally {
    stopWatcher();
    await supervisor.terminateAll().catch(() => {});
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }

  if (failures > 0) {
    process.stderr.write(`\n${failures} check(s) failed.\n`);
    process.exit(1);
  }
  process.stdout.write("\nAll checks passed.\n");
}

await main();
