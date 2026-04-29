import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { hasDedicatedAgentSkillsAllowlist } from "./config.js";
import { renderSignalPrompt } from "./prompt.js";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
} from "./openclaw/plugin-sdk/types.js";
import type {
  Dispatcher,
  DispatcherDispatchInput,
  EmbeddedDispatcherOptions,
  HttpDispatcherOptions,
  HttpIngestEnvelope,
} from "./types.js";

const RUN_EMBEDDED_AGENT_ERROR =
  "OpenClaw runtime is missing api.runtime.agent.runEmbeddedAgent. Verify the " +
  "plugin is running inside a live OpenClaw gateway.";

export function assertEmbeddedAgentRuntime(options: EmbeddedDispatcherOptions): void {
  if (typeof options.api.runtime?.agent?.runEmbeddedAgent !== "function") {
    throw new Error(RUN_EMBEDDED_AGENT_ERROR);
  }
}

export class EmbeddedDispatcher implements Dispatcher {
  private readonly options: EmbeddedDispatcherOptions;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: EmbeddedDispatcherOptions) {
    assertEmbeddedAgentRuntime(options);
    this.options = options;
  }

  async dispatch(input: DispatcherDispatchInput): Promise<unknown> {
    // OpenClaw enforces SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
    // colons aren't allowed in sessionId. sessionKey is the colon-namespaced lane.
    const sessionId = input.sessionId ?? `w2a-${sanitizeSessionId(input.sensorId)}`;
    const previous = this.queues.get(sessionId) ?? Promise.resolve();

    const next = previous
      .catch(() => undefined)
      .then(() => this.dispatchNow(input, sessionId));

    this.queues.set(sessionId, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(sessionId) === next) {
        this.queues.delete(sessionId);
      }
    }
  }

  private async dispatchNow(
    input: DispatcherDispatchInput,
    sessionId: string,
  ): Promise<unknown> {
    const signalText = renderSignalPrompt(input.signal, {
      skillId: input.skillId,
      useSkillPrefix: !hasDedicatedAgentSkillsAllowlist(
        this.options.openclawConfigRef.current,
        this.options.pluginConfig.defaultAgentId,
      ),
    });

    const config = this.options.openclawConfigRef.current;
    const api = this.options.api;
    const runtimeAgent = api.runtime?.agent;
    const agentId = this.options.pluginConfig.defaultAgentId ?? "main";
    // sessionKey is the colon-namespaced lane OpenClaw uses for system-event
    // routing and heartbeat targeting. `agent:<agentId>:<sessionId>` matches
    // OpenClaw's standard shape (e.g. main agent's chat is `agent:main:main`).
    const sessionKey = `agent:${agentId}:${sessionId}`;
    const openclawHome = this.options.paths.openclawHome;
    const agentDir =
      tryCall(() => runtimeAgent?.resolveAgentDir?.(config, agentId)) ??
      join(openclawHome, "agents", agentId);

    const sessionsApi = runtimeAgent?.session;
    const sessionFile =
      tryCall(() =>
        sessionsApi?.resolveSessionFilePath?.(sessionId, undefined, { agentId }),
      ) ?? join(agentDir, "sessions", `${sessionId}.jsonl`);

    const { provider, model } = resolveProviderAndModel(
      config,
      this.options.pluginConfig,
    );

    // ─────────────────────────────────────────────────────────────────
    //  Dispatch via runEmbeddedAgent + `# System Event` prompt prefix.
    //
    //  Originally we tried OpenClaw's enqueueSystemEvent + requestHeartbeatNow
    //  to inject the signal as a true system message (matching the spirit of
    //  claude-code-channel's `notifications/claude/channel`). In OpenClaw
    //  2026.4.26 that path *does* spawn a turn and *does* drain the queued
    //  event — but `drainFormattedSystemEvents` materializes the event as a
    //  text block prefixed with `System:` lines and **injects it into the
    //  user-role prompt**, not into a real system message. Net result: the
    //  signal still occupies user-role position in the transcript, just
    //  prefixed with the literal characters "System:".
    //
    //  Until OpenClaw exposes a plugin API that writes a true system-role
    //  message, we use runEmbeddedAgent and frame the prompt inline. The
    //  agent treats the `# System Event` block as an external notification
    //  thanks to the framing, even though it lives in user-role position.
    // ─────────────────────────────────────────────────────────────────
    if (typeof runtimeAgent?.runEmbeddedAgent !== "function") {
      throw new Error(
        "OpenClaw runtime does not expose runEmbeddedAgent — this plugin cannot dispatch signals against this OpenClaw version.",
      );
    }

    const workspaceDir =
      this.options.pluginConfig.workspaceDir ??
      tryCall(() => runtimeAgent.resolveAgentWorkspaceDir?.(config, agentId)) ??
      join(openclawHome, "workspace");
    const timeoutMs =
      this.options.pluginConfig.requestTimeoutMs ??
      tryCall(() => runtimeAgent.resolveAgentTimeoutMs?.(config)) ??
      120_000;

    await ensureSessionRegistered({
      api,
      agentId,
      sessionId,
      sessionKey,
      sessionFile,
      sensorId: input.sensorId,
      provider,
      model,
    });

    const promptForTurn =
      "# System Event\n\n" +
      "The following is an external event delivered by a World2Agent sensor. " +
      "It is NOT a user request — do not address the user as if they typed " +
      "this message. Load the referenced skill and apply its rules: the skill " +
      "owns the policy for when to reply, how to format, and when to stay " +
      "quiet. Defer to the skill, not to your own judgment about relevance.\n\n" +
      "---\n\n" +
      signalText;

    const result = await runtimeAgent.runEmbeddedAgent!({
      sessionId,
      sessionKey,
      agentId,
      runId: randomUUID(),
      sessionFile,
      workspaceDir,
      agentDir,
      config,
      prompt: promptForTurn,
      timeoutMs,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    } as Parameters<NonNullable<typeof runtimeAgent.runEmbeddedAgent>>[0]);

    await mirrorIsolatedSessionFiles(agentDir, sessionId).catch(() => undefined);
    await ensureSessionRegistered({
      api,
      agentId,
      sessionId,
      sessionKey,
      sessionFile,
      sensorId: input.sensorId,
      provider,
      model,
    }).catch(() => undefined);

    return { ok: true, path: "embedded", result };
  }
}

async function ensureSessionRegistered(params: {
  api: OpenClawPluginApi;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  sensorId: string;
  provider?: string;
  model?: string;
}): Promise<void> {
  const now = Date.now();

  // Build the entry once, used by both paths below.
  const entryFor = (existing?: Record<string, unknown>): Record<string, unknown> =>
    existing
      ? { ...existing, updatedAt: now, lastInteractionAt: now }
      : {
          sessionId: params.sessionId,
          sessionFile: params.sessionFile,
          sessionStartedAt: now,
          startedAt: now,
          updatedAt: now,
          lastInteractionAt: now,
          endedAt: null,
          status: "idle",
          origin: "world2agent",
          chatType: "embedded",
          lastChannel: "world2agent",
          agentHarnessId: "claude-cli",
          ...(params.model ? { model: params.model } : {}),
          ...(params.provider ? { modelProvider: params.provider } : {}),
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          contextTokens: 0,
          runtimeMs: 0,
        };

  // Try OpenClaw's session-store API first (preferred — it integrates with
  // OpenClaw's in-memory caches). Best-effort; if it silently no-ops or
  // throws we still get the file via the unconditional direct write below.
  const sessionsApi = params.api.runtime?.agent?.session;
  const load = sessionsApi?.loadSessionStore;
  const save = sessionsApi?.saveSessionStore;
  if (typeof load === "function" && typeof save === "function") {
    try {
      const store = (await load(params.agentId)) as Record<string, unknown>;
      store[params.sessionKey] = entryFor(
        store[params.sessionKey] as Record<string, unknown> | undefined,
      );
      await save(params.agentId, store);
    } catch {
      // ignore — direct write below is the source of truth
    }
  }

  // ALWAYS write sessions.json directly. OpenClaw's `openclaw sessions
  // --agent <id>` and the dashboard read this file; a plugin-side
  // saveSessionStore call is opaque and can no-op silently in some
  // OpenClaw versions, so we don't trust it as the only mechanism.
  const sessionFileDir = dirname(params.sessionFile);
  const storePath = join(sessionFileDir, "sessions.json");
  let raw: Record<string, unknown> = {};
  try {
    const fs = await import("node:fs/promises");
    const txt = await fs.readFile(storePath, "utf8");
    raw = JSON.parse(txt) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  raw[params.sessionKey] = entryFor(
    raw[params.sessionKey] as Record<string, unknown> | undefined,
  );
  await mkdir(sessionFileDir, { recursive: true });
  await writeFile(storePath, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

async function mirrorIsolatedSessionFiles(
  agentDir: string,
  sessionId: string,
): Promise<void> {
  // runEmbeddedAgent writes to `<agentDir>/agent/sessions/<id>.{jsonl,trajectory.jsonl,trajectory-path.json}`.
  // OpenClaw's user-facing session viewer reads from `<agentDir>/sessions/<id>.jsonl`.
  // Mirror the three files so the dashboard can render the conversation.
  const isolatedDir = join(agentDir, "agent", "sessions");
  const standardDir = join(agentDir, "sessions");
  await mkdir(standardDir, { recursive: true });
  for (const suffix of [".jsonl", ".trajectory.jsonl", ".trajectory-path.json"] as const) {
    const src = join(isolatedDir, `${sessionId}${suffix}`);
    const dst = join(standardDir, `${sessionId}${suffix}`);
    try {
      await copyFile(src, dst);
    } catch {
      // best-effort; missing files are fine for sessions that haven't been
      // written yet (e.g. early failure in runEmbeddedAgent).
    }
  }
  // Rewrite the trajectory pointer so it references the canonical path.
  try {
    const ptrPath = join(standardDir, `${sessionId}.trajectory-path.json`);
    const fs = await import("node:fs/promises");
    const ptrText = await fs.readFile(ptrPath, "utf8");
    const ptr = JSON.parse(ptrText) as Record<string, unknown>;
    ptr.runtimeFile = join(standardDir, `${sessionId}.trajectory.jsonl`);
    await fs.writeFile(ptrPath, JSON.stringify(ptr, null, 2), "utf8");
  } catch {
    // ignore — pointer is non-critical
  }
}

export class CliDispatcher implements Dispatcher {
  async dispatch(_input: DispatcherDispatchInput): Promise<unknown> {
    // TODO: Keep this as an escape hatch only; do not make it load-bearing.
    throw new Error("CliDispatcher is not implemented in M4 skeleton");
  }
}

export class HttpDispatcher {
  private readonly embeddedDispatcher: Dispatcher;
  private readonly hmacSecret: string;
  private readonly dedup = new RequestDeduper();
  private readonly dedupTtlMs: number;

  constructor(options: HttpDispatcherOptions) {
    this.embeddedDispatcher = options.embeddedDispatcher;
    this.hmacSecret = options.hmacSecret;
    this.dedupTtlMs = options.dedupTtlMs;
  }

  createRoute() {
    return {
      path: "/w2a/ingest",
      auth: "plugin" as const,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        await this.handle(req, res);
      },
    };
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }

    const body = await readBody(req);
    if (!this.verifyHmac(body, req.headers["x-webhook-signature"])) {
      writeJson(res, 401, { ok: false, error: "invalid signature" });
      return;
    }

    const requestId = req.headers["x-request-id"];
    if (typeof requestId !== "string" || requestId.trim() === "") {
      writeJson(res, 400, { ok: false, error: "missing X-Request-ID" });
      return;
    }
    if (this.dedup.seen(requestId, this.dedupTtlMs)) {
      writeJson(res, 202, { ok: true, deduped: true });
      return;
    }

    let payload: HttpIngestEnvelope;
    try {
      payload = JSON.parse(body) as HttpIngestEnvelope;
    } catch (error) {
      writeJson(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    await this.embeddedDispatcher.dispatch({
      sensorId: payload.sensor_id,
      skillId: payload.skill_id,
      signal: payload.signal,
    });

    writeJson(res, 202, { ok: true });
  }

  private verifyHmac(body: string, signatureHeader: string | string[] | undefined): boolean {
    if (typeof signatureHeader !== "string") return false;
    const expected = Buffer.from(
      createHmac("sha256", this.hmacSecret).update(body).digest("hex"),
      "hex",
    );
    const got = Buffer.from(signatureHeader, "hex");
    return expected.length === got.length && timingSafeEqual(expected, got);
  }
}

class RequestDeduper {
  private readonly seenAt = new Map<string, number>();

  seen(id: string, ttlMs: number): boolean {
    const now = Date.now();
    this.prune(now, ttlMs);
    if (this.seenAt.has(id)) {
      return true;
    }
    this.seenAt.set(id, now);
    if (this.seenAt.size > 1_024) {
      const oldest = this.seenAt.keys().next().value;
      if (oldest) this.seenAt.delete(oldest);
    }
    return false;
  }

  private prune(now: number, ttlMs: number): void {
    for (const [id, seenAt] of this.seenAt) {
      if (now - seenAt > ttlMs) {
        this.seenAt.delete(id);
      }
    }
  }
}

function sanitizeSessionId(value: string): string {
  // OpenClaw SAFE_SESSION_ID_RE: /^[a-z0-9][a-z0-9._-]{0,127}$/i. Map invalid
  // chars to "-" (allowed) rather than "_" (also allowed but mixed-style).
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function tryCall<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function resolveProviderAndModel(
  config: OpenClawConfig,
  pluginConfig: { provider?: string; model?: string },
): { provider?: string; model?: string } {
  if (pluginConfig.provider && pluginConfig.model) {
    return { provider: pluginConfig.provider, model: pluginConfig.model };
  }
  const primary = config.agents?.defaults?.model?.primary;
  if (typeof primary === "string") {
    const slash = primary.indexOf("/");
    if (slash > 0) {
      return {
        provider: pluginConfig.provider ?? primary.slice(0, slash),
        model: pluginConfig.model ?? primary.slice(slash + 1),
      };
    }
  }
  return { provider: pluginConfig.provider, model: pluginConfig.model };
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString();
  }
  return raw;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, null, 2));
}
