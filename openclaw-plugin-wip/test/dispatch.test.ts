import { createHmac } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { EmbeddedDispatcher, HttpDispatcher } from "../src/dispatch.js";
import type { EmbeddedAgentRunRequest } from "../src/openclaw/plugin-sdk/types.js";
import type { HttpIngestEnvelope, World2AgentPaths } from "../src/types.js";

const TEST_SIGNAL = {
  signal_id: "sig-1",
  schema_version: "w2a/0.1" as const,
  emitted_at: Date.now(),
  source: {
    sensor_id: "@world2agent/sensor-fake-tick",
    sensor_version: "0.0.1",
    source_type: "fake",
    user_identity: "unknown",
    package: "@world2agent/sensor-fake-tick",
  },
  event: {
    type: "news.item.created",
    occurred_at: Date.now(),
    summary: "A fake tick signal fired for dispatcher tests.",
  },
};

describe("EmbeddedDispatcher", () => {
  it("dispatches via runEmbeddedAgent with `# System Event` framed prompt", async () => {
    const calls: EmbeddedAgentRunRequest[] = [];
    const dispatcher = new EmbeddedDispatcher({
      api: {
        runtime: {
          agent: {
            runEmbeddedAgent: vi.fn(async (request: EmbeddedAgentRunRequest) => {
              calls.push(request);
              return { ok: true };
            }),
          },
          // NO `system` namespace at all → must fall back to embedded path
        },
      },
      openclawConfigRef: {
        current: {
          agents: {
            defaults: { contextInjection: "continuation-skip" },
            list: [],
          },
        },
      },
      pluginConfig: {
        defaultAgentId: "world2agent",
        requestTimeoutMs: 12_345,
        ingestDedupTtlMs: 3_600_000,
      },
      paths: makePaths("/tmp/w2a-openclaw-dispatch-fallback"),
    });

    const result = (await dispatcher.dispatch({
      sensorId: "fake-tick",
      skillId: "world2agent-sensor-fake-tick",
      signal: TEST_SIGNAL,
    })) as { path: string };

    expect(result.path).toBe("embedded");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe("w2a-fake-tick");
    expect(calls[0]?.sessionKey).toBe("agent:world2agent:w2a-fake-tick");
    expect(calls[0]?.prompt.startsWith("# System Event")).toBe(true);
    expect(calls[0]?.prompt).toContain("Use skill: world2agent-sensor-fake-tick");
  });

  it("propagates deliver config to runEmbeddedAgent and persists it on the session entry", async () => {
    const calls: EmbeddedAgentRunRequest[] = [];
    const root = `/tmp/w2a-openclaw-dispatch-deliver-${Date.now()}`;
    const dispatcher = new EmbeddedDispatcher({
      api: {
        runtime: {
          agent: {
            runEmbeddedAgent: vi.fn(async (request: EmbeddedAgentRunRequest) => {
              calls.push(request);
              return { ok: true };
            }),
          },
        },
      },
      openclawConfigRef: {
        current: {
          agents: {
            defaults: { contextInjection: "continuation-skip" },
            list: [],
          },
        },
      },
      pluginConfig: {
        defaultAgentId: "world2agent",
        requestTimeoutMs: 12_345,
        ingestDedupTtlMs: 3_600_000,
        deliver: {
          channel: "feishu",
          to: "oc_chat_abc123",
          accountId: "acct-1",
        },
      },
      paths: makePaths(root),
    });

    await dispatcher.dispatch({
      sensorId: "fake-tick",
      skillId: "world2agent-sensor-fake-tick",
      signal: TEST_SIGNAL,
    });

    expect(calls).toHaveLength(1);
    const req = calls[0] as Record<string, unknown>;
    expect(req.messageChannel).toBe("feishu");
    expect(req.messageTo).toBe("oc_chat_abc123");
    expect(req.agentAccountId).toBe("acct-1");

    const fs = await import("node:fs/promises");
    const storePath = `${root}/.openclaw/agents/world2agent/sessions/sessions.json`;
    const raw = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, unknown>;
    const entry = raw["agent:world2agent:w2a-fake-tick"] as Record<string, unknown>;
    expect(entry.lastChannel).toBe("feishu");
    expect(entry.lastTo).toBe("oc_chat_abc123");
    expect(entry.lastAccountId).toBe("acct-1");
    expect(entry.deliveryContext).toMatchObject({
      channel: "feishu",
      to: "oc_chat_abc123",
      accountId: "acct-1",
    });
  });

  it("uses runtime.subagent.run with deliver:true when deliver is configured AND subagent is exposed", async () => {
    const subagentCalls: Array<Record<string, unknown>> = [];
    const waitCalls: Array<Record<string, unknown>> = [];
    const runEmbedded = vi.fn(async () => ({ ok: true }));
    const root = `/tmp/w2a-openclaw-dispatch-subagent-${Date.now()}`;
    const dispatcher = new EmbeddedDispatcher({
      api: {
        runtime: {
          agent: {
            runEmbeddedAgent: runEmbedded,
          },
          subagent: {
            run: vi.fn(async (params: Record<string, unknown>) => {
              subagentCalls.push(params);
              return { runId: "run-abc" };
            }),
            waitForRun: vi.fn(async (params: Record<string, unknown>) => {
              waitCalls.push(params);
              return { status: "ok" };
            }),
          },
        },
      },
      openclawConfigRef: {
        current: {
          agents: {
            defaults: { contextInjection: "continuation-skip" },
            list: [],
          },
        },
      },
      pluginConfig: {
        defaultAgentId: "world2agent",
        requestTimeoutMs: 12_345,
        ingestDedupTtlMs: 3_600_000,
        deliver: { channel: "feishu", to: "oc_chat_xxx" },
      },
      paths: makePaths(root),
    });

    const result = (await dispatcher.dispatch({
      sensorId: "fake-tick",
      skillId: "world2agent-sensor-fake-tick",
      signal: TEST_SIGNAL,
    })) as { path: string; result: { runId: string } };

    expect(result.path).toBe("subagent");
    expect(result.result.runId).toBe("run-abc");
    expect(subagentCalls).toHaveLength(1);
    expect(subagentCalls[0]?.sessionKey).toBe("agent:world2agent:w2a-fake-tick");
    expect(subagentCalls[0]?.deliver).toBe(true);
    expect((subagentCalls[0]?.message as string).startsWith("# System Event")).toBe(true);
    // Per-call provider/model overrides are rejected by OpenClaw's plugin
    // subagent runtime — we MUST NOT pass them; the runtime resolves the
    // provider/model from agent defaults instead.
    expect(subagentCalls[0]).not.toHaveProperty("provider");
    expect(subagentCalls[0]).not.toHaveProperty("model");
    expect(waitCalls).toHaveLength(1);
    expect(waitCalls[0]?.runId).toBe("run-abc");
    // runEmbeddedAgent must NOT be invoked when subagent path is taken
    expect(runEmbedded).not.toHaveBeenCalled();

    // Session entry still gets deliveryContext written so the runtime can
    // resolve the channel target inside subagent.run.
    const fs = await import("node:fs/promises");
    const storePath = `${root}/.openclaw/agents/world2agent/sessions/sessions.json`;
    const raw = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, unknown>;
    const entry = raw["agent:world2agent:w2a-fake-tick"] as Record<string, unknown>;
    expect(entry.lastChannel).toBe("feishu");
    expect(entry.lastTo).toBe("oc_chat_xxx");
  });

  it("per-sensor deliver in dispatch input overrides plugin default", async () => {
    const calls: EmbeddedAgentRunRequest[] = [];
    const dispatcher = new EmbeddedDispatcher({
      api: {
        runtime: {
          agent: {
            runEmbeddedAgent: vi.fn(async (request: EmbeddedAgentRunRequest) => {
              calls.push(request);
              return { ok: true };
            }),
          },
        },
      },
      openclawConfigRef: {
        current: {
          agents: {
            defaults: { contextInjection: "continuation-skip" },
            list: [],
          },
        },
      },
      pluginConfig: {
        defaultAgentId: "world2agent",
        requestTimeoutMs: 12_345,
        ingestDedupTtlMs: 3_600_000,
        deliver: { channel: "feishu", to: "default-chat" },
      },
      paths: makePaths(`/tmp/w2a-openclaw-dispatch-override-${Date.now()}`),
    });

    await dispatcher.dispatch({
      sensorId: "fake-tick",
      skillId: "world2agent-sensor-fake-tick",
      signal: TEST_SIGNAL,
      deliver: { channel: "telegram", to: "user-42" },
    });

    expect(calls).toHaveLength(1);
    const req = calls[0] as Record<string, unknown>;
    expect(req.messageChannel).toBe("telegram");
    expect(req.messageTo).toBe("user-42");
  });
});

describe("HttpDispatcher", () => {
  it("validates HMAC and dedups X-Request-ID", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const http = new HttpDispatcher({
      embeddedDispatcher: { dispatch },
      hmacSecret: "secret",
      dedupTtlMs: 60_000,
    });

    const payload: HttpIngestEnvelope = {
      sensor_id: "fake-tick",
      skill_id: "world2agent-sensor-fake-tick",
      signal: TEST_SIGNAL,
    };
    const body = JSON.stringify(payload);
    const signature = createHmac("sha256", "secret").update(body).digest("hex");

    const first = await invokeRoute(http, body, "req-1", signature);
    const second = await invokeRoute(http, body, "req-1", signature);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.body).toContain("\"deduped\": true");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

async function invokeRoute(
  http: HttpDispatcher,
  body: string,
  requestId: string,
  signature: string,
): Promise<{ statusCode: number; body: string }> {
  const req = new PassThrough() as PassThrough & {
    headers: Record<string, string>;
    method: string;
  };
  req.headers = {
    "x-request-id": requestId,
    "x-webhook-signature": signature,
  };
  req.method = "POST";
  req.end(body);

  let responseBody = "";
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((value?: string) => {
      responseBody = value ?? "";
    }),
  };

  await http.handle(req as any, res as any);

  return {
    statusCode: res.statusCode,
    body: responseBody,
  };
}

function makePaths(root: string): World2AgentPaths {
  return {
    baseDir: root,
    manifestFile: `${root}/sensors.json`,
    stateDir: `${root}/state`,
    sessionDir: `${root}/sessions`,
    openclawHome: `${root}/.openclaw`,
    openclawSkillsDir: `${root}/.openclaw/skills`,
    ingestHmacSecretFile: `${root}/.secret`,
  };
}

