#!/usr/bin/env node
import { FileSensorStore, startSensor } from "@world2agent/sdk";
import { stdoutTransport } from "@world2agent/sdk/transports";
import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { readJsonFromStdin } from "./config-stream.js";
const EXIT_CONFIG_ERROR = 10;
const EXIT_IMPORT_ERROR = 11;
const EXIT_START_ERROR = 12;
/**
 * Sensor subprocess. The runner is intentionally channel-agnostic:
 *
 *   - signals → one JSON line per signal on **stdout** (via SDK stdoutTransport)
 *   - diagnostics / sensor logs → **stderr** (via stderrLogger below)
 *
 * The supervisor parent reads stdout line-by-line as W2A signals and POSTs
 * them to Hermes; stderr is appended to supervisor.log with a `[w2a/<id>]`
 * prefix. Mixing log text into stdout would break the parser, so every log
 * path here goes through stderrLogger — even `console.log` / `console.info`
 * are NOT used in this file.
 */
const stderrLogger = {
    log: (...args) => console.error(...args),
    info: (...args) => console.error(...args),
    warn: (...args) => console.error(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.error(...args),
};
async function main() {
    const env = requireEnv(["W2A_PACKAGE", "W2A_SENSOR_ID", "W2A_STATE_PATH"]);
    let config;
    try {
        config = await readJsonFromStdin();
    }
    catch (error) {
        console.error(error);
        process.exit(EXIT_CONFIG_ERROR);
    }
    let spec;
    try {
        spec = await loadSensorSpec(env.W2A_PACKAGE);
    }
    catch (error) {
        console.error(error);
        process.exit(EXIT_IMPORT_ERROR);
    }
    const store = new FileSensorStore({ path: env.W2A_STATE_PATH });
    let cleanup;
    try {
        cleanup = await startSensor(spec, {
            config,
            onSignal: stdoutTransport(),
            store,
            logger: stderrLogger,
            logEmits: true,
        });
    }
    catch (error) {
        console.error(error);
        await store.flush().catch(() => { });
        process.exit(EXIT_START_ERROR);
    }
    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        try {
            await cleanup?.();
            await store.flush();
        }
        catch (error) {
            console.error(error);
            process.exit(1);
        }
        process.exit(0);
    };
    process.on("SIGTERM", () => {
        void shutdown();
    });
    process.on("SIGINT", () => {
        void shutdown();
    });
    const watchdog = setInterval(() => {
        if (process.ppid === 1) {
            console.error("[w2a-runner] parent died; shutting down");
            void shutdown();
        }
    }, 5_000);
    watchdog.unref();
    await new Promise(() => { });
}
async function loadSensorSpec(pkg) {
    const module = await import(resolveImportTarget(pkg));
    const spec = module.default;
    if (!spec || typeof spec.start !== "function") {
        throw new Error(`${pkg} does not export a valid default SensorSpec`);
    }
    return spec;
}
function resolveImportTarget(pkg) {
    if (pkg.startsWith(".") || pkg.startsWith("/") || isAbsolute(pkg)) {
        return pathToFileURL(resolve(pkg)).href;
    }
    return pkg;
}
function requireEnv(keys) {
    const values = {};
    for (const key of keys) {
        const value = process.env[key];
        if (!value) {
            throw new Error(`Missing required env var: ${key}`);
        }
        values[key] = value;
    }
    return values;
}
main().catch((error) => {
    console.error(error);
    process.exit(99);
});
