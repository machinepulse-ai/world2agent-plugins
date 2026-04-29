import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HermesSensorConfig {
  sensor_id: string;
  skill_id: string;
  webhook_url: string;
  subscription_name?: string;
}

export interface SharedSensorEntry {
  package: string;
  config?: Record<string, unknown>;
  skills?: string[];
  enabled?: boolean;
  _hermes?: Partial<HermesSensorConfig>;
}

export interface SharedConfig {
  sensors: SharedSensorEntry[];
  name?: string;
  instructions?: string;
}

export interface BridgeSensorEntry {
  package: string;
  config: Record<string, unknown>;
  skills: string[];
  enabled: boolean;
  _hermes: HermesSensorConfig;
}

export interface BridgePaths {
  baseDir: string;
  configFile: string;
  bridgeStateFile: string;
  supervisorPidFile: string;
  supervisorLogFile: string;
  stateDir: string;
  npmDir: string;
}

const DEFAULT_CONFIG: SharedConfig = {
  sensors: [],
};

export function getBridgePaths(env: NodeJS.ProcessEnv = process.env): BridgePaths {
  const userHome = env.HOME ?? homedir();
  const baseDir = join(userHome, ".world2agent");

  return {
    baseDir,
    configFile: join(baseDir, "config.json"),
    bridgeStateFile: join(baseDir, ".bridge-state.json"),
    supervisorPidFile: join(baseDir, "supervisor.pid"),
    supervisorLogFile: join(baseDir, "supervisor.log"),
    stateDir: join(baseDir, "state"),
    npmDir: join(baseDir, "_npm"),
  };
}

export async function ensureBridgeDirs(paths: BridgePaths): Promise<void> {
  await mkdir(paths.baseDir, { recursive: true });
  await mkdir(paths.stateDir, { recursive: true });
  await mkdir(paths.npmDir, { recursive: true });
}

export async function ensureConfigFile(paths: BridgePaths): Promise<void> {
  await ensureBridgeDirs(paths);
  if (await pathExists(paths.configFile)) {
    return;
  }
  await writeConfig(paths, structuredClone(DEFAULT_CONFIG));
}

export async function readConfig(paths: BridgePaths): Promise<SharedConfig> {
  try {
    const raw = await readFile(paths.configFile, "utf8");
    return parseConfig(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isMissingFile(error)) {
      return structuredClone(DEFAULT_CONFIG);
    }
    throw error;
  }
}

export async function writeConfig(paths: BridgePaths, config: SharedConfig): Promise<void> {
  await ensureBridgeDirs(paths);
  const normalized = normalizeConfig(config);
  await writeTextAtomic(paths.configFile, JSON.stringify(normalized, null, 2) + "\n");
}

export function upsertConfigSensor(
  config: SharedConfig,
  entry: SharedSensorEntry,
): SharedConfig {
  const normalizedEntry = normalizeSharedSensorEntry(entry);
  const sensors = config.sensors.filter((item) => item.package !== normalizedEntry.package);
  sensors.push(normalizedEntry);
  sensors.sort((left, right) => left.package.localeCompare(right.package));
  return {
    ...config,
    sensors,
  };
}

export function removeConfigSensor(
  config: SharedConfig,
  packageName: string,
): {
  config: SharedConfig;
  removed: SharedSensorEntry | null;
} {
  const removed = config.sensors.find((entry) => entry.package === packageName) ?? null;
  return {
    config: {
      ...config,
      sensors: config.sensors.filter((entry) => entry.package !== packageName),
    },
    removed,
  };
}

export function listBridgeSensors(config: SharedConfig): BridgeSensorEntry[] {
  const sensors: BridgeSensorEntry[] = [];
  for (const entry of config.sensors) {
    const bridgeEntry = toBridgeSensorEntry(entry);
    if (bridgeEntry) {
      sensors.push(bridgeEntry);
    }
  }
  sensors.sort((left, right) =>
    left._hermes.sensor_id.localeCompare(right._hermes.sensor_id),
  );
  return sensors;
}

export function normalizeSharedSensorEntry(entry: SharedSensorEntry): SharedSensorEntry {
  const normalized: SharedSensorEntry = {
    package: expectString(entry.package, "sensor.package"),
    config: normalizeConfigObject(entry.config),
    skills: normalizeSkills(entry.skills),
    enabled: entry.enabled !== false,
  };

  const hermes = normalizeHermesConfig(entry._hermes);
  if (hermes) {
    normalized._hermes = hermes;
  }

  return normalized;
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

export async function readTrimmedText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim() || null;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function writeTextAtomic(
  path: string,
  content: string,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, { encoding: "utf8", mode });
  await rename(tmp, path);
  if (mode !== undefined) {
    await chmod(path, mode);
  }
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

function parseConfig(raw: unknown): SharedConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.json must be a JSON object");
  }

  const value = raw as Record<string, unknown>;
  const sensors = value.sensors;
  if (!Array.isArray(sensors)) {
    throw new Error("config.json field `sensors` must be an array");
  }

  const parsed: SharedConfig = {
    sensors: sensors.map((entry, index) => parseSharedSensorEntry(entry, index)),
  };

  if (typeof value.name === "string" && value.name.trim() !== "") {
    parsed.name = value.name;
  }
  if (typeof value.instructions === "string" && value.instructions.trim() !== "") {
    parsed.instructions = value.instructions;
  }

  return parsed;
}

function parseSharedSensorEntry(raw: unknown, index: number): SharedSensorEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config.json sensors[${index}] must be an object`);
  }

  const value = raw as Record<string, unknown>;
  const entry: SharedSensorEntry = {
    package: expectString(value.package, `sensors[${index}].package`),
    config: normalizeConfigObject(value.config),
    skills: normalizeSkills(value.skills, `sensors[${index}].skills`),
    enabled: value.enabled === undefined ? true : Boolean(value.enabled),
  };

  if (value._hermes !== undefined) {
    if (!value._hermes || typeof value._hermes !== "object" || Array.isArray(value._hermes)) {
      throw new Error(`sensors[${index}]._hermes must be an object when present`);
    }
    entry._hermes = normalizeHermesConfig(value._hermes as Partial<HermesSensorConfig>);
  }

  return entry;
}

function normalizeConfig(config: SharedConfig): SharedConfig {
  return {
    ...(config.name ? { name: config.name } : {}),
    ...(config.instructions ? { instructions: config.instructions } : {}),
    sensors: config.sensors.map(normalizeSharedSensorEntry),
  };
}

function toBridgeSensorEntry(entry: SharedSensorEntry): BridgeSensorEntry | null {
  if (entry.enabled === false) {
    return null;
  }

  const hermes = normalizeHermesConfig(entry._hermes);
  if (!hermes) {
    return null;
  }

  return {
    package: entry.package,
    config: normalizeConfigObject(entry.config),
    skills: normalizeSkills(entry.skills),
    enabled: true,
    _hermes: hermes,
  };
}

function normalizeHermesConfig(
  raw: Partial<HermesSensorConfig> | undefined,
): HermesSensorConfig | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const sensorId = optionalNonEmptyString(raw.sensor_id);
  const skillId = optionalNonEmptyString(raw.skill_id);
  const webhookUrl = optionalNonEmptyString(raw.webhook_url);
  if (!sensorId || !skillId || !webhookUrl) {
    return undefined;
  }

  const normalized: HermesSensorConfig = {
    sensor_id: sensorId,
    skill_id: skillId,
    webhook_url: webhookUrl,
  };

  const subscriptionName = optionalNonEmptyString(raw.subscription_name);
  if (subscriptionName) {
    normalized.subscription_name = subscriptionName;
  }

  return normalized;
}

function normalizeConfigObject(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sensor.config must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function normalizeSkills(
  value: unknown,
  label = "sensor.skills",
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value
    .map((item, index) => expectString(item, `${label}[${index}]`))
    .sort((left, right) => left.localeCompare(right));
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
