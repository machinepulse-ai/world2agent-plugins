import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { RequiredWorld2AgentPluginConfig, World2AgentPaths } from "./types.js";

export function getWorld2AgentPaths(
  pluginConfig: RequiredWorld2AgentPluginConfig,
  env: NodeJS.ProcessEnv = process.env,
): World2AgentPaths {
  const openclawHome = env.OPENCLAW_HOME ?? join(homedir(), ".openclaw");
  const baseDir = env.W2A_HOME ?? join(homedir(), ".world2agent");

  return {
    baseDir,
    manifestFile: resolvePath(baseDir, pluginConfig.sensorsManifestPath, "sensors.json"),
    stateDir: resolvePath(baseDir, pluginConfig.stateDir, "state"),
    sessionDir: resolvePath(baseDir, pluginConfig.sessionDir, "sessions"),
    openclawHome,
    openclawSkillsDir: join(openclawHome, "skills"),
    ingestHmacSecretFile: resolvePath(
      baseDir,
      pluginConfig.ingestHmacSecretFile,
      ".openclaw-ingest-secret",
    ),
  };
}

export async function ensureWorld2AgentDirs(
  paths: World2AgentPaths,
): Promise<void> {
  await mkdir(paths.baseDir, { recursive: true });
  await mkdir(paths.stateDir, { recursive: true });
  await mkdir(paths.sessionDir, { recursive: true });
  await mkdir(paths.openclawSkillsDir, { recursive: true });
}

// OpenClaw's plugin loader does NOT await async register(); we must do
// pre-register filesystem work synchronously.
export function ensureWorld2AgentDirsSync(paths: World2AgentPaths): void {
  mkdirSync(paths.baseDir, { recursive: true });
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.sessionDir, { recursive: true });
  mkdirSync(paths.openclawSkillsDir, { recursive: true });
}

export function loadOrCreateHmacSecretSync(path: string): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  }
  mkdirSync(dirname(path), { recursive: true });
  const next = randomBytes(32).toString("hex");
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${next}\n`);
  renameSync(tmp, path);
  return next;
}

export async function readTrimmedText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim() || null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeTextAtomic(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

function resolvePath(baseDir: string, override: string | undefined, fallback: string): string {
  return override ? resolve(override) : join(baseDir, fallback);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

