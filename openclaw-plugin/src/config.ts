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
  // Prefer config.current() (newer API); fall back to deprecated loadConfig()
  // for compat with older OpenClaw runtimes; final fallback is api.config
  // (the static snapshot handed to register()).
  if (typeof api.runtime?.config?.current === "function") {
    return api.runtime.config.current();
  }
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
    // Default to "main" so W2A signals lane through the user's existing main
    // agent (different sessionKey, no cross-contamination of the user's
    // chat session). Operators who want full isolation can set
    // `defaultAgentId: "world2agent"` (or any other agent id) in plugin config
    // — they then need `openclaw agents add <id>` to create that agent.
    defaultAgentId: asOptionalString(raw.defaultAgentId) ?? "main",
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

  // Only extend an EXISTING allowlist. If the agent has no `skills` field,
  // they have no allowlist (= every skill is accessible) and we must NOT
  // create one out of nowhere — that would silently restrict the agent to
  // just this one skill, breaking the conversational install flow for any
  // future sensor (since `world2agent-manage` would no longer be reachable).
  // The dispatcher's prompt-prefix fallback (`Use skill: <id>`) covers the
  // no-allowlist case correctly.
  if (!Array.isArray(currentAgent.skills)) {
    return {
      changed: false,
      nextConfig: config,
      warning: null,
    };
  }

  const currentSkills = [...currentAgent.skills];
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
