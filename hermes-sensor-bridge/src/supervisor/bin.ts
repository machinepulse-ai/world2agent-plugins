#!/usr/bin/env node

import { createWriteStream, type WriteStream } from "node:fs";
import {
  ensureConfigFile,
  ensureBridgeDirs,
  getBridgePaths,
  isProcessAlive,
  readPidFile,
  removePidFile,
  listBridgeSensors,
  readConfig,
  writePidFile,
} from "./manifest.js";
import { SensorSupervisor } from "./spawn.js";
import { startControlServer } from "./control-server.js";
import { startConfigWatcher } from "./config-watcher.js";
import { loadOrCreateBridgeState, updateBridgeState } from "./state.js";

async function main(): Promise<void> {
  parseSupervisorArgs(process.argv.slice(2));
  const paths = getBridgePaths();
  await ensureBridgeDirs(paths);
  await ensureConfigFile(paths);

  const existingPid = await readPidFile(paths);
  if (existingPid && existingPid !== process.pid && (await isProcessAlive(existingPid))) {
    throw new Error(`Supervisor already running with pid ${existingPid}`);
  }

  const logStream = createWriteStream(paths.supervisorLogFile, { flags: "a" });
  const log = createLogger(logStream);

  try {
    await writePidFile(paths, process.pid);

    const state = await loadOrCreateBridgeState(paths);
    await updateBridgeState(paths, {
      supervisor_pid: process.pid,
      supervisor_started_at: new Date().toISOString(),
    });

    const supervisor = new SensorSupervisor({
      paths,
      hmacSecret: state.hmac_secret,
      log,
    });
    const startedAt = Date.now();

    const controlServer = await startControlServer({
      paths,
      supervisor,
      token: state.control_token,
      port: state.control_port,
      startedAt,
      supervisorPid: process.pid,
      log,
    });

    let shuttingDown = false;
    const shutdown = async (reason: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log(`[w2a/supervisor] shutting down (${reason})`);

      stopConfigWatcher();
      await controlServer.close().catch(() => {});
      await supervisor.terminateAll().catch((error) => {
        log(
          `[w2a/supervisor] terminateAll failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      await removePidFile(paths).catch(() => {});
      await new Promise<void>((resolve) => logStream.end(resolve));
      process.exit(0);
    };

    const stopConfigWatcher = await startConfigWatcher({
      paths,
      log,
      onConfig: async (config) => {
        const applied = await supervisor.applyConfig(listBridgeSensors(config));
        log(`[w2a/config-watch] applied: ${JSON.stringify(applied)}`);
      },
    });

    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });

    const config = await readConfig(paths);
    const applied = await supervisor.applyConfig(listBridgeSensors(config));
    log(`[w2a/supervisor] initial apply: ${JSON.stringify(applied)}`);

    await new Promise<void>(() => {});
  } catch (error) {
    log(`[w2a/supervisor] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    await removePidFile(paths).catch(() => {});
    await new Promise<void>((resolve) => logStream.end(resolve));
    throw error;
  }
}

function createLogger(stream: WriteStream): (line: string) => void {
  return (line: string) => {
    const formatted = `[${new Date().toISOString()}] ${line}\n`;
    process.stdout.write(formatted);
    stream.write(formatted);
  };
}

function parseSupervisorArgs(args: string[]): void {
  for (const arg of args) {
    if (arg === "--foreground") {
      continue;
    }
    throw new Error(`Unknown supervisor argument: ${arg}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
