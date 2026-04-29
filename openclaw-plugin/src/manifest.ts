import { createHash } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import { packageToSkillId } from "@world2agent/sdk";
import { ensureWorld2AgentDirs, writeTextAtomic } from "./paths.js";
import type { SensorEntry, SensorManifest, World2AgentPaths } from "./types.js";

const DEFAULT_MANIFEST: SensorManifest = {
  version: 1,
  sensors: [],
};

export async function readManifest(paths: World2AgentPaths): Promise<SensorManifest> {
  try {
    const raw = await readFile(paths.manifestFile, "utf8");
    return parseManifest(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isMissingFile(error)) {
      return structuredClone(DEFAULT_MANIFEST);
    }
    throw error;
  }
}

export async function writeManifest(
  paths: World2AgentPaths,
  manifest: SensorManifest,
): Promise<void> {
  await ensureWorld2AgentDirs(paths);
  const normalized: SensorManifest = {
    version: 1,
    sensors: manifest.sensors.map(normalizeSensorEntry),
  };
  await writeTextAtomic(paths.manifestFile, JSON.stringify(normalized, null, 2) + "\n");
}

export function upsertSensorEntry(
  manifest: SensorManifest,
  entry: SensorEntry,
): SensorManifest {
  const normalized = normalizeSensorEntry(entry);
  const sensors = manifest.sensors.filter((item) => item.sensor_id !== normalized.sensor_id);
  sensors.push(normalized);
  sensors.sort((a, b) => a.sensor_id.localeCompare(b.sensor_id));
  return {
    version: 1,
    sensors,
  };
}

export function removeSensorEntry(
  manifest: SensorManifest,
  sensorId: string,
): {
  manifest: SensorManifest;
  removed: SensorEntry | null;
} {
  const removed = manifest.sensors.find((entry) => entry.sensor_id === sensorId) ?? null;
  return {
    manifest: {
      version: 1,
      sensors: manifest.sensors.filter((entry) => entry.sensor_id !== sensorId),
    },
    removed,
  };
}

export function normalizeSensorEntry(entry: SensorEntry): SensorEntry {
  return {
    sensor_id: entry.sensor_id,
    pkg: entry.pkg,
    skill_id: entry.skill_id?.trim() ? entry.skill_id : packageToSkillId(entry.pkg),
    enabled: entry.enabled !== false,
    isolated: entry.isolated === true,
    config: entry.config ?? {},
  };
}

export function defaultSensorId(pkg: string): string {
  const suffix = pkg.split("/").pop() ?? pkg;
  return suffix.replace(/^sensor-/, "");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

export function hashConfig(config: unknown): string {
  return createHash("sha1").update(stableStringify(config)).digest("hex");
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}

function parseManifest(raw: unknown): SensorManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Manifest must be a JSON object");
  }

  const version = (raw as Record<string, unknown>).version;
  const sensors = (raw as Record<string, unknown>).sensors;
  if (version !== 1) {
    throw new Error(`Unsupported manifest version: ${String(version)}`);
  }
  if (!Array.isArray(sensors)) {
    throw new Error("Manifest field `sensors` must be an array");
  }

  return {
    version: 1,
    sensors: sensors.map((entry, index) => parseSensorEntry(entry, index)),
  };
}

function parseSensorEntry(raw: unknown, index: number): SensorEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Manifest sensor[${index}] must be an object`);
  }

  const entry = raw as Record<string, unknown>;
  const sensorId = expectString(entry.sensor_id, `sensor[${index}].sensor_id`);
  const pkg = expectString(entry.pkg, `sensor[${index}].pkg`);
  const enabled = entry.enabled === undefined ? true : Boolean(entry.enabled);
  const isolated = entry.isolated === true;
  const config = entry.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`sensor[${index}].config must be an object`);
  }

  return {
    sensor_id: sensorId,
    pkg,
    skill_id:
      entry.skill_id === undefined
        ? packageToSkillId(pkg)
        : expectString(entry.skill_id, `sensor[${index}].skill_id`),
    enabled,
    isolated,
    config: config as Record<string, unknown>,
  };
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

