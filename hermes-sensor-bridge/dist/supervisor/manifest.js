import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { packageToSkillId } from "@world2agent/sdk";
const DEFAULT_MANIFEST = {
    version: 1,
    sensors: [],
};
export function getBridgePaths(env = process.env) {
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
export async function ensureBridgeDirs(paths) {
    await mkdir(paths.baseDir, { recursive: true });
    await mkdir(paths.stateDir, { recursive: true });
    await mkdir(paths.hermesSkillsDir, { recursive: true });
}
export async function readManifest(paths) {
    try {
        const raw = await readFile(paths.manifestFile, "utf8");
        return parseManifest(JSON.parse(raw));
    }
    catch (error) {
        if (isMissingFile(error)) {
            return structuredClone(DEFAULT_MANIFEST);
        }
        throw error;
    }
}
export async function writeManifest(paths, manifest) {
    await ensureBridgeDirs(paths);
    const normalized = {
        version: 1,
        sensors: manifest.sensors.map(normalizeSensorEntry),
    };
    await writeTextAtomic(paths.manifestFile, JSON.stringify(normalized, null, 2) + "\n");
}
export function upsertSensorEntry(manifest, entry) {
    const normalized = normalizeSensorEntry(entry);
    const sensors = manifest.sensors.filter((item) => item.sensor_id !== normalized.sensor_id);
    sensors.push(normalized);
    sensors.sort((a, b) => a.sensor_id.localeCompare(b.sensor_id));
    return {
        version: 1,
        sensors,
    };
}
export function removeSensorEntry(manifest, sensorId) {
    const removed = manifest.sensors.find((entry) => entry.sensor_id === sensorId) ?? null;
    return {
        manifest: {
            version: 1,
            sensors: manifest.sensors.filter((entry) => entry.sensor_id !== sensorId),
        },
        removed,
    };
}
export function normalizeSensorEntry(entry) {
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
export function defaultSensorId(pkg) {
    const suffix = pkg.split("/").pop() ?? pkg;
    return suffix.replace(/^sensor-/, "");
}
export function stableStringify(value) {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }
    const obj = value;
    return `{${Object.keys(obj)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
        .join(",")}}`;
}
export function hashConfig(config) {
    return createHash("sha1").update(stableStringify(config)).digest("hex");
}
export async function loadOrCreateHmacSecret(paths, override) {
    if (override) {
        await writeTextAtomic(paths.hmacSecretFile, `${override}\n`);
        return override;
    }
    const existing = await readTrimmedText(paths.hmacSecretFile);
    if (existing)
        return existing;
    const secret = randomBytes(32).toString("hex");
    await writeTextAtomic(paths.hmacSecretFile, `${secret}\n`);
    return secret;
}
export async function loadOrCreateControlToken(paths) {
    const existing = await readTrimmedText(paths.controlTokenFile);
    if (existing)
        return existing;
    const token = randomBytes(32).toString("hex");
    await writeTextAtomic(paths.controlTokenFile, `${token}\n`);
    return token;
}
export async function readTrimmedText(path) {
    try {
        return (await readFile(path, "utf8")).trim() || null;
    }
    catch (error) {
        if (isMissingFile(error))
            return null;
        throw error;
    }
}
export async function writeTextAtomic(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
}
export async function writePidFile(paths, pid) {
    await writeTextAtomic(paths.supervisorPidFile, `${pid}\n`);
}
export async function readPidFile(paths) {
    const raw = await readTrimmedText(paths.supervisorPidFile);
    if (!raw)
        return null;
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}
export async function removePidFile(paths) {
    await rm(paths.supervisorPidFile, { force: true });
}
export async function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        if (isNodeError(error) && error.code === "EPERM")
            return true;
        return false;
    }
}
export async function pathExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
function parseManifest(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Manifest must be a JSON object");
    }
    const version = raw.version;
    const sensors = raw.sensors;
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
function parseSensorEntry(raw, index) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`Manifest sensor[${index}] must be an object`);
    }
    const entry = raw;
    const sensorId = expectString(entry.sensor_id, `sensor[${index}].sensor_id`);
    const pkg = expectString(entry.pkg, `sensor[${index}].pkg`);
    const webhookUrl = expectString(entry.webhook_url, `sensor[${index}].webhook_url`);
    const enabled = entry.enabled === undefined ? true : Boolean(entry.enabled);
    const config = entry.config;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error(`sensor[${index}].config must be an object`);
    }
    const subscriptionName = entry.subscription_name === undefined
        ? undefined
        : expectString(entry.subscription_name, `sensor[${index}].subscription_name`);
    const skillIdRaw = entry.skill_id;
    const skillId = typeof skillIdRaw === "string" && skillIdRaw.trim() !== ""
        ? skillIdRaw
        : packageToSkillId(pkg);
    return {
        sensor_id: sensorId,
        pkg,
        skill_id: skillId,
        subscription_name: subscriptionName,
        webhook_url: webhookUrl,
        enabled,
        config: config,
    };
}
function expectString(value, label) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${label} must be a non-empty string`);
    }
    return value;
}
function isMissingFile(error) {
    return isNodeError(error) && error.code === "ENOENT";
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
