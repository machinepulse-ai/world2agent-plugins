import { describe, expect, it } from "vitest";
import {
  buildIsolatedRunnerEnv,
  hashConfig,
  readJsonFromStdin,
  shouldRestartIsolatedHandle,
} from "../src/supervisor/shared.js";

describe("supervisor shared boundary", () => {
  it("builds the isolated runner env expected by the reused runner contract", () => {
    const env = buildIsolatedRunnerEnv({
      pkg: "@world2agent/sensor-fake-tick",
      sensorId: "fake-tick",
      skillId: "world2agent-sensor-fake-tick",
      ingestUrl: "http://127.0.0.1:3333/w2a/ingest",
      hmacSecret: "secret",
      statePath: "/tmp/fake-tick.json",
    });

    expect(env.W2A_PACKAGE).toBe("@world2agent/sensor-fake-tick");
    expect(env.W2A_SENSOR_ID).toBe("fake-tick");
    expect(env.W2A_SKILL_ID).toBe("world2agent-sensor-fake-tick");
    expect(env.W2A_INGEST_URL).toBe("http://127.0.0.1:3333/w2a/ingest");
  });

  it("detects whether an isolated handle needs restart", () => {
    const same = shouldRestartIsolatedHandle(
      {
        sensorId: "fake-tick",
        pkg: "@world2agent/sensor-fake-tick",
        skillId: "world2agent-sensor-fake-tick",
        webhookUrl: "http://127.0.0.1:3333/w2a/ingest",
        configHash: hashConfig({
          interval_ms: 60_000,
        }),
      },
      {
        sensor_id: "fake-tick",
        pkg: "@world2agent/sensor-fake-tick",
        skill_id: "world2agent-sensor-fake-tick",
        enabled: true,
        isolated: true,
        config: {
          interval_ms: 60_000,
        },
      },
      "http://127.0.0.1:3333/w2a/ingest",
    );

    const changed = shouldRestartIsolatedHandle(
      {
        sensorId: "fake-tick",
        pkg: "@world2agent/sensor-fake-tick",
        skillId: "world2agent-sensor-fake-tick",
        webhookUrl: "http://127.0.0.1:3333/w2a/ingest",
        configHash: "old",
      },
      {
        sensor_id: "fake-tick",
        pkg: "@world2agent/sensor-fake-tick",
        skill_id: "world2agent-sensor-fake-tick",
        enabled: true,
        isolated: true,
        config: {
          interval_ms: 60_000,
        },
      },
      "http://127.0.0.1:3333/w2a/ingest",
    );

    expect(same).toBe(false);
    expect(changed).toBe(true);
  });

  it("parses config JSON from stdin-compatible streams", async () => {
    async function* chunks() {
      yield '{"interval_ms":60000}';
    }

    await expect(readJsonFromStdin(chunks())).resolves.toEqual({
      interval_ms: 60_000,
    });
  });
});
