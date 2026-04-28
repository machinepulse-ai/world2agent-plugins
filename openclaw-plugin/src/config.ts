import type {
  OpenClawAgentConfig,
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginConfig,
} from "./openclaw/plugin-sdk/types.js";
import type { RequiredWorld2AgentPluginConfig } from "./types.js";

export const REQUIRED_CONTEXT_INJECTION = "continuation-skip";

export async function loadEffectiveOpenClawConfig(
  api: OpenClawPluginApi,
): Promise<OpenClawConfig> {
  if (typeof api.runtime?.config?.loadConfig === "function") {
    return api.runtime.config.loadConfig();
  }
  return api.config ?? {};
}

export function assertContextInjectionCompatible(config: OpenClawConfig): void {
  const got = config.agents?.defaults?.contextInjection;
  if (got === REQUIRED_CONTEXT_INJECTION) return;

  throw new Error(
    "OpenClaw config field `agents.defaults.contextInjection` must be set to " +
      `"${REQUIRED_CONTEXT_INJECTION}" for @world2agent/openclaw-plugin. ` +
      `Current value: ${JSON.stringify(got)}. Update that exact field and retry.`,
  );
}

export function normalizePluginConfig(
  value: unknown,
): RequiredWorld2AgentPluginConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as OpenClawPluginConfig)
      : {};

  return {
    sensorsManifestPath: asOptionalString(raw.sensorsManifestPath),
    stateDir: asOptionalString(raw.stateDir),
    sessionDir: asOptionalString(raw.sessionDir),
    workspaceDir: asOptionalString(raw.workspaceDir),
    ingestUrl: asOptionalString(raw.ingestUrl),
    defaultAgentId: asOptionalString(raw.defaultAgentId) ?? "world2agent",
    provider: asOptionalString((raw as Record<string, unknown>).provider),
    model: asOptionalString((raw as Record<string, unknown>).model),
    requestTimeoutMs: asPositiveInteger(raw.requestTimeoutMs) ?? 120_000,
    ingestHmacSecretFile: asOptionalString(raw.ingestHmacSecretFile),
    ingestDedupTtlMs: asPositiveInteger(raw.ingestDedupTtlMs) ?? 3_600_000,
  };
}

export function hasDedicatedAgentSkillsAllowlist(
  config: OpenClawConfig,
  agentId: string,
): boolean {
  const agent = findDedicatedAgent(config, agentId);
  return Array.isArray(agent?.skills);
}

export function findDedicatedAgent(
  config: OpenClawConfig,
  agentId: string,
): OpenClawAgentConfig | undefined {
  return config.agents?.list?.find(
    (entry) => entry.id === agentId || entry.name === agentId,
  );
}

export function upsertDedicatedAgentSkillAllowlist(
  config: OpenClawConfig,
  agentId: string,
  skillId: string,
): {
  changed: boolean;
  nextConfig: OpenClawConfig;
  warning: string | null;
} {
  const currentAgent = findDedicatedAgent(config, agentId);
  if (!currentAgent) {
    return {
      changed: false,
      nextConfig: config,
      warning:
        `Dedicated agent ${JSON.stringify(agentId)} was not found in agents.list; ` +
        "installed skill will rely on prompt-prefix fallback until that agent exists.",
    };
  }

  const currentSkills = Array.isArray(currentAgent.skills)
    ? [...currentAgent.skills]
    : [];
  if (currentSkills.includes(skillId)) {
    return {
      changed: false,
      nextConfig: config,
      warning: null,
    };
  }

  currentSkills.push(skillId);
  currentSkills.sort();

  const nextConfig: OpenClawConfig = structuredClone(config);
  const nextAgent = findDedicatedAgent(nextConfig, agentId);
  if (!nextAgent) {
    return {
      changed: false,
      nextConfig: config,
      warning:
        `Dedicated agent ${JSON.stringify(agentId)} disappeared while cloning config; ` +
        "installed skill will rely on prompt-prefix fallback.",
    };
  }
  nextAgent.skills = currentSkills;

  return {
    changed: true,
    nextConfig,
    warning: null,
  };
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}
