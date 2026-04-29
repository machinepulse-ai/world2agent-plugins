import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildIsolatedRunnerEnv, hashConfig, shouldRestartIsolatedHandle } from "./supervisor/shared.js";
import type {
  ApplyResult,
  IsolatedRunnerHandle,
  RequiredWorld2AgentPluginConfig,
  SensorEntry,
  World2AgentPaths,
} from "./types.js";

const NO_RESTART_EXIT_CODES = new Set([0, 10, 11, 12]);

interface ChildHandle extends IsolatedRunnerHandle {
  webhookUrl: string;
  process: ChildProcessWithoutNullStreams;
  stopping: boolean;
  lastExitCode: number | null;
  restartCount: number;
}

export interface IsolatedRunnerManagerOptions {
  paths: World2AgentPaths;
  pluginConfig: RequiredWorld2AgentPluginConfig;
  ingestUrl?: string;
  hmacSecret: string;
  log: (line: string) => void;
}

export class IsolatedRunnerManager {
  private readonly options: IsolatedRunnerManagerOptions;
  private readonly handles = new Map<string, ChildHandle>();
  private readonly desiredEntries = new Map<string, SensorEntry>();
  private readonly runnerBin = fileURLToPath(new URL("./runner/bin.js", import.meta.url));

  constructor(options: IsolatedRunnerManagerOptions) {
    this.options = options;
  }

  async apply(entries: SensorEntry[]): Promise<ApplyResult> {
    const desired = entries.filter((entry) => entry.enabled !== false && entry.isolated === true);
    const result: ApplyResult = {
      started: [],
      restarted: [],
      stopped: [],
      failed: [],
    };

    this.desiredEntries.clear();
    for (const entry of desired) {
      this.desiredEntries.set(entry.sensor_id, entry);
    }

    for (const [sensorId, handle] of [...this.handles.entries()]) {
      if (!this.desiredEntries.has(sensorId)) {
        await this.terminate(handle);
        result.stopped.push(sensorId);
      }
    }

    for (const entry of desired) {
      if (!this.options.ingestUrl) {
        result.failed.push({
          sensor_id: entry.sensor_id,
          error:
            "isolated runner requires plugin config `ingestUrl` so the subprocess can POST /w2a/ingest",
        });
        continue;
      }

      const existing = this.handles.get(entry.sensor_id);
      if (!existing) {
        try {
          await this.spawn(entry);
          result.started.push(entry.sensor_id);
        } catch (error) {
          result.failed.push({ sensor_id: entry.sensor_id, error: errorMessage(error) });
        }
        continue;
      }

      if (!shouldRestartIsolatedHandle(existing, entry, this.options.ingestUrl)) {
        continue;
      }

      try {
        await this.terminate(existing);
        await this.spawn(entry);
        result.restarted.push(entry.sensor_id);
      } catch (error) {
        result.failed.push({ sensor_id: entry.sensor_id, error: errorMessage(error) });
      }
    }

    return result;
  }

  async terminateAll(graceMs = 5_000): Promise<void> {
    this.desiredEntries.clear();
    for (const handle of [...this.handles.values()]) {
      await this.terminate(handle, graceMs);
    }
  }

  private async spawn(entry: SensorEntry, restartCount = 0): Promise<ChildHandle> {
    if (!this.options.ingestUrl) {
      throw new Error(
        "isolated runner requires plugin config `ingestUrl` so the subprocess can POST /w2a/ingest",
      );
    }

    const proc = spawn(process.execPath, [this.runnerBin], {
      env: buildIsolatedRunnerEnv({
        pkg: entry.pkg,
        sensorId: entry.sensor_id,
        skillId: entry.skill_id,
        ingestUrl: this.options.ingestUrl,
        hmacSecret: this.options.hmacSecret,
        statePath: join(this.options.paths.stateDir, `${entry.sensor_id}.json`),
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const handle: ChildHandle = {
      sensorId: entry.sensor_id,
      pkg: entry.pkg,
      skillId: entry.skill_id,
      isolated: true,
      configHash: hashConfig(entry.config),
      startedAt: Date.now(),
      cleanup: async () => {
        await this.terminate(handle);
      },
      webhookUrl: this.options.ingestUrl,
      process: proc,
      stopping: false,
      lastExitCode: null,
      restartCount,
    };

    this.handles.set(entry.sensor_id, handle);
    proc.on("exit", (code, signal) => {
      void this.handleExit(handle, code, signal);
    });
    pipeStream(proc.stdout, (line) => this.options.log(`[w2a/${entry.sensor_id}] ${line}`));
    pipeStream(proc.stderr, (line) => this.options.log(`[w2a/${entry.sensor_id}] ${line}`));
    proc.stdin.end(JSON.stringify(entry.config ?? {}) + "\n");

    return handle;
  }

  private async terminate(handle: ChildHandle, graceMs = 5_000): Promise<void> {
    handle.stopping = true;
    if (handle.process.exitCode !== null || handle.process.killed) {
      this.handles.delete(handle.sensorId);
      return;
    }

    const exitPromise = once(handle.process, "exit").catch(() => []);
    try {
      handle.process.kill("SIGTERM");
    } catch {
      this.handles.delete(handle.sensorId);
      return;
    }

    const timedOut = await Promise.race([
      exitPromise.then(() => false),
      delay(graceMs).then(() => true),
    ]);
    if (timedOut) {
      try {
        handle.process.kill("SIGKILL");
      } catch {
        // no-op
      }
      await exitPromise;
    }

    this.handles.delete(handle.sensorId);
  }

  private async handleExit(
    handle: ChildHandle,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    handle.lastExitCode = code;

    const current = this.handles.get(handle.sensorId);
    if (current !== handle) return;
    this.handles.delete(handle.sensorId);
    this.options.log(
      `[w2a/${handle.sensorId}] isolated runner exited code=${String(code)} signal=${String(signal)}`,
    );

    if (handle.stopping) return;
    if (code !== null && NO_RESTART_EXIT_CODES.has(code)) return;

    const nextEntry = this.desiredEntries.get(handle.sensorId);
    if (!nextEntry) return;
    if (!this.options.ingestUrl) return;

    try {
      await this.spawn(nextEntry, handle.restartCount + 1);
    } catch (error) {
      this.options.log(
        `[w2a/${handle.sensorId}] isolated restart failed: ${errorMessage(error)}`,
      );
    }
  }
}

function pipeStream(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): void {
  stream.setEncoding("utf8");
  let buffer = "";
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const line = buffer.slice(0, index).trimEnd();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
