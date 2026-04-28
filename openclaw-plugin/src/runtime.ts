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

  constructor(options: SensorRuntimeOptions) {
    this.dispatcher = options.dispatcher;
    this.isolatedRunnerManager = options.isolatedRunnerManager;
    this.paths = options.paths;
    this.log = options.log;
  }

  async applyManifest(entries: SensorEntry[]): Promise<ApplyResult> {
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
    const cleanup = await startSensor(spec, {
      config: entry.config,
      store,
      logger: console,
      logEmits: true,
      onSignal: async (signal) => {
        try {
          await this.dispatcher.dispatch({
            sensorId: entry.sensor_id,
            skillId: entry.skill_id,
            signal,
          });
        } catch (error) {
          this.log(
            `[w2a/${entry.sensor_id}] dispatch failed: ${errorMessage(error)}`,
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
