#!/usr/bin/env node
/**
 * Smoke test for the supervisor's delivery contract without binding a local
 * socket. Stubs `globalThis.fetch` and validates the same wire-level shape
 * the supervisor sends to /hooks/agent:
 *
 *   1. URL is `<gatewayUrl>/hooks/agent`.
 *   2. Body is `{message, agentId, sessionKey, ...}`.
 *      `message` ends with a JSON code fence containing the original signal.
 *   3. `Authorization: Bearer <hookToken>` is set.
 *   4. `x-request-id` equals signal.signal_id (best-effort traceability;
 *      OpenClaw doesn't dedup by it but we still send it).
 *   5. 5xx triggers retry; 4xx fails immediately.
 */

import { httpPost, renderPrompt } from "../dist/supervisor/spawn.js";

let failures = 0;
function check(label, cond, detail) {
  const ok = !!cond;
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${label}\n`);
  if (!ok) {
    failures++;
    if (detail !== undefined) process.stdout.write(`     ${detail}\n`);
  }
}

const ORIGINAL_FETCH = globalThis.fetch;
const TOKEN = "test-bearer-token-deadbeef";
const GATEWAY = "http://example.test:18789";

function withFetchStub(stub, fn) {
  globalThis.fetch = stub;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = ORIGINAL_FETCH;
    });
}

const fakeSignal = {
  signal_id: "test-sig-456",
  schema_version: "1.0.0",
  source: {
    source_type: "test-fake",
    source_id: "test-sensor",
    emitted_at: "2026-04-29T12:00:00Z",
  },
  event: {
    type: "news.story.trending",
    summary: "Test story summary",
    occurred_at: "2026-04-29T12:00:00Z",
  },
  attachments: [{ mime_type: "text/markdown", description: "body", uri: "inline" }],
};

// ─── case 1: happy path ────────────────────────────────────────────────────
await withFetchStub(async () => new Response('{"ok":true,"runId":"x"}', { status: 200 }), async () => {
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response('{"ok":true,"runId":"x"}', { status: 200 });
  };

  const message = renderPrompt("test-skill", fakeSignal);
  const body = JSON.stringify({
    message,
    agentId: "main",
    sessionKey: "w2a:test-sensor",
  });
  await httpPost(
    `${GATEWAY}/hooks/agent`,
    body,
    {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      "x-request-id": fakeSignal.signal_id,
    },
    { timeoutMs: 5_000, maxAttempts: 1, baseDelayMs: 100 },
  );

  check("happy: fetch called", !!captured);
  check(
    "happy: URL is <gateway>/hooks/agent",
    captured?.url === `${GATEWAY}/hooks/agent`,
    `got: ${captured?.url}`,
  );
  check(
    "happy: Authorization Bearer header present",
    captured?.init?.headers?.authorization === `Bearer ${TOKEN}`,
    `got: ${captured?.init?.headers?.authorization}`,
  );
  check(
    "happy: x-request-id == signal.signal_id",
    captured?.init?.headers?.["x-request-id"] === fakeSignal.signal_id,
  );

  const parsed = JSON.parse(captured.init.body);
  check(
    "happy: body has message/agentId/sessionKey",
    typeof parsed.message === "string" && parsed.agentId === "main" && parsed.sessionKey === "w2a:test-sensor",
  );
  check(
    "happy: message starts with `Use skill: <id>` directive",
    parsed.message.startsWith("Use skill: test-skill\n"),
  );
  check(
    "happy: message has type + summary",
    parsed.message.includes("news.story.trending") &&
      parsed.message.includes("Test story summary"),
  );
  check(
    "happy: message ends with JSON code fence containing signal",
    /```json[\s\S]*"signal_id": "test-sig-456"[\s\S]*```/.test(parsed.message),
  );
});

// ─── case 2: 4xx (e.g. bad sessionKey prefix) — fail fast, no retry ────────
await withFetchStub(async () => new Response("bad request", { status: 400 }), async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("sessionKey must start with one of: w2a:", { status: 400 });
  };

  let threw = false;
  try {
    await httpPost(
      `${GATEWAY}/hooks/agent`,
      "{}",
      { authorization: `Bearer ${TOKEN}` },
      { timeoutMs: 2_000, maxAttempts: 3, baseDelayMs: 10 },
    );
  } catch (error) {
    threw = true;
    check("4xx: error mentions 400", String(error).includes("400"));
  }
  check("4xx: throws", threw);
  check("4xx: only one call (no retry)", calls === 1);
});

// ─── case 3: 5xx — retry up to maxAttempts, eventually throws ──────────────
await withFetchStub(async () => new Response("flaky", { status: 503 }), async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("flaky", { status: 503 });
  };

  let threw = false;
  try {
    await httpPost(
      `${GATEWAY}/hooks/agent`,
      "{}",
      { authorization: `Bearer ${TOKEN}` },
      { timeoutMs: 2_000, maxAttempts: 3, baseDelayMs: 10 },
    );
  } catch (error) {
    threw = true;
    check("5xx: error mentions 503", String(error).includes("503"));
  }
  check("5xx: throws after retries", threw);
  check("5xx: called maxAttempts times", calls === 3, `calls=${calls}`);
});

// ─── case 4: 5xx then 200 — retry succeeds ─────────────────────────────────
await withFetchStub(async () => new Response("ok", { status: 200 }), async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls < 2
      ? new Response("flaky", { status: 503 })
      : new Response('{"ok":true,"runId":"x"}', { status: 200 });
  };

  await httpPost(
    `${GATEWAY}/hooks/agent`,
    "{}",
    { authorization: `Bearer ${TOKEN}` },
    { timeoutMs: 2_000, maxAttempts: 3, baseDelayMs: 10 },
  );
  check("5xx-then-200: succeeded after retry", true);
  check("5xx-then-200: exactly 2 calls", calls === 2, `calls=${calls}`);
});

if (failures > 0) {
  process.stderr.write(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}
process.stdout.write("\nAll checks passed.\n");
