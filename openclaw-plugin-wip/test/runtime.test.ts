import { describe, expect, it, vi } from "vitest";

// Stub `startSensor` so SensorRuntime doesn't try to import the real
// hackernews sensor or hit the HN API. The mock returns a no-op cleanup.
const startSensorMock = vi.fn();
vi.mock("@world2agent/sdk", () => ({
  startSensor: (...args: unknown[]) => startSensorMock(...args),
  FileSensorStore: class {
    constructor(_opts: unknown) {}
    async flush() {}
  },
}));

// Avoid the dynamic-import inside `loadSensorSpec` — we replace it via the
// resolveImportTarget shim. Easier: stub `runtime.ts`'s loadSensorSpec by
// providing a fake package that resolves cleanly. We do this by mocking
// `./supervisor/shared.js`'s `resolveImportTarget` to point at a tiny
// in-memory module.
vi.mock("../src/supervisor/shared.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../src/supervisor/shared.js",
  );
  return {
    ...actual,
    resolveImportTarget: () => "data:text/javascript;base64," +
      Buffer.from("export default { start: () => () => undefined };").toString("base64"),
  };
});

import { SensorRuntime } from "../src/runtime.js";
import type { Dispatcher, SensorEntry, World2AgentPaths } from "../src/types.js";

const PATHS: World2AgentPaths = {
  baseDir: "/tmp/w2a-runtime-test",
  manifestFile: "/tmp/w2a-runtime-test/sensors.json",
  stateDir: "/tmp/w2a-runtime-test/state",
  sessionDir: "/tmp/w2a-runtime-test/sessions",
  openclawHome: "/tmp/w2a-runtime-test/.openclaw",
  openclawSkillsDir: "/tmp/w2a-runtime-test/.openclaw/skills",
  ingestHmacSecretFile: "/tmp/w2a-runtime-test/.secret",
};

const ISOLATED_NOOP = {
  apply: vi.fn(async () => ({ started: [], restarted: [], stopped: [], failed: [] })),
  terminateAll: vi.fn(async () => undefined),
};

const DISPATCHER: Dispatcher = { dispatch: vi.fn(async () => ({ ok: true })) };

const ENTRY: SensorEntry = {
  sensor_id: "hackernews",
  pkg: "@fake/sensor-hackernews",
  skill_id: "fake",
  enabled: true,
  isolated: false,
  config: {},
};

describe("SensorRuntime.applyManifest concurrency lock", () => {
  it("serializes concurrent applyManifest calls so a single sensor is only started once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    startSensorMock.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Simulate slow async start. Without the lock, three concurrent
      // applyManifest calls would all enter this window and inFlight
      // would reach 3.
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return async () => undefined; // cleanup
    });

    const runtime = new SensorRuntime({
      dispatcher: DISPATCHER,
      isolatedRunnerManager: ISOLATED_NOOP as never,
      paths: PATHS,
      log: () => undefined,
    });

    const results = await Promise.all([
      runtime.applyManifest([ENTRY]),
      runtime.applyManifest([ENTRY]),
      runtime.applyManifest([ENTRY]),
    ]);

    expect(maxInFlight).toBe(1);
    expect(startSensorMock).toHaveBeenCalledTimes(1);
    expect(results[0]?.started).toEqual(["hackernews"]);
    expect(results[1]?.started).toEqual([]);
    expect(results[2]?.started).toEqual([]);
  });

  it("queued applyManifest calls execute strictly in FIFO order", async () => {
    const order: string[] = [];
    startSensorMock.mockImplementation(async (...args: unknown[]) => {
      const ctx = (args[1] ?? {}) as Record<string, unknown>;
      const sensorId = String(((ctx as { spec?: { id?: string } }).spec?.id) ?? "?");
      order.push(`start`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`done`);
      void sensorId;
      return async () => undefined;
    });

    const runtime = new SensorRuntime({
      dispatcher: DISPATCHER,
      isolatedRunnerManager: ISOLATED_NOOP as never,
      paths: PATHS,
      log: () => undefined,
    });

    const entryA: SensorEntry = { ...ENTRY, sensor_id: "a", pkg: "@fake/a", skill_id: "a" };
    const entryB: SensorEntry = { ...ENTRY, sensor_id: "b", pkg: "@fake/b", skill_id: "b" };

    await Promise.all([runtime.applyManifest([entryA]), runtime.applyManifest([entryB])]);

    // The lock guarantees no interleaving — entry B's start never overlaps
    // with entry A's start. With concurrent (unlocked) execution we'd see
    // ["start", "start", "done", "done"]. Locked execution gives strictly
    // alternating start→done pairs.
    expect(order).toEqual(["start", "done", "start", "done"]);
  });
});
