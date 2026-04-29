import type { IncomingMessage, ServerResponse } from "node:http";

export interface EmbeddedAgentRunRequest {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  runId: string;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config?: OpenClawConfig;
  prompt: string;
  timeoutMs?: number;
  [key: string]: unknown;
}

export interface OpenClawAgentConfig {
  id?: string;
  name?: string;
  skills?: string[];
  [key: string]: unknown;
}

export interface OpenClawAgentDefaults {
  contextInjection?: string;
  model?: {
    primary?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OpenClawConfig {
  agents?: {
    defaults?: OpenClawAgentDefaults;
    list?: OpenClawAgentConfig[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OpenClawPluginConfig {
  sensorsManifestPath?: string;
  stateDir?: string;
  sessionDir?: string;
  workspaceDir?: string;
  ingestUrl?: string;
  defaultAgentId?: string;
  requestTimeoutMs?: number;
  ingestHmacSecretFile?: string;
  ingestDedupTtlMs?: number;
}

export interface OpenClawPluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export interface OpenClawRuntimeAgentSessionApi {
  resolveSessionFilePath?(
    sessionId: string,
    entry?: { sessionFile?: string },
    opts?: { agentId?: string; sessionsDir?: string },
  ): string;
  resolveStorePath?(
    store?: string,
    opts?: { agentId?: string },
  ): string;
  loadSessionStore?(agentId: string): Promise<Record<string, unknown>>;
  saveSessionStore?(
    agentId: string,
    store: Record<string, unknown>,
  ): Promise<void>;
}

export interface OpenClawRuntimeSystemApi {
  /**
   * Enqueue a system event for a given session. OpenClaw drains queued
   * system events at the start of the next agent turn and prepends them to
   * the prompt as `System:` lines — this is the canonical way for plugins
   * to inject context as a system notification rather than as user input.
   */
  enqueueSystemEvent?(
    text: string,
    options: {
      sessionKey: string;
      contextKey?: string | null;
      trusted?: boolean;
    },
  ): boolean;
  /**
   * Wake the agent for a specific session/lane. OpenClaw's heartbeat
   * handler will spin up a turn for that sessionKey, automatically draining
   * the queued system events into the turn's prompt as `System:` lines.
   * This is the same mechanism the bundled cron plugin uses to inject
   * scheduled events into the agent.
   *
   * Fire-and-forget — does NOT await turn completion.
   */
  requestHeartbeatNow?(opts?: {
    reason?: string;
    coalesceMs?: number;
    agentId?: string;
    sessionKey?: string;
    heartbeat?: { target?: string };
  }): void;
}

export interface OpenClawRuntimeAgentApi {
  runEmbeddedAgent?(request: EmbeddedAgentRunRequest): Promise<unknown>;
  resolveAgentDir?(config: OpenClawConfig, agentId?: string): string;
  resolveAgentWorkspaceDir?(config: OpenClawConfig, agentId?: string): string;
  resolveAgentTimeoutMs?(config: OpenClawConfig): number;
  session?: OpenClawRuntimeAgentSessionApi;
}

export interface OpenClawSubagentRunParams {
  sessionKey: string;
  message: string;
  provider?: string;
  model?: string;
  /**
   * When true, OpenClaw runs the embedded agent AND calls
   * deliverAgentCommandResult — the assistant reply is routed to the
   * channel/recipient stored on the session entry's deliveryContext.
   * Without `deliver: true`, the run produces an assistant message that
   * stays inside the session lane (no IM push).
   */
  deliver?: boolean;
  extraSystemPrompt?: string;
  lane?: string;
  lightContext?: boolean;
  idempotencyKey?: string;
}

export interface OpenClawSubagentRunResult {
  runId: string;
}

export interface OpenClawSubagentWaitParams {
  runId: string;
  timeoutMs?: number;
}

export interface OpenClawSubagentWaitResult {
  status: "ok" | "error" | "timeout";
  error?: string;
}

export interface OpenClawRuntimeSubagentApi {
  run?(params: OpenClawSubagentRunParams): Promise<OpenClawSubagentRunResult>;
  waitForRun?(params: OpenClawSubagentWaitParams): Promise<OpenClawSubagentWaitResult>;
}

export interface OpenClawConfigWriteOptions {
  afterWrite?: { mode?: "auto" | "skip" | "refresh" } & Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenClawReplaceConfigFileParams {
  nextConfig: OpenClawConfig;
  baseHash?: string;
  afterWrite?: OpenClawConfigWriteOptions["afterWrite"];
  writeOptions?: OpenClawConfigWriteOptions;
}

export interface OpenClawMutateConfigFileParams {
  mutate: (
    draft: OpenClawConfig,
    ctx: { snapshot: unknown; previousHash: string },
  ) => unknown | Promise<unknown>;
  base?: "runtime" | "source";
  baseHash?: string;
  afterWrite?: OpenClawConfigWriteOptions["afterWrite"];
  writeOptions?: OpenClawConfigWriteOptions;
}

export interface OpenClawRuntimeConfigApi {
  /** @deprecated Use current() instead. */
  loadConfig?(): Promise<OpenClawConfig>;
  current?(): OpenClawConfig;
  /** @deprecated Use mutateConfigFile / replaceConfigFile instead. */
  writeConfigFile?(
    config: OpenClawConfig,
    options?: OpenClawConfigWriteOptions,
  ): Promise<void>;
  mutateConfigFile?(params: OpenClawMutateConfigFileParams): Promise<unknown>;
  replaceConfigFile?(params: OpenClawReplaceConfigFileParams): Promise<unknown>;
}

export interface CliCommandBuilder {
  description(text: string): CliCommandBuilder;
  option(flags: string, description?: string): CliCommandBuilder;
  command(name: string): CliCommandBuilder;
  action(handler: (...args: any[]) => unknown): CliCommandBuilder;
}

export interface CliProgram {
  command(name: string): CliCommandBuilder;
}

export type CliRegistrar = (context: { program: CliProgram }) => Promise<void> | void;

export interface CliCommandDescriptor {
  name: string;
  description?: string;
  hasSubcommands?: boolean;
}

export interface OpenClawGatewayMethodContext {
  payload?: unknown;
}

export type OpenClawGatewayMethodHandler = (
  context?: OpenClawGatewayMethodContext,
) => Promise<unknown> | unknown;

export interface OpenClawHttpRouteRegistration {
  path: string;
  auth: "plugin";
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
}

export interface OpenClawPluginApi {
  config?: OpenClawConfig;
  pluginConfig?: unknown;
  registrationMode?: string;
  logger?: OpenClawPluginLogger;
  resolvePath?(value: string): string;
  registerCli?(
    registrar: CliRegistrar,
    options?: { descriptors?: CliCommandDescriptor[] },
  ): void;
  registerGatewayMethod?(
    name: string,
    handler: OpenClawGatewayMethodHandler,
  ): void;
  registerHttpRoute?(route: OpenClawHttpRouteRegistration): void;
  runtime?: {
    agent?: OpenClawRuntimeAgentApi;
    config?: OpenClawRuntimeConfigApi;
    system?: OpenClawRuntimeSystemApi;
    subagent?: OpenClawRuntimeSubagentApi;
  };
}

export interface OpenClawPluginEntry {
  id: string;
  register(api: OpenClawPluginApi): Promise<void> | void;
}
