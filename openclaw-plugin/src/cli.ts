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
        .option(
          "--config-file <path>",
          "Path to a sensor config JSON file",
        )
        .option(
          "--config-json <json>",
          "Inline JSON config string (alternative to --config-file)",
        )
        .option("--isolated", "Run this sensor out-of-process")
        .option(
          "--skip-generate-skill",
          "Do not auto-generate a fallback SKILL.md. Use this when the calling agent has already written a personalized handler skill via the SETUP.md Q&A flow.",
        )
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
  const configJson = optionString(options, "configJson");
  const isolated = optionBoolean(options, "isolated");
  const skipGenerateSkill = optionBoolean(options, "skipGenerateSkill");
  const skillId = packageToSkillId(pkg);
  const sensorConfig = await loadConfigFile(configFile, configJson, installed);

  // The agent-driven path (world2agent-manage skill running SETUP.md Q&A)
  // writes a personalized SKILL.md before invoking this command and passes
  // --skip-generate-skill. The fallback path (direct CLI use) lets the
  // helper write a generic SKILL.md, but only when the file doesn't exist.
  let skillGenerated: { written: boolean } = { written: false };
  if (!skipGenerateSkill) {
    const result = await writeGeneratedSkill(services.paths, pkg, installed);
    skillGenerated = { written: result.written };
  }

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
    skill_generated: skillGenerated.written,
    skill_path: join(services.paths.openclawSkillsDir, skillId, "SKILL.md"),
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
  if (result.changed) {
    const cfg = api.runtime?.config;
    // OpenClaw's runtime APIs take a params object, not the config directly:
    //   replaceConfigFile({ nextConfig, ... })
    //   mutateConfigFile({ mutate: (draft) => { ...mutate in place... } })
    // Passing the config bare causes OpenClaw to destructure it as params and
    // see `params.nextConfig === undefined`, which fails schema validation.
    if (typeof cfg?.replaceConfigFile === "function") {
      await cfg.replaceConfigFile({ nextConfig: result.nextConfig });
    } else if (typeof cfg?.mutateConfigFile === "function") {
      await cfg.mutateConfigFile({
        mutate: (draft) => {
          const next = result.nextConfig as Record<string, unknown>;
          const target = draft as Record<string, unknown>;
          for (const key of Object.keys(target)) delete target[key];
          for (const [key, value] of Object.entries(next)) target[key] = value;
        },
      });
    } else if (typeof cfg?.writeConfigFile === "function") {
      await cfg.writeConfigFile(result.nextConfig);
    }
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

