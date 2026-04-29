import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface NotifyTarget {
  channel: string;
  to: string;
  account?: string;
}

export interface OpenClawBridgeSensorConfig {
  sensor_id: string;
  skill_id: string;
  // OpenClaw agent that owns the lane. Defaults to "main" when omitted.
  agent_id?: string;
  // sessionKey passed to /hooks/agent. Must match one of the gateway's
  // `hooks.allowedSessionKeyPrefixes`. Defaults to `w2a:<sensor_id>`.
  session_key?: string;
  // When set, the bridge POSTs `deliver:true` with these fields so the
  // agent reply is routed to a real channel (Telegram/Slack/Feishu/etc.).
  notify?: NotifyTarget;
  // Optional model override forwarded to /hooks/agent.
  model?: string;
}

export interface SharedSensorEntry {
  package: string;
  config?: Record<string, unknown>;
  skills?: string[];
  enabled?: boolean;
  _openclaw_bridge?: Partial<OpenClawBridgeSensorConfig>;
  // Other runtimes' namespace blocks (_hermes, _claude_code, _openclaw, …)
  // are preserved verbatim by this bridge — see CLAUDE.md / manifest schema.
  [namespacedKey: `_${string}`]: unknown;
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
  _openclaw_bridge: OpenClawBridgeSensorConfig;
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

  // Shared files (`config.json`, `state/`, `_npm/`) are intentionally
  // co-owned with sibling bridges (hermes-sensor-bridge, future ones) so
  // sensor manifest, per-sensor cursors, and installed sensor packages
  // are interoperable.
  //
  // Per-bridge files (`.openclaw-bridge-state.json`, `openclaw-supervisor.{pid,log}`)
  // are namespaced so two bridges on the same host don't fight over PID
  // files, log streams, or HMAC/control tokens.
  return {
    baseDir,
    configFile: join(baseDir, "config.json"),
    bridgeStateFile: join(baseDir, ".openclaw-bridge-state.json"),
    supervisorPidFile: join(baseDir, "openclaw-supervisor.pid"),
    supervisorLogFile: join(baseDir, "openclaw-supervisor.log"),
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
    left._openclaw_bridge.sensor_id.localeCompare(right._openclaw_bridge.sensor_id),
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

  // Preserve every `_<runtime>` namespace block verbatim so foreign payloads
  // (`_hermes`, `_claude_code`, `_openclaw`, …) survive round-trips.
  for (const [key, value] of Object.entries(entry)) {
    if (key.startsWith("_")) {
      (normalized as unknown as Record<string, unknown>)[key] = value;
    }
  }

  const ourBlock = normalizeOpenClawBridgeConfig(entry._openclaw_bridge);
  if (ourBlock) {
    normalized._openclaw_bridge = ourBlock;
  } else {
    delete normalized._openclaw_bridge;
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

  // Pass through every `_<runtime>` block verbatim. We only validate ours.
  for (const [key, val] of Object.entries(value)) {
    if (!key.startsWith("_")) continue;
    (entry as unknown as Record<string, unknown>)[key] = val;
  }

  if (value._openclaw_bridge !== undefined) {
    if (
      !value._openclaw_bridge ||
      typeof value._openclaw_bridge !== "object" ||
      Array.isArray(value._openclaw_bridge)
    ) {
      throw new Error(`sensors[${index}]._openclaw_bridge must be an object when present`);
    }
    const normalized = normalizeOpenClawBridgeConfig(
      value._openclaw_bridge as Partial<OpenClawBridgeSensorConfig>,
    );
    if (normalized) {
      entry._openclaw_bridge = normalized;
    } else {
      delete entry._openclaw_bridge;
    }
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

  const ourBlock = normalizeOpenClawBridgeConfig(entry._openclaw_bridge);
  if (!ourBlock) {
    return null;
  }

  return {
    package: entry.package,
    config: normalizeConfigObject(entry.config),
    skills: normalizeSkills(entry.skills),
    enabled: true,
    _openclaw_bridge: ourBlock,
  };
}

function normalizeOpenClawBridgeConfig(
  raw: Partial<OpenClawBridgeSensorConfig> | undefined,
): OpenClawBridgeSensorConfig | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const sensorId = optionalNonEmptyString(raw.sensor_id);
  const skillId = optionalNonEmptyString(raw.skill_id);
  if (!sensorId || !skillId) {
    return undefined;
  }

  const normalized: OpenClawBridgeSensorConfig = {
    sensor_id: sensorId,
    skill_id: skillId,
  };

  const agentId = optionalNonEmptyString(raw.agent_id);
  if (agentId) normalized.agent_id = agentId;

  const sessionKey = optionalNonEmptyString(raw.session_key);
  if (sessionKey) normalized.session_key = sessionKey;

  const model = optionalNonEmptyString(raw.model);
  if (model) normalized.model = model;

  const notify = normalizeNotify(raw.notify);
  if (notify) normalized.notify = notify;

  return normalized;
}

function normalizeNotify(raw: unknown): NotifyTarget | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const channel = optionalNonEmptyString(obj.channel);
  const to = optionalNonEmptyString(obj.to);
  if (!channel || !to) return undefined;
  const normalized: NotifyTarget = { channel, to };
  const account = optionalNonEmptyString(obj.account);
  if (account) normalized.account = account;
  return normalized;
}

/**
 * Resolved sessionKey for a sensor: either the explicit `session_key` from
 * the manifest entry, or `<defaultPrefix><sensor_id>`. The supervisor uses
 * this when POSTing to /hooks/agent. The gateway will reject the request
 * if the resolved key doesn't match `hooks.allowedSessionKeyPrefixes`.
 */
export function resolveSessionKey(
  entry: BridgeSensorEntry,
  defaultPrefix: string,
): string {
  return entry._openclaw_bridge.session_key ?? `${defaultPrefix}${entry._openclaw_bridge.sensor_id}`;
}

export function resolveAgentId(entry: BridgeSensorEntry, defaultAgentId: string): string {
  return entry._openclaw_bridge.agent_id ?? defaultAgentId;
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
