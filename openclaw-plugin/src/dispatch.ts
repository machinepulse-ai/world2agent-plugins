import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { hasDedicatedAgentSkillsAllowlist } from "./config.js";
import { renderSignalPrompt } from "./prompt.js";
import type { OpenClawConfig } from "./openclaw/plugin-sdk/types.js";
import type {
  Dispatcher,
  DispatcherDispatchInput,
  EmbeddedDispatcherOptions,
  HttpDispatcherOptions,
  HttpIngestEnvelope,
} from "./types.js";

const RUN_EMBEDDED_AGENT_ERROR =
  "M0 spike unverified: api.runtime.agent.runEmbeddedAgent not found — verify against a live OpenClaw install";

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
    const prompt = renderSignalPrompt(input.signal, {
      skillId: input.skillId,
      useSkillPrefix: !hasDedicatedAgentSkillsAllowlist(
        this.options.openclawConfigRef.current,
        this.options.pluginConfig.defaultAgentId,
      ),
    });

    const config = this.options.openclawConfigRef.current;
    const runtimeAgent = this.options.api.runtime!.agent!;
    const agentId = this.options.pluginConfig.defaultAgentId ?? "main";
    const sessionKey = `w2a:${input.sensorId}`;
    const openclawHome = this.options.paths.openclawHome;
    const workspaceDir =
      this.options.pluginConfig.workspaceDir ??
      tryCall(() => runtimeAgent.resolveAgentWorkspaceDir?.(config, agentId)) ??
      join(openclawHome, "workspace");
    const agentDir =
      tryCall(() => runtimeAgent.resolveAgentDir?.(config, agentId)) ??
      join(openclawHome, "agents", agentId);
    const sessionFile = join(agentDir, "sessions", `${sessionId}.jsonl`);
    const timeoutMs =
      this.options.pluginConfig.requestTimeoutMs ??
      tryCall(() => runtimeAgent.resolveAgentTimeoutMs?.(config)) ??
      120_000;

    // OpenClaw's runEmbeddedAgent silently defaults to "openai/gpt-5.4" when
    // provider/model are absent — it does NOT read agents.defaults.model.primary.
    // Resolve the effective default ourselves so signal-driven runs follow the
    // operator's configured model.
    const { provider, model } = resolveProviderAndModel(
      config,
      this.options.pluginConfig,
    );

    return runtimeAgent.runEmbeddedAgent!({
      sessionId,
      sessionKey,
      agentId,
      runId: randomUUID(),
      sessionFile,
      workspaceDir,
      agentDir,
      config,
      prompt,
      timeoutMs,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    } as Parameters<NonNullable<typeof runtimeAgent.runEmbeddedAgent>>[0]);
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
