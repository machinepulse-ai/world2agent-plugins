import { FileSensorStore, startSensor, type SensorSpec } from "@world2agent/sdk";
import { join } from "node:path";
import type { Dispatcher, ApplyResult, RuntimeHandle, SensorEntry, World2AgentPaths } from "./types.js";
import { hashConfig } from "./manifest.js";
import { IsolatedRunnerManager } from "./isolated.js";
import { resolveImportTarget } from "./supervisor/shared.js";

export interface SensorRuntimeOptions {
  dispatcher: Dispatcher;
  isolatedRunnerManager: IsolatedRunnerManager;
  paths: World2AgentPaths;
  log: (line: string) => void;
}

export class SensorRuntime {
  private readonly dispatcher: Dispatcher;
  private readonly isolatedRunnerManager: IsolatedRunnerManager;
  private readonly paths: World2AgentPaths;
  private readonly log: (line: string) => void;
  private readonly handles = new Map<string, RuntimeHandle>();
  // Serialize applyManifest calls. Without this, two concurrent invocations
  // (e.g. plugin startup race with `world2agent.reload`, or two reloads in
  // quick succession) can both observe an empty handle map, both call
  // `startHandle`, and orphan one of the resulting in-process sensor
  // instances — the orphan keeps a private `setInterval` poll loop and a
  // private `FileSensorStore` mirror, defeating dedup and creating an emit
  // storm. Same pattern as hermes-sensor-bridge's supervisor.
  private applyLock: Promise<unknown> = Promise.resolve();

  constructor(options: SensorRuntimeOptions) {
    this.dispatcher = options.dispatcher;
    this.isolatedRunnerManager = options.isolatedRunnerManager;
    this.paths = options.paths;
    this.log = options.log;
  }

  async applyManifest(entries: SensorEntry[]): Promise<ApplyResult> {
    const callId = Math.random().toString(36).slice(2, 8);
    let release!: () => void;
    const previous = this.applyLock;
    this.applyLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.log(`[w2a/lock] ${callId} queued (handles=${[...this.handles.keys()].join(",") || "none"})`);
    await previous.catch(() => undefined);
    this.log(`[w2a/lock] ${callId} acquired (handles=${[...this.handles.keys()].join(",") || "none"})`);
    try {
      const result = await this.applyManifestUnlocked(entries);
      this.log(
        `[w2a/lock] ${callId} done started=${result.started.length} restarted=${result.restarted.length} stopped=${result.stopped.length} failed=${result.failed.length} (handles=${[...this.handles.keys()].join(",") || "none"})`,
      );
      return result;
    } finally {
      release();
    }
  }

  private async applyManifestUnlocked(entries: SensorEntry[]): Promise<ApplyResult> {
    const desired = entries.filter((entry) => entry.enabled !== false);
    const result: ApplyResult = {
      started: [],
      restarted: [],
      stopped: [],
      failed: [],
    };

    const desiredInProcess = desired.filter((entry) => entry.isolated !== true);

    for (const [sensorId, handle] of [...this.handles.entries()]) {
      if (!desiredInProcess.some((entry) => entry.sensor_id === sensorId)) {
        await this.stopHandle(handle);
        result.stopped.push(sensorId);
      }
    }

    for (const entry of desiredInProcess) {
      const existing = this.handles.get(entry.sensor_id);
      if (!existing) {
        try {
          await this.startHandle(entry);
          result.started.push(entry.sensor_id);
        } catch (error) {
          result.failed.push({ sensor_id: entry.sensor_id, error: errorMessage(error) });
        }
        continue;
      }

      if (matchesHandle(existing, entry)) {
        continue;
      }

      try {
        await this.stopHandle(existing);
        await this.startHandle(entry);
        result.restarted.push(entry.sensor_id);
      } catch (error) {
        result.failed.push({ sensor_id: entry.sensor_id, error: errorMessage(error) });
      }
    }

    const isolatedResult = await this.isolatedRunnerManager.apply(desired);
    mergeApplyResult(result, isolatedResult);

    return result;
  }

  async stopAll(): Promise<void> {
    for (const handle of [...this.handles.values()]) {
      await this.stopHandle(handle);
    }
    await this.isolatedRunnerManager.terminateAll();
  }

  private async startHandle(entry: SensorEntry): Promise<void> {
    const spec = await loadSensorSpec(entry.pkg);
    const store = new FileSensorStore({
      path: join(this.paths.stateDir, `${entry.sensor_id}.json`),
    });
    // Sensor logger writes to stderr (via this.log → OpenClaw's logger), NEVER stdout.
    // stdout in the gateway process is shared with the user's terminal during
    // interactive commands like `openclaw agents add`, and noisy sensor logs
    // would corrupt those interactive prompts.
    const sensorLog = (line: string) => this.log(`[w2a/${entry.sensor_id}] ${line}`);
    const sensorLogger = {
      info: (msg: string, ...args: unknown[]) =>
        sensorLog(args.length > 0 ? `${msg} ${args.map(String).join(" ")}` : msg),
      warn: (msg: string, ...args: unknown[]) =>
        sensorLog(args.length > 0 ? `WARN ${msg} ${args.map(String).join(" ")}` : `WARN ${msg}`),
      error: (msg: string, ...args: unknown[]) =>
        sensorLog(args.length > 0 ? `ERROR ${msg} ${args.map(String).join(" ")}` : `ERROR ${msg}`),
      debug: (msg: string, ...args: unknown[]) =>
        sensorLog(args.length > 0 ? `DEBUG ${msg} ${args.map(String).join(" ")}` : `DEBUG ${msg}`),
    };
    const cleanup = await startSensor(spec, {
      config: entry.config,
      store,
      logger: sensorLogger,
      logEmits: true,
      onSignal: async (signal) => {
        try {
          await this.dispatcher.dispatch({
            sensorId: entry.sensor_id,
            skillId: entry.skill_id,
            signal,
            ...(entry.deliver ? { deliver: entry.deliver } : {}),
          });
          this.log(
            `[w2a/${entry.sensor_id}] dispatched ${signal.signal_id} [${signal.event?.type ?? "unknown"}]`,
          );
        } catch (error) {
          this.log(
            `[w2a/${entry.sensor_id}] dispatch failed for ${signal.signal_id}: ${errorMessage(error)}`,
          );
        }
      },
    });

    const handle: RuntimeHandle = {
      sensorId: entry.sensor_id,
      pkg: entry.pkg,
      skillId: entry.skill_id,
      isolated: false,
      configHash: hashConfig(entry.config),
      startedAt: Date.now(),
      cleanup,
      flush: () => store.flush(),
    };
    this.handles.set(entry.sensor_id, handle);
  }

  private async stopHandle(handle: RuntimeHandle): Promise<void> {
    try {
      await handle.cleanup();
      await handle.flush?.();
    } finally {
      this.handles.delete(handle.sensorId);
    }
  }
}

async function loadSensorSpec(pkg: string): Promise<SensorSpec<Record<string, unknown>>> {
  const module = await import(resolveImportTarget(pkg));
  const spec = module.default as SensorSpec<Record<string, unknown>> | undefined;
  if (!spec || typeof spec.start !== "function") {
    throw new Error(`${pkg} does not export a valid default SensorSpec`);
  }
  return spec;
}

function matchesHandle(handle: RuntimeHandle, entry: SensorEntry): boolean {
  return (
    handle.pkg === entry.pkg &&
    handle.skillId === entry.skill_id &&
    handle.configHash === hashConfig(entry.config) &&
    handle.isolated === false
  );
}

function mergeApplyResult(target: ApplyResult, update: ApplyResult): void {
  target.started.push(...update.started);
  target.restarted.push(...update.restarted);
  target.stopped.push(...update.stopped);
  target.failed.push(...update.failed);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
