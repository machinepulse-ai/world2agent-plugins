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
  resolveSessionFilePath?(config: OpenClawConfig, sessionId: string): string;
}

export interface OpenClawRuntimeAgentApi {
  runEmbeddedAgent?(request: EmbeddedAgentRunRequest): Promise<unknown>;
  resolveAgentDir?(config: OpenClawConfig, agentId?: string): string;
  resolveAgentWorkspaceDir?(config: OpenClawConfig, agentId?: string): string;
  resolveAgentTimeoutMs?(config: OpenClawConfig): number;
  session?: OpenClawRuntimeAgentSessionApi;
}

export interface OpenClawRuntimeConfigApi {
  loadConfig?(): Promise<OpenClawConfig>;
  writeConfigFile?(config: OpenClawConfig): Promise<void>;
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
  };
}

export interface OpenClawPluginEntry {
  id: string;
  register(api: OpenClawPluginApi): Promise<void> | void;
}
