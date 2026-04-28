import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { packageToSkillId } from "@world2agent/sdk";

export interface SensorEntry {
  sensor_id: string;
  pkg: string;
  skill_id: string;
  subscription_name?: string;
  webhook_url: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface SensorManifest {
  version: 1;
  sensors: SensorEntry[];
}

export interface BridgePaths {
  baseDir: string;
  manifestFile: string;
  hmacSecretFile: string;
  controlTokenFile: string;
  supervisorPidFile: string;
  supervisorLogFile: string;
  stateDir: string;
  hermesHome: string;
  hermesSkillsDir: string;
  gatewayPidFile: string;
  webhookSubscriptionsFile: string;
  hermesEnvFile: string;
  hermesConfigYamlFile: string;
}

const DEFAULT_MANIFEST: SensorManifest = {
  version: 1,
  sensors: [],
};

export function getBridgePaths(env: NodeJS.ProcessEnv = process.env): BridgePaths {
  const hermesHome = env.HERMES_HOME ?? join(homedir(), ".hermes");
  const baseDir = env.HERMES_HOME
    ? join(hermesHome, "world2agent")
    : join(homedir(), ".world2agent");

  return {
    baseDir,
    manifestFile: join(baseDir, "sensors.json"),
    hmacSecretFile: join(baseDir, ".hmac_secret"),
    controlTokenFile: join(baseDir, ".control_token"),
    supervisorPidFile: join(baseDir, "supervisor.pid"),
    supervisorLogFile: join(baseDir, "supervisor.log"),
    stateDir: join(baseDir, "state"),
    hermesHome,
    hermesSkillsDir: join(hermesHome, "skills"),
    gatewayPidFile: join(hermesHome, "gateway.pid"),
    webhookSubscriptionsFile: join(hermesHome, "webhook_subscriptions.json"),
    hermesEnvFile: join(hermesHome, ".env"),
    hermesConfigYamlFile: join(hermesHome, "config.yaml"),
  };
}

export async function ensureBridgeDirs(paths: BridgePaths): Promise<void> {
  await mkdir(paths.baseDir, { recursive: true });
  await mkdir(paths.stateDir, { recursive: true });
  await mkdir(paths.hermesSkillsDir, { recursive: true });
}

export async function readManifest(paths: BridgePaths): Promise<SensorManifest> {
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
  paths: BridgePaths,
  manifest: SensorManifest,
): Promise<void> {
  await ensureBridgeDirs(paths);
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
    subscription_name: entry.subscription_name,
    webhook_url: entry.webhook_url,
    enabled: entry.enabled !== false,
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

export async function loadOrCreateHmacSecret(
  paths: BridgePaths,
  override?: string,
): Promise<string> {
  if (override) {
    await writeTextAtomic(paths.hmacSecretFile, `${override}\n`);
    return override;
  }

  const existing = await readTrimmedText(paths.hmacSecretFile);
  if (existing) return existing;

  const secret = randomBytes(32).toString("hex");
  await writeTextAtomic(paths.hmacSecretFile, `${secret}\n`);
  return secret;
}

export async function loadOrCreateControlToken(paths: BridgePaths): Promise<string> {
  const existing = await readTrimmedText(paths.controlTokenFile);
  if (existing) return existing;

  const token = randomBytes(32).toString("hex");
  await writeTextAtomic(paths.controlTokenFile, `${token}\n`);
  return token;
}

export async function readTrimmedText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim() || null;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function writeTextAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

export async function writePidFile(paths: BridgePaths, pid: number): Promise<void> {
  await writeTextAtomic(paths.supervisorPidFile, `${pid}\n`);
}

export async function readPidFile(paths: BridgePaths): Promise<number | null> {
  const raw = await readTrimmedText(paths.supervisorPidFile);
  if (!raw) return null;

  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export async function removePidFile(paths: BridgePaths): Promise<void> {
  await rm(paths.supervisorPidFile, { force: true });
}

export async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EPERM") return true;
    return false;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
  const webhookUrl = expectString(entry.webhook_url, `sensor[${index}].webhook_url`);
  const enabled = entry.enabled === undefined ? true : Boolean(entry.enabled);
  const config = entry.config;

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`sensor[${index}].config must be an object`);
  }

  const subscriptionName =
    entry.subscription_name === undefined
      ? undefined
      : expectString(entry.subscription_name, `sensor[${index}].subscription_name`);

  const skillIdRaw = entry.skill_id;
  const skillId =
    typeof skillIdRaw === "string" && skillIdRaw.trim() !== ""
      ? skillIdRaw
      : packageToSkillId(pkg);

  return {
    sensor_id: sensorId,
    pkg,
    skill_id: skillId,
    subscription_name: subscriptionName,
    webhook_url: webhookUrl,
    enabled,
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
