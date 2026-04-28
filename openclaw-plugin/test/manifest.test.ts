import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readManifest,
  removeSensorEntry,
  upsertSensorEntry,
  writeManifest,
} from "../src/manifest.js";
import type { World2AgentPaths } from "../src/types.js";

describe("manifest helpers", () => {
  it("writes and reads a normalized manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "w2a-openclaw-manifest-"));
    const paths = makePaths(root);

    await writeManifest(paths, {
      version: 1,
      sensors: [
        {
          sensor_id: "hackernews",
          pkg: "@world2agent/sensor-hackernews",
          skill_id: "ignored-on-write",
          enabled: true,
          isolated: true,
          config: { interval_ms: 30_000 },
        },
      ],
    });

    const manifest = await readManifest(paths);
    expect(manifest).toEqual({
      version: 1,
      sensors: [
        {
          sensor_id: "hackernews",
          pkg: "@world2agent/sensor-hackernews",
          skill_id: "world2agent-sensor-hackernews",
          enabled: true,
          isolated: true,
          config: { interval_ms: 30_000 },
        },
      ],
    });
  });

  it("upserts and removes entries by sensor id", () => {
    const initial = {
      version: 1 as const,
      sensors: [],
    };

    const afterInsert = upsertSensorEntry(initial, {
      sensor_id: "news",
      pkg: "@world2agent/sensor-hackernews",
      skill_id: "world2agent-sensor-hackernews",
      enabled: true,
      config: {},
    });
    const afterUpdate = upsertSensorEntry(afterInsert, {
      sensor_id: "news",
      pkg: "@world2agent/sensor-hackernews",
      skill_id: "world2agent-sensor-hackernews",
      enabled: true,
      config: { interval_ms: 60_000 },
    });

    expect(afterUpdate.sensors).toHaveLength(1);
    expect(afterUpdate.sensors[0]?.config).toEqual({ interval_ms: 60_000 });

    const removed = removeSensorEntry(afterUpdate, "news");
    expect(removed.removed?.sensor_id).toBe("news");
    expect(removed.manifest.sensors).toEqual([]);
  });
});

function makePaths(root: string): World2AgentPaths {
  return {
    baseDir: root,
    manifestFile: join(root, "sensors.json"),
    stateDir: join(root, "state"),
    sessionDir: join(root, "sessions"),
    openclawHome: join(root, ".openclaw"),
    openclawSkillsDir: join(root, ".openclaw", "skills"),
    ingestHmacSecretFile: join(root, ".secret"),
  };
}

