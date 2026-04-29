import { watch, type FSWatcher } from "node:fs";
import type { BridgePaths, SharedConfig } from "./manifest.js";
import { pathExists, readConfig } from "./manifest.js";

interface ConfigWatcherOptions {
  paths: BridgePaths;
  log: (line: string) => void;
  onConfig: (config: SharedConfig) => Promise<void> | void;
}

const DEBOUNCE_MS = 500;
const REATTACH_DELAY_MS = 100;

export async function startConfigWatcher(
  options: ConfigWatcherOptions,
): Promise<() => void> {
  let stopped = false;
  let watcher: FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let reattachTimer: NodeJS.Timeout | null = null;

  const clearTimers = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (reattachTimer) {
      clearTimeout(reattachTimer);
      reattachTimer = null;
    }
  };

  const trigger = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void reloadConfig();
    }, DEBOUNCE_MS);
    debounceTimer.unref();
  };

  const scheduleReattach = () => {
    if (stopped || reattachTimer) return;
    reattachTimer = setTimeout(() => {
      reattachTimer = null;
      attach();
    }, REATTACH_DELAY_MS);
    reattachTimer.unref();
  };

  const attach = () => {
    if (stopped) return;
    watcher?.close();
    try {
      watcher = watch(options.paths.configFile, (eventType) => {
        trigger();
        if (eventType === "rename") {
          scheduleReattach();
        }
      });
      watcher.on("error", (error) => {
        options.log(
          `[w2a/config-watch] watcher error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        scheduleReattach();
      });
    } catch (error) {
      options.log(
        `[w2a/config-watch] failed to watch ${options.paths.configFile}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      scheduleReattach();
    }
  };

  const reloadConfig = async () => {
    if (!(await pathExists(options.paths.configFile))) {
      options.log("[w2a/config-watch] config.json missing; keeping current children");
      return;
    }

    try {
      const config = await readConfig(options.paths);
      await options.onConfig(config);
    } catch (error) {
      options.log(
        `[w2a/config-watch] invalid config.json; keeping current children: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  attach();

  return () => {
    stopped = true;
    clearTimers();
    watcher?.close();
  };
}
