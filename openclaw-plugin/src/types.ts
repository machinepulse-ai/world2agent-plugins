import type { CleanupFn, W2ASignal } from "@world2agent/sdk";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginConfig,
} from "./openclaw/plugin-sdk/types.js";

export interface World2AgentPaths {
  baseDir: string;
  manifestFile: string;
  stateDir: string;
  sessionDir: string;
  openclawHome: string;
  openclawSkillsDir: string;
  ingestHmacSecretFile: string;
}

export interface SensorEntry {
  sensor_id: string;
  pkg: string;
  skill_id: string;
  enabled: boolean;
  isolated?: boolean;
  config: Record<string, unknown>;
}

export interface SensorManifest {
  version: 1;
  sensors: SensorEntry[];
}

export interface DispatcherDispatchInput {
  sensorId: string;
  skillId: string;
  signal: W2ASignal;
  sessionId?: string;
}

export interface Dispatcher {
  dispatch(input: DispatcherDispatchInput): Promise<unknown>;
}

export interface EmbeddedDispatcherOptions {
  api: OpenClawPluginApi;
  openclawConfigRef: { current: OpenClawConfig };
  pluginConfig: RequiredWorld2AgentPluginConfig;
  paths: World2AgentPaths;
}

export interface HttpIngestEnvelope {
  sensor_id: string;
  skill_id: string;
  signal: W2ASignal;
}

export interface HttpDispatcherOptions {
  embeddedDispatcher: Dispatcher;
  hmacSecret: string;
  dedupTtlMs: number;
}

export interface RuntimeHandle {
  sensorId: string;
  pkg: string;
  skillId: string;
  isolated: boolean;
  configHash: string;
  startedAt: number;
  cleanup: CleanupFn;
  flush?: () => Promise<void>;
}

export interface ApplyResult {
  started: string[];
  restarted: string[];
  stopped: string[];
  failed: Array<{ sensor_id: string; error: string }>;
}

export interface RequiredWorld2AgentPluginConfig {
  sensorsManifestPath?: string;
  stateDir?: string;
  sessionDir?: string;
  workspaceDir?: string;
  ingestUrl?: string;
  defaultAgentId: string;
  provider?: string;
  model?: string;
  requestTimeoutMs: number;
  ingestHmacSecretFile?: string;
  ingestDedupTtlMs: number;
}

export interface IsolatedRunnerHandle {
  sensorId: string;
  pkg: string;
  skillId: string;
  isolated: true;
  configHash: string;
  startedAt: number;
  cleanup: CleanupFn;
}

export type ParsedPluginConfig = OpenClawPluginConfig;
