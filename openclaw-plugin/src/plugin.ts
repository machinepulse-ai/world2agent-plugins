import { EmbeddedDispatcher, HttpDispatcher } from "./dispatch.js";
import {
  assertContextInjectionCompatible,
  loadEffectiveOpenClawConfig,
  normalizePluginConfig,
} from "./config.js";
import { registerWorld2AgentCli } from "./cli.js";
import { readManifest } from "./manifest.js";
import {
  ensureWorld2AgentDirsSync,
  loadOrCreateHmacSecretSync,
} from "./paths.js";
import { definePluginEntry } from "./openclaw/plugin-sdk/plugin-entry.js";
import type { OpenClawPluginApi } from "./openclaw/plugin-sdk/types.js";
import { IsolatedRunnerManager } from "./isolated.js";
import { SensorRuntime } from "./runtime.js";
import { getWorld2AgentPaths } from "./paths.js";

// Module-level state. OpenClaw can call register() multiple times within
// a single gateway process (e.g. config-driven plugin reload, or some
// startup sequences that load the plugin twice). Without this state, each
// register() would create a fresh SensorRuntime + start a fresh sensor,
// leaving the previous SensorRuntime's sensor running as an orphan. The
// orphan keeps its own setInterval poll loop and FileSensorStore mirror,
// causing duplicate emits and dedup chaos. Storing state at module scope
// lets a re-register stop the previous runtime before creating a new one.
let activeRuntime: SensorRuntime | null = null;

// register() MUST stay synchronous: OpenClaw's plugin loader logs
// "plugin register returned a promise; async registration is ignored"
// and drops every api.register* call that follows an await.
export function createWorld2AgentPlugin() {
  return definePluginEntry({
    id: "world2agent",
    register(api: OpenClawPluginApi): void {
      const pluginConfig = normalizePluginConfig(api.pluginConfig);
      const paths = getWorld2AgentPaths(pluginConfig);
      ensureWorld2AgentDirsSync(paths);

      registerWorld2AgentCli({
        api,
        paths,
        pluginConfig,
      });

      if ((api.registrationMode ?? "full") === "cli-metadata") {
        return;
      }

      const openclawConfig = api.config ?? {};
      assertContextInjectionCompatible(openclawConfig);
      const openclawConfigRef = { current: openclawConfig };

      // If a previous register() left a runtime running in this same
      // process, stop its sensors before swapping in the new one. Fire and
      // forget — register() must stay sync — but the stopAll runs to
      // completion in the background and the old SensorRuntime is then
      // garbage-collected once nothing references it.
      const previousRuntime = activeRuntime;
      if (previousRuntime) {
        log(api, "[w2a] re-register detected; stopping previous runtime's sensors");
        void previousRuntime.stopAll().catch((err) => {
          log(api, `[w2a] previous runtime stopAll failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }

      const embeddedDispatcher = new EmbeddedDispatcher({
        api,
        openclawConfigRef,
        pluginConfig,
        paths,
      });

      const hmacSecret = loadOrCreateHmacSecretSync(paths.ingestHmacSecretFile);
      const httpDispatcher = new HttpDispatcher({
        embeddedDispatcher,
        hmacSecret,
        dedupTtlMs: pluginConfig.ingestDedupTtlMs,
      });

      api.registerHttpRoute?.(httpDispatcher.createRoute());

      const runtime = new SensorRuntime({
        dispatcher: embeddedDispatcher,
        isolatedRunnerManager: new IsolatedRunnerManager({
          paths,
          pluginConfig,
          ingestUrl: pluginConfig.ingestUrl,
          hmacSecret,
          log: (line) => log(api, line),
        }),
        paths,
        log: (line) => log(api, line),
      });
      activeRuntime = runtime;

      api.registerGatewayMethod?.("world2agent.reload", async () => {
        const nextConfig = await loadEffectiveOpenClawConfig(api);
        assertContextInjectionCompatible(nextConfig);
        openclawConfigRef.current = nextConfig;
        const manifest = await readManifest(paths);
        return {
          ok: true,
          applied: await runtime.applyManifest(manifest.sensors),
        };
      });

      if ((api.registrationMode ?? "full") !== "full") {
        return;
      }

      // Fire-and-forget: must not be awaited because register() itself is sync.
      void runStartup({ api, runtime, paths });
    },
  });
}

async function runStartup(opts: {
  api: OpenClawPluginApi;
  runtime: SensorRuntime;
  paths: ReturnType<typeof getWorld2AgentPaths>;
}): Promise<void> {
  try {
    const manifest = await readManifest(opts.paths);
    const applied = await opts.runtime.applyManifest(manifest.sensors);
    if (applied.failed.length > 0) {
      log(
        opts.api,
        `[w2a] startup completed with failures: ${JSON.stringify(applied.failed)}`,
      );
    }
  } catch (error) {
    const logger = opts.api.logger ?? console;
    logger.error("[w2a] startup failed:", error);
  }
}

function log(api: OpenClawPluginApi, line: string): void {
  const logger = api.logger ?? console;
  logger.info(line);
}
