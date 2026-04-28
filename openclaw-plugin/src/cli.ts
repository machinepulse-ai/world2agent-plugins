import { join } from "node:path";
import { packageToSkillId } from "@world2agent/sdk";
import {
  assertContextInjectionCompatible,
  loadEffectiveOpenClawConfig,
  upsertDedicatedAgentSkillAllowlist,
} from "./config.js";
import { ensurePackageInstalled, loadConfigFile, maybeUninstallPackage, runCommand, writeGeneratedSkill } from "./install.js";
import {
  defaultSensorId,
  readManifest,
  removePath,
  removeSensorEntry,
  upsertSensorEntry,
  writeManifest,
} from "./manifest.js";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
} from "./openclaw/plugin-sdk/types.js";
import type { RequiredWorld2AgentPluginConfig, SensorEntry, World2AgentPaths } from "./types.js";

export interface World2AgentCliServices {
  api: OpenClawPluginApi;
  paths: World2AgentPaths;
  pluginConfig: RequiredWorld2AgentPluginConfig;
}

export function registerWorld2AgentCli(services: World2AgentCliServices): void {
  services.api.registerCli?.(
    ({ program }) => {
      const root = program.command("world2agent").description("Manage World2Agent sensors");
      const sensor = root.command("sensor").description("Manage sensor instances");

      sensor
        .command("list")
        .description("List configured sensors")
        .action(async () => {
          printJson(await runListCommand(services));
        });

      sensor
        .command("add <pkg>")
        .description("Install and configure a sensor")
        .option("--sensor-id <id>", "Override the default sensor id")
        .option("--config-file <path>", "Path to the sensor config JSON file")
        .option("--isolated", "Run this sensor out-of-process")
        .action(async (pkg: string, options: Record<string, unknown>) => {
          printJson(await runAddCommand(services, pkg, options));
        });

      sensor
        .command("remove <sensorId>")
        .description("Remove a configured sensor")
        .option("--purge", "Remove the generated skill directory and best-effort uninstall the package")
        .action(async (sensorId: string, options: Record<string, unknown>) => {
          printJson(await runRemoveCommand(services, sensorId, options));
        });

      root
        .command("reload")
        .description("Ask the running gateway plugin instance to reload sensors")
        .action(async () => {
          printJson(await runReloadCommand());
        });
    },
    {
      descriptors: [
        {
          name: "world2agent",
          description: "Manage World2Agent sensors",
          hasSubcommands: true,
        },
      ],
    },
  );
}

async function runListCommand(
  services: World2AgentCliServices,
): Promise<unknown> {
  const config = await loadEffectiveOpenClawConfig(services.api);
  const manifest = await readManifest(services.paths);
  return {
    ok: true,
    contextInjection: config.agents?.defaults?.contextInjection ?? null,
    dedicated_agent_id: services.pluginConfig.defaultAgentId,
    sensors: manifest.sensors,
  };
}

async function runAddCommand(
  services: World2AgentCliServices,
  pkg: string,
  options: Record<string, unknown>,
): Promise<unknown> {
  const config = await loadEffectiveOpenClawConfig(services.api);
  assertContextInjectionCompatible(config);

  const installed = await ensurePackageInstalled(pkg);
  const sensorId = optionString(options, "sensorId") ?? defaultSensorId(pkg);
  const configFile = optionString(options, "configFile");
  const isolated = optionBoolean(options, "isolated");
  const skillId = packageToSkillId(pkg);
  const sensorConfig = await loadConfigFile(configFile, installed);
  await writeGeneratedSkill(services.paths, pkg, installed);

  const manifest = await readManifest(services.paths);
  const entry: SensorEntry = {
    sensor_id: sensorId,
    pkg,
    skill_id: skillId,
    enabled: true,
    isolated,
    config: sensorConfig,
  };
  await writeManifest(services.paths, upsertSensorEntry(manifest, entry));

  const allowlist = await maybePersistAllowlist(
    services.api,
    config,
    services.pluginConfig.defaultAgentId,
    skillId,
  );
  const reload = await runReloadCommand();

  return {
    ok: true,
    sensor_id: sensorId,
    skill_id: skillId,
    isolated,
    allowlist,
    reload,
  };
}

async function runRemoveCommand(
  services: World2AgentCliServices,
  sensorId: string,
  options: Record<string, unknown>,
): Promise<unknown> {
  const manifest = await readManifest(services.paths);
  const { manifest: nextManifest, removed } = removeSensorEntry(manifest, sensorId);
  if (!removed) {
    throw new Error(`Sensor not found: ${sensorId}`);
  }

  await writeManifest(services.paths, nextManifest);

  const purge = optionBoolean(options, "purge");
  if (purge) {
    await removePath(join(services.paths.openclawSkillsDir, removed.skill_id));
    const stillUsesPackage = nextManifest.sensors.some((entry) => entry.pkg === removed.pkg);
    if (!stillUsesPackage) {
      await maybeUninstallPackage(removed.pkg);
    }
  }

  return {
    ok: true,
    removed,
    purge,
    reload: await runReloadCommand(),
  };
}

async function runReloadCommand(): Promise<unknown> {
  try {
    const { stdout } = await runCommand("openclaw", [
      "gateway",
      "call",
      "world2agent.reload",
      "--json",
    ]);

    try {
      return JSON.parse(stdout);
    } catch {
      return {
        ok: true,
        raw: stdout.trim(),
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function maybePersistAllowlist(
  api: OpenClawPluginApi,
  config: OpenClawConfig,
  agentId: string,
  skillId: string,
): Promise<unknown> {
  const result = upsertDedicatedAgentSkillAllowlist(config, agentId, skillId);
  if (result.changed && typeof api.runtime?.config?.writeConfigFile === "function") {
    await api.runtime.config.writeConfigFile(result.nextConfig);
  }
  return {
    changed: result.changed,
    warning: result.warning,
  };
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function optionString(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionBoolean(options: Record<string, unknown>, key: string): boolean {
  return options[key] === true;
}

