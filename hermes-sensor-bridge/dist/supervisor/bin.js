#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { ensureBridgeDirs, getBridgePaths, isProcessAlive, loadOrCreateControlToken, loadOrCreateHmacSecret, readManifest, readPidFile, removePidFile, writePidFile, } from "./manifest.js";
import { SensorSupervisor } from "./spawn.js";
import { startControlServer } from "./control-server.js";
import { startGatewayWatch } from "./gateway-watch.js";
async function main() {
    const port = parsePort(process.argv.slice(2));
    const paths = getBridgePaths();
    await ensureBridgeDirs(paths);
    const existingPid = await readPidFile(paths);
    if (existingPid && existingPid !== process.pid && (await isProcessAlive(existingPid))) {
        throw new Error(`Supervisor already running with pid ${existingPid}`);
    }
    const logStream = createWriteStream(paths.supervisorLogFile, { flags: "a" });
    const log = createLogger(logStream);
    try {
        await writePidFile(paths, process.pid);
        const hmacSecret = await loadOrCreateHmacSecret(paths);
        const controlToken = await loadOrCreateControlToken(paths);
        const supervisor = new SensorSupervisor({ paths, hmacSecret, log });
        const startedAt = Date.now();
        const manifest = await readManifest(paths);
        const controlServer = await startControlServer({
            paths,
            supervisor,
            token: controlToken,
            port,
            startedAt,
            log,
        });
        let shuttingDown = false;
        const shutdown = async (reason) => {
            if (shuttingDown)
                return;
            shuttingDown = true;
            log(`[w2a/supervisor] shutting down (${reason})`);
            stopGatewayWatch();
            await controlServer.close().catch(() => { });
            await supervisor.terminateAll().catch((error) => {
                log(`[w2a/supervisor] terminateAll failed: ${error instanceof Error ? error.message : String(error)}`);
            });
            await removePidFile(paths).catch(() => { });
            await new Promise((resolve) => logStream.end(resolve));
            process.exit(0);
        };
        const stopGatewayWatch = await startGatewayWatch({
            gatewayPidFile: paths.gatewayPidFile,
            log,
            onGatewayExit: () => shutdown("gateway exited"),
        });
        process.on("SIGTERM", () => {
            void shutdown("SIGTERM");
        });
        process.on("SIGINT", () => {
            void shutdown("SIGINT");
        });
        const applied = await supervisor.applyConfig(manifest.sensors);
        log(`[w2a/supervisor] initial apply: ${JSON.stringify(applied)}`);
        await new Promise(() => { });
    }
    catch (error) {
        log(`[w2a/supervisor] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        await removePidFile(paths).catch(() => { });
        await new Promise((resolve) => logStream.end(resolve));
        throw error;
    }
}
function createLogger(stream) {
    return (line) => {
        const formatted = `[${new Date().toISOString()}] ${line}\n`;
        process.stdout.write(formatted);
        stream.write(formatted);
    };
}
function parsePort(args) {
    const index = args.indexOf("--port");
    if (index === -1)
        return 8645;
    const raw = args[index + 1];
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid --port value: ${String(raw)}`);
    }
    return port;
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
