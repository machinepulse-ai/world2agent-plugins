import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageToSkillId } from "@world2agent/sdk";
import { pathExists, removePath } from "./manifest.js";
import type { World2AgentPaths } from "./types.js";

export interface InstalledPackageInfo {
  packageJsonPath: string;
  packageRoot: string;
  packageJson: Record<string, unknown>;
}

export function pluginPackageRoot(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

export async function resolveInstalledPackage(
  pkg: string,
): Promise<InstalledPackageInfo | null> {
  const require = createRequire(import.meta.url);
  try {
    const entryPath = require.resolve(pkg, {
      paths: [pluginPackageRoot()],
    });
    const packageJsonPath = await findNearestPackageJson(dirname(entryPath));
    const raw = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
    return {
      packageJsonPath,
      packageRoot: dirname(packageJsonPath),
      packageJson: raw,
    };
  } catch {
    return null;
  }
}

export async function ensurePackageInstalled(
  pkg: string,
): Promise<InstalledPackageInfo> {
  const existing = await resolveInstalledPackage(pkg);
  if (existing) return existing;

  const localRepo = await findLocalSensorRepo(pkg);
  if (localRepo) {
    await linkLocalPackage(pkg, localRepo);
    const linked = await resolveInstalledPackage(pkg);
    if (linked) return linked;
  }

  await runCommand("npm", ["install", "--no-save", pkg], {
    cwd: pluginPackageRoot(),
  });
  const installed = await resolveInstalledPackage(pkg);
  if (!installed) {
    throw new Error(`Failed to resolve installed package ${pkg}`);
  }
  return installed;
}

export async function maybeUninstallPackage(
  pkg: string,
): Promise<void> {
  try {
    await runCommand("npm", ["uninstall", "--no-save", pkg], {
      cwd: pluginPackageRoot(),
    });
  } catch {
    // best effort
  }
}

export async function writeGeneratedSkill(
  paths: World2AgentPaths,
  pkg: string,
  installed: InstalledPackageInfo,
): Promise<{ skillId: string; written: boolean }> {
  const skillId = packageToSkillId(pkg);
  const skillDir = join(paths.openclawSkillsDir, skillId);
  const skillFile = join(skillDir, "SKILL.md");

  // Never clobber a SKILL.md the user (or the world2agent-manage skill running
  // the SETUP.md Q&A flow) already wrote — that personalized version is
  // strictly better than a generic fallback. The CLI also accepts
  // --skip-generate-skill for the same purpose; this is the safety net.
  if (await pathExists(skillFile)) {
    return { skillId, written: false };
  }

  const sourceType = String(
    (installed.packageJson.w2a as Record<string, unknown> | undefined)?.source_type ?? pkg,
  );
  const signals = (
    (installed.packageJson.w2a as Record<string, unknown> | undefined)?.signals as
      | string[]
      | undefined
  )?.join(", ");

  await mkdir(skillDir, { recursive: true });
  const skillMd = [
    "---",
    `name: ${skillId}`,
    `description: Handle World2Agent signals from ${pkg}.`,
    "user-invocable: false",
    "---",
    "",
    `# ${skillId}`,
    "",
    `Handle W2A signals from \`${pkg}\` (source type: \`${sourceType}\`).`,
    "",
    "## Inputs",
    "- The prompt body contains markdown context plus a fenced JSON copy of the full `signal` object.",
    signals ? `- Common signal types: ${signals}` : "- Inspect `signal.event.type` for the exact event kind.",
    "",
    "## Behavior",
    "- Parse the JSON when you need structured fields.",
    "- Default: reply with one short line — the key fact and why it might matter.",
    "- The user has not personalized this handler yet, so do NOT silently skip on subjective relevance grounds. Reply briefly even if the signal seems mundane.",
    "- The user can replace this file at `~/.openclaw/skills/" + skillId + "/SKILL.md` to add filtering rules (e.g. topics they care about), depth preferences, or output format.",
    "",
    "## Notes",
    "- This skill is the auto-generated fallback. The richer path is to let `world2agent-manage` walk the user through the sensor's `SETUP.md` Q&A — that produces a personalized SKILL.md in this exact location.",
    "",
  ].join("\n");
  await writeFile(skillFile, skillMd, "utf8");
  return { skillId, written: true };
}

export async function loadConfigFile(
  configFile: string | undefined,
  configJson: string | undefined,
  installed: InstalledPackageInfo,
): Promise<Record<string, unknown>> {
  // Inline --config-json takes precedence over --config-file. Lets users
  // provide config without managing a temp file:
  //   sensor add @pkg --config-json '{"top_n":10,"min_score":50}'
  if (configJson !== undefined && configJson !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configJson);
    } catch (error) {
      throw new Error(
        `--config-json is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`--config-json must parse as a JSON object`);
    }
    return parsed as Record<string, unknown>;
  }

  if (!configFile) {
    const setupPath = String(
      (installed.packageJson.w2a as Record<string, unknown> | undefined)?.setup ?? "SETUP.md",
    );
    throw new Error(
      `Provide either --config-json '<json>' inline or --config-file <path>. ` +
        `Sensor guidance: ${join(installed.packageRoot, setupPath)}`,
    );
  }

  const raw = JSON.parse(await readFile(configFile, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Config file must contain a JSON object: ${configFile}`);
  }
  return raw as Record<string, unknown>;
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with code ${code}: ${
            stderr.trim() || stdout.trim()
          }`,
        ),
      );
    });
  });
}

async function findLocalSensorRepo(pkg: string): Promise<string | null> {
  if (!pkg.startsWith("@world2agent/sensor-")) return null;

  const slug = pkg.split("/").pop()?.replace(/^sensor-/, "");
  if (!slug) return null;

  const candidate = resolve(pluginPackageRoot(), "..", "..", "world2agent-sensors", slug);
  return (await pathExists(join(candidate, "package.json"))) ? candidate : null;
}

async function linkLocalPackage(pkg: string, sourceDir: string): Promise<void> {
  const scope = pkg.split("/")[0];
  const name = pkg.split("/")[1];
  if (!scope || !name) {
    throw new Error(`Invalid package name: ${pkg}`);
  }

  const target = join(pluginPackageRoot(), "node_modules", scope, name);
  await mkdir(dirname(target), { recursive: true });
  await removePath(target);
  await symlink(sourceDir, target, "dir");
}

async function findNearestPackageJson(startDir: string): Promise<string> {
  let current = startDir;
  for (;;) {
    const candidate = join(current, "package.json");
    if (await pathExists(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Could not find package.json above ${startDir}`);
    }
    current = parent;
  }
}

