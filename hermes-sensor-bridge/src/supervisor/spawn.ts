import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { BridgePaths, SensorEntry } from "./manifest.js";
import { hashConfig } from "./manifest.js";

export interface ChildHandle {
  sensorId: string;
  pkg: string;
  skillId: string;
  configHash: string;
  webhookUrl: string;
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
  webhook_url: string;
  config_hash: string;
  pid: number | undefined;
  started_at: number;
  restart_count: number;
  last_exit_code: number | null;
}

interface SensorSupervisorOptions {
  paths: BridgePaths;
  hmacSecret: string;
  log: (line: string) => void;
}

// Exit codes the runner produces deliberately and which should NOT trigger
// a backoff restart loop:
//   0  = clean shutdown (SIGTERM after cleanup)
//   10 = config parse failure
//   11 = sensor package import / SensorSpec validation failure
const NO_RESTART_EXIT_CODES = new Set([0, 10, 11]);

export class SensorSupervisor {
  private readonly paths: BridgePaths;
  private readonly hmacSecret: string;
  private readonly log: (line: string) => void;
  private readonly handles = new Map<string, ChildHandle>();
  private readonly desiredEntries = new Map<string, SensorEntry>();
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();
  private readonly runnerBin = fileURLToPath(new URL("../runner/bin.js", import.meta.url));

  constructor(options: SensorSupervisorOptions) {
    this.paths = options.paths;
    this.hmacSecret = options.hmacSecret;
    this.log = options.log;
  }

  snapshot(): HandleSnapshot[] {
    return [...this.handles.values()]
      .map((handle) => ({
        sensor_id: handle.sensorId,
        pkg: handle.pkg,
        skill_id: handle.skillId,
        webhook_url: handle.webhookUrl,
        config_hash: handle.configHash,
        pid: handle.process.pid,
        started_at: handle.startedAt,
        restart_count: handle.restartCount,
        last_exit_code: handle.lastExitCode,
      }))
      .sort((a, b) => a.sensor_id.localeCompare(b.sensor_id));
  }

  async spawn(entry: SensorEntry, restartCount = 0): Promise<ChildHandle> {
    this.clearRestartTimer(entry.sensor_id);

    // The runner does not need webhook URL or HMAC secret — those live in
    // the supervisor where signal delivery happens. Keeping secrets out of
    // the child env reduces leak surface.
    const proc = spawn(process.execPath, [this.runnerBin], {
      env: {
        ...process.env,
        W2A_PACKAGE: entry.pkg,
        W2A_SENSOR_ID: entry.sensor_id,
        W2A_STATE_PATH: `${this.paths.stateDir}/${entry.sensor_id}.json`,
        W2A_LOG_LEVEL: process.env.W2A_LOG_LEVEL ?? "info",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const handle: ChildHandle = {
      sensorId: entry.sensor_id,
      pkg: entry.pkg,
      skillId: entry.skill_id,
      configHash: hashConfig(entry.config),
      webhookUrl: entry.webhook_url,
      process: proc,
      startedAt: Date.now(),
      restartCount,
      lastExitCode: null,
      stopping: false,
    };

    this.handles.set(entry.sensor_id, handle);
    this.attachChildStreams(handle);
    proc.on("exit", (code, signal) => {
      void this.handleExit(handle, code, signal);
    });

    proc.stdin.end(JSON.stringify(entry.config ?? {}) + "\n");
    this.log(
      `[w2a/${entry.sensor_id}] spawned pid=${proc.pid ?? "unknown"} pkg=${entry.pkg}`,
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

  async applyConfig(entries: SensorEntry[]): Promise<ApplyResult> {
    const result: ApplyResult = {
      started: [],
      restarted: [],
      stopped: [],
      failed: [],
    };

    this.desiredEntries.clear();
    for (const entry of entries) {
      if (entry.enabled !== false) {
        this.desiredEntries.set(entry.sensor_id, entry);
      }
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

  async terminateAll(graceMs = 5_000): Promise<void> {
    this.desiredEntries.clear();
    for (const sensorId of this.restartTimers.keys()) {
      this.clearRestartTimer(sensorId);
    }
    for (const handle of [...this.handles.values()]) {
      await this.terminate(handle, graceMs);
    }
  }

  private matchesEntry(handle: ChildHandle, entry: SensorEntry): boolean {
    return (
      handle.pkg === entry.pkg &&
      handle.skillId === entry.skill_id &&
      handle.webhookUrl === entry.webhook_url &&
      handle.configHash === hashConfig(entry.config)
    );
  }

  private attachChildStreams(handle: ChildHandle): void {
    // stdout: every line is a W2A signal as JSON. Parse and dispatch.
    pipeStream(handle.process.stdout, (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
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
   * Render a signal into a Hermes-shaped POST and ship it to the route
   * recorded for this sensor. Retries on 5xx / network errors, fails fast
   * on 4xx (including 401 from a HMAC mismatch — those are configuration
   * problems, not transient).
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

    const body = JSON.stringify({
      prompt: renderPrompt(obj),
      signal: obj,
    });

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-request-id": signalId,
    };
    if (this.hmacSecret && this.hmacSecret !== "INSECURE_NO_AUTH") {
      headers["x-webhook-signature"] = createHmac("sha256", this.hmacSecret)
        .update(body)
        .digest("hex");
    }

    try {
      await httpPost(handle.webhookUrl, body, headers, {
        timeoutMs: DELIVERY_TIMEOUT_MS,
        maxAttempts: DELIVERY_MAX_ATTEMPTS,
        baseDelayMs: DELIVERY_BASE_DELAY_MS,
      });
    } catch (error) {
      this.log(
        `[w2a/${handle.sensorId}] POST failed for signal ${signalId}: ${errorMessage(error)}`,
      );
    }
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
}

const DELIVERY_TIMEOUT_MS = 10_000;
const DELIVERY_MAX_ATTEMPTS = 3; // initial + 2 retries
const DELIVERY_BASE_DELAY_MS = 500;

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
 * Render a W2A signal into a Markdown prompt body that the Hermes-side
 * skill can read directly. The full signal is appended as a fenced JSON
 * block so the skill can parse structured fields when it needs to.
 */
export function renderPrompt(signal: Record<string, unknown>): string {
  const event = (signal.event ?? {}) as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "unknown";
  const summary = typeof event.summary === "string" ? event.summary : "";
  const attachments = Array.isArray(signal.attachments) ? signal.attachments : [];
  const attachmentLines = attachments
    .map((a) => {
      const obj = (a ?? {}) as Record<string, unknown>;
      const media = typeof obj.media_type === "string" ? obj.media_type : "text/plain";
      const title = typeof obj.title === "string" ? obj.title : "";
      return `[${media}] ${title}`.trimEnd();
    })
    .filter(Boolean);

  const parts: string[] = [`[W2A Signal] ${type}`, ""];
  if (summary) parts.push(summary, "");
  if (attachmentLines.length) {
    parts.push("Attachments:", ...attachmentLines, "");
  }
  parts.push("Signal JSON:", "```json", JSON.stringify(signal, null, 2), "```");
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
