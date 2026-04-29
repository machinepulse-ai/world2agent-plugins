import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgePaths, BridgeSensorEntry, NotifyTarget } from "./manifest.js";
import { hashConfig, resolveAgentId, resolveSessionKey } from "./manifest.js";
import type { OpenClawConnection } from "./openclaw-config.js";

export interface ChildHandle {
  sensorId: string;
  pkg: string;
  skillId: string;
  configHash: string;
  agentId: string;
  sessionKey: string;
  notify?: NotifyTarget;
  model?: string;
  process: ChildProcessWithoutNullStreams;
  startedAt: number;
  restartCount: number;
  lastExitCode: number | null;
  stopping: boolean;
}

export interface ApplyResult {
  started: string[];
  restarted: string[];
  stopped: string[];
  failed: Array<{ sensor_id: string; error: string }>;
}

export interface HandleSnapshot {
  sensor_id: string;
  pkg: string;
  skill_id: string;
  agent_id: string;
  session_key: string;
  config_hash: string;
  pid: number | undefined;
  started_at: number;
  restart_count: number;
  last_exit_code: number | null;
}

interface SensorSupervisorOptions {
  paths: BridgePaths;
  openclaw: OpenClawConnection;
  log: (line: string) => void;
}

// Exit codes the runner produces deliberately and which should NOT trigger
// a backoff restart loop:
//   0  = clean shutdown (SIGTERM after cleanup)
//   10 = config parse failure
//   11 = sensor package import / SensorSpec validation failure
const NO_RESTART_EXIT_CODES = new Set([0, 10, 11]);

const DELIVERY_TIMEOUT_MS = 10_000;
const DELIVERY_MAX_ATTEMPTS = 3;
const DELIVERY_BASE_DELAY_MS = 500;

// Idempotency window: if the same `signal_id` arrives twice within the TTL,
// only the first POST is sent. Mirrors openclaw-plugin's RequestDeduper.
// The OpenClaw `/hooks/agent` endpoint does NOT honor `x-request-id` for
// dedup (verified via spike), so we have to do it on this side or every
// retried/replayed signal would spawn a duplicate agent turn.
const DEDUP_TTL_MS = 60 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 1024;

export class SensorSupervisor {
  private readonly paths: BridgePaths;
  private readonly openclaw: OpenClawConnection;
  private readonly log: (line: string) => void;
  private readonly handles = new Map<string, ChildHandle>();
  private readonly desiredEntries = new Map<string, BridgeSensorEntry>();
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();
  private readonly seenSignalIds = new Map<string, number>();
  private readonly runnerBin = fileURLToPath(new URL("../runner/bin.js", import.meta.url));
  private readonly require = createRequire(import.meta.url);
  private applyLock = Promise.resolve();

  constructor(options: SensorSupervisorOptions) {
    this.paths = options.paths;
    this.openclaw = options.openclaw;
    this.log = options.log;
  }

  snapshot(): HandleSnapshot[] {
    return [...this.handles.values()]
      .map((handle) => ({
        sensor_id: handle.sensorId,
        pkg: handle.pkg,
        skill_id: handle.skillId,
        agent_id: handle.agentId,
        session_key: handle.sessionKey,
        config_hash: handle.configHash,
        pid: handle.process.pid,
        started_at: handle.startedAt,
        restart_count: handle.restartCount,
        last_exit_code: handle.lastExitCode,
      }))
      .sort((a, b) => a.sensor_id.localeCompare(b.sensor_id));
  }

  async spawn(entry: BridgeSensorEntry, restartCount = 0): Promise<ChildHandle> {
    this.clearRestartTimer(entry._openclaw_bridge.sensor_id);
    const resolvedPackage = this.resolvePackageSpecifier(entry.package);

    // The runner does not need the gateway URL or hook token — those live
    // in the supervisor where signal delivery happens. Keeping secrets out
    // of the child env reduces leak surface.
    const proc = spawn(process.execPath, [this.runnerBin], {
      env: {
        ...process.env,
        W2A_PACKAGE: resolvedPackage,
        W2A_SENSOR_ID: entry._openclaw_bridge.sensor_id,
        W2A_STATE_PATH: `${this.paths.stateDir}/${entry._openclaw_bridge.sensor_id}.json`,
        W2A_LOG_LEVEL: process.env.W2A_LOG_LEVEL ?? "info",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const sessionKey = resolveSessionKey(entry, this.openclaw.defaultSessionKeyPrefix);
    const agentId = resolveAgentId(entry, "main");

    const handle: ChildHandle = {
      sensorId: entry._openclaw_bridge.sensor_id,
      pkg: entry.package,
      skillId: entry._openclaw_bridge.skill_id,
      configHash: hashConfig(entry.config),
      agentId,
      sessionKey,
      ...(entry._openclaw_bridge.notify ? { notify: entry._openclaw_bridge.notify } : {}),
      ...(entry._openclaw_bridge.model ? { model: entry._openclaw_bridge.model } : {}),
      process: proc,
      startedAt: Date.now(),
      restartCount,
      lastExitCode: null,
      stopping: false,
    };

    this.handles.set(entry._openclaw_bridge.sensor_id, handle);
    this.attachChildStreams(handle);
    proc.on("exit", (code, signal) => {
      void this.handleExit(handle, code, signal);
    });

    proc.stdin.end(JSON.stringify(entry.config ?? {}) + "\n");
    this.log(
      `[w2a/${handle.sensorId}] spawned pid=${proc.pid ?? "unknown"} pkg=${entry.package} sessionKey=${sessionKey}`,
    );
    return handle;
  }

  async terminate(handle: ChildHandle, graceMs = 5_000): Promise<void> {
    this.clearRestartTimer(handle.sensorId);
    handle.stopping = true;

    if (handle.process.exitCode !== null || handle.process.killed) {
      this.handles.delete(handle.sensorId);
      return;
    }

    const exitPromise = once(handle.process, "exit").catch(() => []);

    try {
      handle.process.kill("SIGTERM");
    } catch {
      this.handles.delete(handle.sensorId);
      return;
    }

    const timedOut = await Promise.race([
      exitPromise.then(() => false),
      delay(graceMs).then(() => true),
    ]);

    if (timedOut) {
      try {
        handle.process.kill("SIGKILL");
      } catch {
        // no-op
      }
      await exitPromise;
    }

    this.handles.delete(handle.sensorId);
  }

  async applyConfig(entries: BridgeSensorEntry[]): Promise<ApplyResult> {
    let release!: () => void;
    const previous = this.applyLock;
    this.applyLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});

    try {
      return await this.applyConfigUnlocked(entries);
    } finally {
      release();
    }
  }

  async terminateAll(graceMs = 5_000): Promise<void> {
    this.desiredEntries.clear();
    for (const sensorId of this.restartTimers.keys()) {
      this.clearRestartTimer(sensorId);
    }
    for (const handle of [...this.handles.values()]) {
      await this.terminate(handle, graceMs);
    }
  }

  private async applyConfigUnlocked(entries: BridgeSensorEntry[]): Promise<ApplyResult> {
    const result: ApplyResult = {
      started: [],
      restarted: [],
      stopped: [],
      failed: [],
    };

    this.desiredEntries.clear();
    for (const entry of entries) {
      this.desiredEntries.set(entry._openclaw_bridge.sensor_id, entry);
    }

    for (const sensorId of this.restartTimers.keys()) {
      if (!this.desiredEntries.has(sensorId)) {
        this.clearRestartTimer(sensorId);
      }
    }

    for (const [sensorId, handle] of [...this.handles.entries()]) {
      if (!this.desiredEntries.has(sensorId)) {
        await this.terminate(handle);
        result.stopped.push(sensorId);
      }
    }

    for (const [sensorId, entry] of this.desiredEntries.entries()) {
      this.clearRestartTimer(sensorId);

      const handle = this.handles.get(sensorId);
      if (!handle) {
        try {
          await this.spawn(entry);
          result.started.push(sensorId);
        } catch (error) {
          result.failed.push({ sensor_id: sensorId, error: errorMessage(error) });
        }
        continue;
      }

      if (this.matchesEntry(handle, entry)) {
        continue;
      }

      try {
        await this.terminate(handle);
        await this.spawn(entry);
        result.restarted.push(sensorId);
      } catch (error) {
        result.failed.push({ sensor_id: sensorId, error: errorMessage(error) });
      }
    }

    return result;
  }

  private matchesEntry(handle: ChildHandle, entry: BridgeSensorEntry): boolean {
    return (
      handle.pkg === entry.package &&
      handle.skillId === entry._openclaw_bridge.skill_id &&
      handle.configHash === hashConfig(entry.config) &&
      handle.sessionKey === resolveSessionKey(entry, this.openclaw.defaultSessionKeyPrefix) &&
      handle.agentId === resolveAgentId(entry, "main") &&
      hashConfig(handle.notify ?? null) === hashConfig(entry._openclaw_bridge.notify ?? null) &&
      (handle.model ?? null) === (entry._openclaw_bridge.model ?? null)
    );
  }

  private attachChildStreams(handle: ChildHandle): void {
    // stdout: every line is a W2A signal as JSON. Parse and dispatch.
    pipeStream(handle.process.stdout, (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.log(
          `[w2a/${handle.sensorId}] dropped non-JSON line on stdout: ${truncate(line, 240)}`,
        );
        return;
      }

      void this.deliverSignal(handle, parsed).catch((error) => {
        this.log(
          `[w2a/${handle.sensorId}] delivery error: ${errorMessage(error)}`,
        );
      });
    });

    // stderr: sensor / runner diagnostics. Forward verbatim with prefix.
    pipeStream(handle.process.stderr, (line) => {
      this.log(`[w2a/${handle.sensorId}] ${line}`);
    });
  }

  /**
   * Render a signal into a /hooks/agent payload and POST it. Each signal
   * triggers a fresh isolated agent turn — same sessionKey across signals
   * does NOT carry conversation history forward (verified via spike: the
   * gateway maps sessionKey → latest sessionId per call, not append-mode).
   *
   * Retries on 5xx / network errors. Fails fast on 4xx (most often a
   * misconfigured `hooks.allowedSessionKeyPrefixes` or stale token).
   *
   * Idempotency: dedup by `signal.signal_id` for DEDUP_TTL_MS so a sensor
   * retry-loop or runner restart can't trigger duplicate agent turns.
   */
  private async deliverSignal(handle: ChildHandle, signal: unknown): Promise<void> {
    if (!signal || typeof signal !== "object") {
      this.log(`[w2a/${handle.sensorId}] dropped non-object signal`);
      return;
    }
    const obj = signal as Record<string, unknown>;
    const signalId = typeof obj.signal_id === "string" ? obj.signal_id : undefined;
    if (!signalId) {
      this.log(`[w2a/${handle.sensorId}] dropped signal missing signal_id`);
      return;
    }

    if (this.markSeen(signalId)) {
      this.log(
        `[w2a/${handle.sensorId}] deduped signal ${signalId} (seen within ${DEDUP_TTL_MS}ms)`,
      );
      return;
    }

    const message = renderPrompt(handle.skillId, obj);
    const payload: Record<string, unknown> = {
      message,
      agentId: handle.agentId,
      sessionKey: handle.sessionKey,
    };
    if (handle.model) payload.model = handle.model;
    if (handle.notify) {
      payload.deliver = true;
      payload.channel = handle.notify.channel;
      payload.to = handle.notify.to;
      if (handle.notify.account) payload.account = handle.notify.account;
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.openclaw.hookToken}`,
      // Sent for completeness / future-proofing. Verified empirically that
      // the gateway does not currently use it for idempotency, but we want
      // it in the request log either way.
      "x-request-id": signalId,
    };

    try {
      await httpPost(
        `${this.openclaw.gatewayUrl}/hooks/agent`,
        JSON.stringify(payload),
        headers,
        {
          timeoutMs: DELIVERY_TIMEOUT_MS,
          maxAttempts: DELIVERY_MAX_ATTEMPTS,
          baseDelayMs: DELIVERY_BASE_DELAY_MS,
        },
      );
      this.log(
        `[w2a/${handle.sensorId}] dispatched ${signalId} → sessionKey=${handle.sessionKey}`,
      );
    } catch (error) {
      this.log(
        `[w2a/${handle.sensorId}] POST failed for signal ${signalId}: ${errorMessage(error)}`,
      );
      // Drop dedup entry on failure so a manual retry can go through.
      this.seenSignalIds.delete(signalId);
    }
  }

  private markSeen(signalId: string): boolean {
    const now = Date.now();
    for (const [id, ts] of this.seenSignalIds) {
      if (now - ts > DEDUP_TTL_MS) this.seenSignalIds.delete(id);
    }
    if (this.seenSignalIds.has(signalId)) return true;
    this.seenSignalIds.set(signalId, now);
    if (this.seenSignalIds.size > DEDUP_MAX_ENTRIES) {
      const oldest = this.seenSignalIds.keys().next().value;
      if (oldest) this.seenSignalIds.delete(oldest);
    }
    return false;
  }

  private async handleExit(
    handle: ChildHandle,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    handle.lastExitCode = code;

    const current = this.handles.get(handle.sensorId);
    if (current !== handle) return;

    this.handles.delete(handle.sensorId);
    this.log(
      `[w2a/${handle.sensorId}] exited code=${String(code)} signal=${String(signal)}`,
    );

    if (handle.stopping) return;
    if (code !== null && NO_RESTART_EXIT_CODES.has(code)) return;

    const nextEntry = this.desiredEntries.get(handle.sensorId);
    if (!nextEntry) return;

    const nextRestartCount = handle.restartCount + 1;
    const delayMs = restartDelayMs(nextRestartCount);
    this.log(
      `[w2a/${handle.sensorId}] scheduling restart in ${delayMs}ms (restart #${nextRestartCount})`,
    );

    const timer = setTimeout(() => {
      this.restartTimers.delete(handle.sensorId);
      void this.spawn(nextEntry, nextRestartCount).catch((error) => {
        this.log(
          `[w2a/${handle.sensorId}] restart failed: ${errorMessage(error)}`,
        );
      });
    }, delayMs);
    timer.unref();
    this.restartTimers.set(handle.sensorId, timer);
  }

  private clearRestartTimer(sensorId: string): void {
    const timer = this.restartTimers.get(sensorId);
    if (!timer) return;
    clearTimeout(timer);
    this.restartTimers.delete(sensorId);
  }

  private resolvePackageSpecifier(pkg: string): string {
    if (pkg.startsWith(".") || pkg.startsWith("/") || isAbsolute(pkg)) {
      return pkg;
    }

    try {
      return this.require.resolve(pkg, {
        paths: [this.paths.npmDir],
      });
    } catch {
      return pkg;
    }
  }
}

interface HttpPostOptions {
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
}

/**
 * POST a body with retry on transient failures (network errors and 5xx).
 * 4xx is treated as permanent and propagated immediately.
 */
export async function httpPost(
  url: string,
  body: string,
  headers: Record<string, string>,
  opts: HttpPostOptions,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (error) {
      lastError = error;
      if (attempt < opts.maxAttempts - 1) {
        await delay(opts.baseDelayMs * 2 ** attempt);
      }
      continue;
    }

    if (res.ok) return;

    if (res.status >= 400 && res.status < 500) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    lastError = new Error(`HTTP ${res.status}`);
    if (attempt < opts.maxAttempts - 1) {
      await delay(opts.baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

/**
 * Render a W2A signal into the Markdown body that /hooks/agent receives as
 * `message`. The OpenClaw gateway itself wraps this in a SECURITY-NOTICE +
 * EXTERNAL_UNTRUSTED_CONTENT envelope before the model sees it (verified
 * via spike), so we only need to emit the agent-facing intent here:
 *   - which handler skill to load
 *   - the human-readable summary
 *   - the full signal JSON for the skill to parse when it needs structured
 *     fields
 */
export function renderPrompt(skillId: string, signal: Record<string, unknown>): string {
  const event = (signal.event ?? {}) as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "unknown";
  const summary = typeof event.summary === "string" ? event.summary : "";
  const attachments = Array.isArray(signal.attachments) ? signal.attachments : [];
  const attachmentLines = attachments
    .map((a) => {
      const obj = (a ?? {}) as Record<string, unknown>;
      const media = typeof obj.mime_type === "string" ? obj.mime_type : "text/plain";
      const desc = typeof obj.description === "string" ? obj.description : "";
      const uri = typeof obj.uri === "string" ? obj.uri : "inline";
      return `- ${media} ${desc} (${uri})`.trimEnd();
    })
    .filter(Boolean);

  const parts: string[] = [
    `Use skill: ${skillId}`,
    "",
    "# World2Agent Signal",
    "",
    `Event: ${type}`,
  ];
  if (summary) parts.push(summary);
  if (attachmentLines.length) {
    parts.push("", "Attachments:", ...attachmentLines);
  }
  parts.push("", "Signal JSON:", "```json", JSON.stringify(signal, null, 2), "```");
  return parts.join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...[+${text.length - max}]`;
}

function pipeStream(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): void {
  let buffer = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string | Buffer) => {
    buffer += String(chunk);
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
  });
  stream.on("end", () => {
    const line = buffer.replace(/\r$/, "");
    if (line) onLine(line);
  });
}

function restartDelayMs(restartCount: number): number {
  if (restartCount >= 10) return 60 * 60 * 1000;
  return Math.min(1_000 * 2 ** Math.max(0, restartCount - 1), 300_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
