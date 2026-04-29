import { randomBytes } from "node:crypto";
import type { BridgePaths } from "./manifest.js";
import { readTrimmedText, writeTextAtomic } from "./manifest.js";

export interface BridgeState {
  version: 1;
  control_token: string;
  control_port: number;
  supervisor_pid?: number;
  supervisor_started_at?: string;
}

const BRIDGE_STATE_MODE = 0o600;
// Different default port than hermes-sensor-bridge (8645) so both bridges
// can run on the same host without colliding.
const DEFAULT_CONTROL_PORT = 8646;

export async function readBridgeState(paths: BridgePaths): Promise<BridgeState | null> {
  const raw = await readTrimmedText(paths.bridgeStateFile);
  if (!raw) {
    return null;
  }
  const parsed = JSON.parse(raw) as unknown;
  return normalizeBridgeState(parsed);
}

export async function loadOrCreateBridgeState(
  paths: BridgePaths,
  options: {
    controlPort?: number;
  } = {},
): Promise<BridgeState> {
  const existing = await readBridgeState(paths).catch(() => null);
  const next: BridgeState = {
    version: 1,
    control_token: existing?.control_token ?? randomBytes(32).toString("hex"),
    control_port: options.controlPort ?? existing?.control_port ?? DEFAULT_CONTROL_PORT,
    ...(existing?.supervisor_pid ? { supervisor_pid: existing.supervisor_pid } : {}),
    ...(existing?.supervisor_started_at
      ? { supervisor_started_at: existing.supervisor_started_at }
      : {}),
  };
  await writeBridgeState(paths, next);
  return next;
}

export async function updateBridgeState(
  paths: BridgePaths,
  patch: Partial<BridgeState>,
): Promise<BridgeState> {
  const current = await loadOrCreateBridgeState(paths);
  const next: BridgeState = {
    ...current,
    ...patch,
    version: 1,
  };
  await writeBridgeState(paths, next);
  return next;
}

export async function writeBridgeState(paths: BridgePaths, state: BridgeState): Promise<void> {
  const normalized = normalizeBridgeState(state);
  await writeTextAtomic(
    paths.bridgeStateFile,
    JSON.stringify(normalized, null, 2) + "\n",
    BRIDGE_STATE_MODE,
  );
}

function normalizeBridgeState(raw: unknown): BridgeState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(".bridge-state.json must be a JSON object");
  }

  const value = raw as Record<string, unknown>;
  const version = value.version;
  if (version !== 1) {
    throw new Error(`Unsupported bridge state version: ${String(version)}`);
  }

  const state: BridgeState = {
    version: 1,
    control_token: expectString(value.control_token, "control_token"),
    control_port: expectPort(value.control_port),
  };

  const supervisorPid = parseOptionalPid(value.supervisor_pid);
  if (supervisorPid !== undefined) {
    state.supervisor_pid = supervisorPid;
  }

  if (
    typeof value.supervisor_started_at === "string" &&
    value.supervisor_started_at.trim() !== ""
  ) {
    state.supervisor_started_at = value.supervisor_started_at;
  }

  return state;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function expectPort(value: unknown): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`control_port must be an integer between 1 and 65535`);
  }
  return port;
}

function parseOptionalPid(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("supervisor_pid must be a positive integer when present");
  }
  return pid;
}
