import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { appendFile, mkdir, readFile, rm, symlink, writeFile, } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBridgePaths, pathExists, readPidFile, readTrimmedText, } from "../supervisor/manifest.js";
export function parseArgs(argv) {
    const positionals = [];
    const flags = new Map();
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (!arg.startsWith("--")) {
            positionals.push(arg);
            continue;
        }
        const [name, inlineValue] = arg.slice(2).split("=", 2);
        if (inlineValue !== undefined) {
            flags.set(name, inlineValue);
            continue;
        }
        const next = argv[index + 1];
        if (next && !next.startsWith("--")) {
            flags.set(name, next);
            index += 1;
            continue;
        }
        flags.set(name, true);
    }
    return { _: positionals, flags };
}
export function getStringFlag(args, name) {
    const value = args.flags.get(name);
    return typeof value === "string" ? value : undefined;
}
export function hasFlag(args, name) {
    return args.flags.get(name) === true;
}
export function getPort(args) {
    const raw = getStringFlag(args, "port");
    if (!raw)
        return 8645;
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid --port value: ${raw}`);
    }
    return port;
}
export function printJson(value) {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
export function bridgePackageRoot() {
    return fileURLToPath(new URL("../../", import.meta.url));
}
export function resolveSupervisorBin() {
    return fileURLToPath(new URL("../supervisor/bin.js", import.meta.url));
}
export async function resolveInstalledPackage(pkg) {
    const require = createRequire(import.meta.url);
    try {
        const entryPath = require.resolve(pkg, {
            paths: [bridgePackageRoot()],
        });
        const packageJsonPath = await findNearestPackageJson(dirname(entryPath));
        const raw = JSON.parse(await readFile(packageJsonPath, "utf8"));
        return {
            packageJsonPath,
            packageRoot: dirname(packageJsonPath),
            packageJson: raw,
        };
    }
    catch {
        return null;
    }
}
export async function ensurePackageInstalled(pkg) {
    const existing = await resolveInstalledPackage(pkg);
    if (existing)
        return existing;
    const localRepo = await findLocalSensorRepo(pkg);
    if (localRepo) {
        await linkLocalPackage(pkg, localRepo);
        const linked = await resolveInstalledPackage(pkg);
        if (linked)
            return linked;
    }
    await runCommand("npm", ["install", "--no-save", pkg], {
        cwd: bridgePackageRoot(),
    });
    const installed = await resolveInstalledPackage(pkg);
    if (!installed) {
        throw new Error(`Failed to resolve installed package ${pkg}`);
    }
    return installed;
}
export async function callControl(pathname, options = {}) {
    const paths = options.paths ?? getBridgePaths();
    const token = await readTrimmedText(paths.controlTokenFile);
    if (!token) {
        throw new Error("Control token not found");
    }
    return fetch(`http://127.0.0.1:${options.port ?? 8645}${pathname}`, {
        method: options.method ?? "GET",
        headers: {
            "X-W2A-Token": token,
        },
        signal: AbortSignal.timeout(2_000),
    });
}
export async function readRuntimeState(port, paths) {
    try {
        const [healthRes, listRes] = await Promise.all([
            callControl("/_w2a/health", { port, paths }),
            callControl("/_w2a/list", { port, paths }),
        ]);
        if (!healthRes.ok || !listRes.ok)
            return null;
        return {
            health: await healthRes.json(),
            list: await listRes.json(),
        };
    }
    catch {
        return null;
    }
}
export async function maybeReloadSupervisor(port, paths) {
    try {
        const response = await callControl("/_w2a/reload", {
            method: "POST",
            port,
            paths,
        });
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(typeof payload?.error === "string"
                ? payload.error
                : `Reload failed with HTTP ${response.status}`);
        }
        return payload;
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
export async function isSupervisorRunning(paths) {
    const pid = await readPidFile(paths);
    if (!pid)
        return { pid: null, running: false };
    try {
        process.kill(pid, 0);
        return { pid, running: true };
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EPERM") {
            return { pid, running: true };
        }
        return { pid, running: false };
    }
}
export async function waitForProcessExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
        }
        catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EPERM")) {
                return true;
            }
        }
        await delay(100);
    }
    return false;
}
export async function runCommand(command, args, options = {}) {
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
            reject(new Error(`${command} ${args.join(" ")} failed with code ${code}: ${stderr.trim() || stdout.trim()}`));
        });
    });
}
export async function removePath(path) {
    await rm(path, { force: true, recursive: true });
}
async function findLocalSensorRepo(pkg) {
    if (!pkg.startsWith("@world2agent/sensor-"))
        return null;
    const slug = pkg.split("/").pop()?.replace(/^sensor-/, "");
    if (!slug)
        return null;
    const candidate = resolve(bridgePackageRoot(), "..", "..", "world2agent-sensors", slug);
    return (await pathExists(join(candidate, "package.json"))) ? candidate : null;
}
async function linkLocalPackage(pkg, sourceDir) {
    const scope = pkg.split("/")[0];
    const name = pkg.split("/")[1];
    if (!scope || !name) {
        throw new Error(`Invalid package name: ${pkg}`);
    }
    const target = join(bridgePackageRoot(), "node_modules", scope, name);
    await mkdir(dirname(target), { recursive: true });
    await removePath(target);
    await symlink(sourceDir, target, "dir");
}
async function findNearestPackageJson(startDir) {
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
function delay(ms) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
const MANAGED_BLOCK_BEGIN = "# >>> world2agent-hermes-bridge (managed) >>>";
const MANAGED_BLOCK_END = "# <<< world2agent-hermes-bridge (managed) <<<";
/**
 * Make sure Hermes's webhook platform is enabled and a top-level
 * `platforms.webhook.*` config exists.
 *
 * Hermes's CLI (e.g. `hermes webhook subscribe`) reads `~/.hermes/config.yaml`
 * to decide whether the webhook platform is configured; the gateway runtime
 * additionally honours `WEBHOOK_*` env vars. We write both, fenced by marker
 * comments so the change is idempotent and easy to revert by hand.
 */
export async function ensureHermesWebhookEnabled(paths = getBridgePaths(), opts = {}) {
    const port = opts.port ?? 8644;
    const yamlAlreadyEnabled = await detectWebhookEnabledInConfigYaml(paths.hermesConfigYamlFile);
    const secret = opts.secret ?? randomBytes(32).toString("hex");
    // YAML is the canonical source for the CLI: only patch it if not already
    // declared. We never touch a hand-managed top-level `platforms:` block —
    // ensureManagedBlockInConfigYaml throws in that case.
    const configYamlModified = yamlAlreadyEnabled
        ? false
        : await ensureManagedBlockInConfigYaml(paths.hermesConfigYamlFile, port, secret);
    // Env is patched independently so we self-heal partial state (e.g. someone
    // hand-enabled webhook in config.yaml but the gateway runtime still expects
    // WEBHOOK_*). The block is marker-fenced and idempotent.
    const envModified = await ensureManagedBlockInEnv(paths.hermesEnvFile, port, secret);
    const alreadyEnabled = yamlAlreadyEnabled;
    const detectedVia = alreadyEnabled
        ? "config-yaml"
        : !configYamlModified && !envModified
            ? "managed-block"
            : null;
    const gatewayRestartRequired = (configYamlModified || envModified) && (await isHermesGatewayRunning());
    return {
        alreadyEnabled,
        detectedVia,
        configYamlModified,
        envModified,
        configYamlFile: paths.hermesConfigYamlFile,
        hermesEnvFile: paths.hermesEnvFile,
        webhookPort: port,
        gatewayRestartRequired,
        secretWritten: configYamlModified || envModified,
    };
}
async function ensureManagedBlockInConfigYaml(configFile, port, secret) {
    let current = "";
    try {
        current = await readFile(configFile, "utf8");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    if (current.includes(MANAGED_BLOCK_BEGIN))
        return false;
    if (hasUnmanagedTopLevelPlatforms(current)) {
        throw new Error(`~/.hermes/config.yaml already declares a top-level 'platforms:' block. ` +
            `Add 'webhook: { enabled: true, extra: { host: "127.0.0.1", port: ${port}, secret: "<your-secret>" } }' under it manually, ` +
            `or run 'hermes gateway setup' to use the wizard. ` +
            `world2agent-hermes will not modify a hand-managed platforms section.`);
    }
    const block = [
        MANAGED_BLOCK_BEGIN,
        "# Enables Hermes's webhook platform so world2agent-hermes can subscribe routes.",
        "platforms:",
        "  webhook:",
        "    enabled: true",
        "    extra:",
        '      host: "127.0.0.1"',
        `      port: ${port}`,
        `      secret: "${secret}"`,
        MANAGED_BLOCK_END,
        "",
    ].join("\n");
    await mkdir(dirname(configFile), { recursive: true });
    if (current.length === 0) {
        await writeFile(configFile, block, "utf8");
    }
    else {
        const prefix = current.endsWith("\n") ? "\n" : "\n\n";
        await appendFile(configFile, prefix + block, "utf8");
    }
    return true;
}
async function ensureManagedBlockInEnv(envFile, port, secret) {
    let current = "";
    try {
        current = await readFile(envFile, "utf8");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    if (current.includes(MANAGED_BLOCK_BEGIN))
        return false;
    const block = [
        MANAGED_BLOCK_BEGIN,
        "# Enables Hermes's webhook platform at the gateway runtime layer.",
        "WEBHOOK_ENABLED=true",
        `WEBHOOK_PORT=${port}`,
        `WEBHOOK_SECRET=${secret}`,
        MANAGED_BLOCK_END,
        "",
    ].join("\n");
    await mkdir(dirname(envFile), { recursive: true });
    if (current.length === 0) {
        await writeFile(envFile, block, "utf8");
    }
    else {
        const prefix = current.endsWith("\n") ? "\n" : "\n\n";
        await appendFile(envFile, prefix + block, "utf8");
    }
    return true;
}
/**
 * Returns true when a top-level `platforms:` key exists in the YAML and is NOT
 * managed by us (so we should not touch it). A literal empty mapping
 * (`platforms: {}`) is treated as unmanaged too — refuse to mutate it.
 */
function hasUnmanagedTopLevelPlatforms(yamlText) {
    if (!yamlText)
        return false;
    const lines = yamlText.split(/\r?\n/);
    let insideManaged = false;
    for (const rawLine of lines) {
        if (rawLine.includes(MANAGED_BLOCK_BEGIN)) {
            insideManaged = true;
            continue;
        }
        if (rawLine.includes(MANAGED_BLOCK_END)) {
            insideManaged = false;
            continue;
        }
        if (insideManaged)
            continue;
        if (/^platforms\s*:/.test(rawLine))
            return true;
    }
    return false;
}
async function detectWebhookEnabledInConfigYaml(configFile) {
    let text;
    try {
        text = await readFile(configFile, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
    const lines = text.split(/\r?\n/);
    let topLevelPlatformsIndent = -1;
    let webhookIndent = -1;
    let inWebhookBlock = false;
    for (const rawLine of lines) {
        const line = rawLine.replace(/\t/g, "  ");
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const indent = line.length - line.trimStart().length;
        if (topLevelPlatformsIndent === -1) {
            if (indent === 0 && /^platforms\s*:/.test(trimmed)) {
                topLevelPlatformsIndent = 0;
            }
            continue;
        }
        if (indent <= topLevelPlatformsIndent && !/^platforms\s*:/.test(trimmed)) {
            // exited the platforms block before finding webhook.enabled
            topLevelPlatformsIndent = -1;
            inWebhookBlock = false;
            continue;
        }
        if (!inWebhookBlock) {
            const match = /^webhook\s*:\s*$/.exec(trimmed);
            if (match) {
                inWebhookBlock = true;
                webhookIndent = indent;
            }
            continue;
        }
        if (indent <= webhookIndent) {
            inWebhookBlock = false;
            continue;
        }
        const enabledMatch = /^enabled\s*:\s*(\S+)/.exec(trimmed);
        if (enabledMatch) {
            const value = enabledMatch[1].replace(/[",]/g, "").toLowerCase();
            return value === "true" || value === "yes" || value === "1";
        }
    }
    return false;
}
async function isHermesGatewayRunning() {
    return new Promise((resolvePromise) => {
        const child = spawn("pgrep", ["-fl", "hermes gateway run"], {
            stdio: ["ignore", "ignore", "ignore"],
        });
        child.on("error", () => resolvePromise(false));
        child.on("close", (code) => resolvePromise(code === 0));
    });
}
