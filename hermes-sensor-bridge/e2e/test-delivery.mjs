#!/usr/bin/env node
/**
 * Smoke test for the supervisor's delivery worker. Stands up a tiny
 * http.createServer that mimics the contract Hermes's webhook adapter
 * imposes (HMAC raw-hex match + body shape + X-Request-ID), then drives
 * `httpPost` and `renderPrompt` directly to verify:
 *
 *   1. Body has shape `{ prompt, signal }` with prompt ending in a JSON
 *      code fence containing the original signal.
 *   2. X-Request-ID equals signal.signal_id.
 *   3. X-Webhook-Signature is the HMAC-SHA256 of the body, raw hex (no
 *      `sha256=` prefix).
 *   4. 5xx triggers retry; 4xx fails immediately.
 *
 * Usage:
 *   node e2e/test-delivery.mjs
 */

import { createServer } from "node:http";
import { createHmac } from "node:crypto";
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

const SECRET = "test-secret-deadbeef";

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      let buf = "";
      for await (const chunk of req) buf += chunk;
      handler(req, buf, res);
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      resolve({ srv, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

const fakeSignal = {
  signal_id: "test-sig-123",
  schema_version: "0.1.0",
  source: { sensor_id: "test-sensor" },
  event: {
    type: "news.story.trending",
    summary: "Test story summary",
    occurred_at: "2026-04-27T12:00:00Z",
  },
  attachments: [{ media_type: "text/markdown", title: "body" }],
};

// case 1: happy path — verify body, headers, prompt shape
{
  let captured;
  const { srv, url } = await startServer((req, body, res) => {
    captured = { headers: req.headers, body };
    res.statusCode = 202;
    res.end("ok");
  });
  try {
    const body = JSON.stringify({
      prompt: renderPrompt(fakeSignal),
      signal: fakeSignal,
    });
    const sig = createHmac("sha256", SECRET).update(body).digest("hex");
    await httpPost(
      url,
      body,
      {
        "content-type": "application/json",
        "x-request-id": fakeSignal.signal_id,
        "x-webhook-signature": sig,
      },
      { timeoutMs: 5_000, maxAttempts: 1, baseDelayMs: 100 },
    );

    check("happy: server received POST", !!captured);
    check(
      "happy: x-request-id == signal.signal_id",
      captured.headers["x-request-id"] === fakeSignal.signal_id,
    );
    check(
      "happy: x-webhook-signature is raw hex (no sha256= prefix)",
      typeof captured.headers["x-webhook-signature"] === "string" &&
        /^[0-9a-f]{64}$/.test(captured.headers["x-webhook-signature"]),
      `got: ${captured.headers["x-webhook-signature"]}`,
    );
    check(
      "happy: signature matches recomputed HMAC",
      captured.headers["x-webhook-signature"] === sig,
    );

    const parsed = JSON.parse(captured.body);
    check("happy: body has prompt + signal", typeof parsed.prompt === "string" && !!parsed.signal);
    check(
      "happy: signal in body matches input",
      parsed.signal.signal_id === fakeSignal.signal_id,
    );
    check(
      "happy: prompt body has type + summary",
      parsed.prompt.includes("news.story.trending") && parsed.prompt.includes("Test story summary"),
    );
    check(
      "happy: prompt body ends with JSON code fence containing signal",
      /```json[\s\S]*"signal_id": "test-sig-123"[\s\S]*```/.test(parsed.prompt),
    );
  } finally {
    srv.close();
  }
}

// case 2: 4xx — fail fast, no retry
{
  let calls = 0;
  const { srv, url } = await startServer((_req, _body, res) => {
    calls++;
    res.statusCode = 401;
    res.end("unauthorized");
  });
  try {
    let threw = false;
    try {
      await httpPost(
        url,
        "{}",
        {},
        { timeoutMs: 2_000, maxAttempts: 3, baseDelayMs: 10 },
      );
    } catch (error) {
      threw = true;
      check("4xx: error mentions 401", String(error).includes("401"));
    }
    check("4xx: throws", threw);
    check("4xx: only one call (no retry)", calls === 1);
  } finally {
    srv.close();
  }
}

// case 3: 5xx — retry up to maxAttempts, eventually throws
{
  let calls = 0;
  const { srv, url } = await startServer((_req, _body, res) => {
    calls++;
    res.statusCode = 503;
    res.end("flaky");
  });
  try {
    let threw = false;
    try {
      await httpPost(
        url,
        "{}",
        {},
        { timeoutMs: 2_000, maxAttempts: 3, baseDelayMs: 10 },
      );
    } catch (error) {
      threw = true;
      check("5xx: error mentions 503", String(error).includes("503"));
    }
    check("5xx: throws after retries", threw);
    check("5xx: called maxAttempts times", calls === 3, `calls=${calls}`);
  } finally {
    srv.close();
  }
}

// case 4: 5xx then 200 — retry succeeds
{
  let calls = 0;
  const { srv, url } = await startServer((_req, _body, res) => {
    calls++;
    if (calls < 2) {
      res.statusCode = 503;
      res.end("flaky");
    } else {
      res.statusCode = 200;
      res.end("ok");
    }
  });
  try {
    await httpPost(
      url,
      "{}",
      {},
      { timeoutMs: 2_000, maxAttempts: 3, baseDelayMs: 10 },
    );
    check("5xx-then-200: succeeded after retry", true);
    check("5xx-then-200: exactly 2 calls", calls === 2, `calls=${calls}`);
  } finally {
    srv.close();
  }
}

if (failures > 0) {
  process.stderr.write(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}
process.stdout.write("\nAll checks passed.\n");
