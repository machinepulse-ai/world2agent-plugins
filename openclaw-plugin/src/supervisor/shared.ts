import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SensorEntry } from "../types.js";

/**
 * Copied in minimal form from hermes-sensor-bridge:
 * - src/supervisor/manifest.ts
 * - src/supervisor/spawn.ts
 * - src/runner/config-stream.ts
 * - src/runner/bin.ts
 */

export interface IsolatedProcessMeta {
  sensorId: string;
  pkg: string;
  skillId: string;
  webhookUrl: string;
  configHash: string;
}

export interface IsolatedRunnerEnvInput {
  pkg: string;
  sensorId: string;
  skillId: string;
  ingestUrl: string;
  hmacSecret: string;
  statePath: string;
  logLevel?: string;
}

export function buildIsolatedRunnerEnv(
  input: IsolatedRunnerEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  return {
    ...env,
    W2A_PACKAGE: input.pkg,
    W2A_INGEST_URL: input.ingestUrl,
    W2A_HMAC_SECRET: input.hmacSecret,
    W2A_SENSOR_ID: input.sensorId,
    W2A_SKILL_ID: input.skillId,
    W2A_STATE_PATH: input.statePath,
    W2A_LOG_LEVEL: input.logLevel ?? process.env.W2A_LOG_LEVEL ?? "info",
  };
}

export function shouldRestartIsolatedHandle(
  handle: IsolatedProcessMeta,
  entry: SensorEntry,
  ingestUrl: string,
): boolean {
  return !(
    handle.pkg === entry.pkg &&
    handle.skillId === entry.skill_id &&
    handle.webhookUrl === ingestUrl &&
    handle.configHash === hashConfig(entry.config)
  );
}

export async function readJsonFromStdin(
  stdin: AsyncIterable<string | Buffer> = process.stdin,
): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of stdin) {
    raw += chunk.toString();
  }

  const text = raw.trim();
  if (!text) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid sensor config JSON on stdin: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Sensor config JSON must be an object");
  }

  return parsed as Record<string, unknown>;
}

export function resolveImportTarget(pkg: string): string {
  if (pkg.startsWith(".") || pkg.startsWith("/") || isAbsolute(pkg)) {
    return pathToFileURL(resolve(pkg)).href;
  }
  return pkg;
}

export function hashConfig(config: unknown): string {
  return createHash("sha1").update(stableStringify(config)).digest("hex");
}

function stableStringify(value: unknown): string {
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
