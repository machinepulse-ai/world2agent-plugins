#!/usr/bin/env node

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
  const home = mkdtempSync(join(tmpdir(), "w2a-config-watch-"));
  const env = { ...process.env, HOME: home };

  const paths = getBridgePaths(env);
  await ensureBridgeDirs(paths);
  await ensureConfigFile(paths);
  await writeConfig(paths, { sensors: [] });
  const state = await loadOrCreateBridgeState(paths);

  const fakeSensorPath = join(home, "fake-sensor.mjs");
  writeFileSync(
    fakeSensorPath,
    `
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  id: "@world2agent/sensor-fake-tick",
  version: "0.1.0",
  source_type: "fake",
  auth: { type: "none" },
  async start(ctx) {
    let counter = 0;
    let stopped = false;
    const loop = async () => {
      while (!stopped) {
        counter += 1;
        const suffix = String(counter).padStart(12, "0");
        await ctx.emit({
          signal_id: \`11111111-2222-4333-8444-\${suffix}\`,
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
    return new Response("ok", { status: 200 });
  };

  const supervisor = new SensorSupervisor({
    paths,
    hmacSecret: state.hmac_secret,
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

  // SKILL.md is responsible for provisioning the webhook URL upstream and
  // writing it into config.json under `_hermes.webhook_url`. The bridge does
  // not subscribe routes itself anymore — we just inject a stable URL here.
  const webhookUrl = "http://127.0.0.1:8644/webhooks/fake-sensor";

  try {
    await writeConfig(paths, {
      sensors: [
        {
          package: fakeSensorPath,
          config: { interval_ms: 200 },
          enabled: true,
          _hermes: {
            sensor_id: "fake-sensor",
            skill_id: "fake-skill",
            webhook_url: webhookUrl,
          },
        },
      ],
    });

    await waitFor(() => supervisor.snapshot().length === 1, 10_000, "watcher reconcile spawn");
    check("watcher spawned one child", supervisor.snapshot().length === 1);
    check(
      "watcher logged spawn",
      logs.some((line) => line.includes("[w2a/fake-sensor] spawned")),
      logs.join("\n"),
    );

    await waitFor(() => deliveries.length >= 1, 10_000, "first delivery");
    check("supervisor delivered first signal", deliveries.length >= 1);
    check(
      "delivery uses configured webhook URL",
      deliveries[0]?.url === webhookUrl,
      String(deliveries[0]?.url),
    );

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
