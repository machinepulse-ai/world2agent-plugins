#!/usr/bin/env node

import { createHmac } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.MOCK_HERMES_PORT ?? "8786");
const secret = process.env.MOCK_HERMES_SECRET ?? "test-secret";

const server = createServer((req, res) => {
  const chunks = [];

  req.on("data", (chunk) => {
    chunks.push(chunk);
  });

  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const signature = req.headers["x-webhook-signature"];
    const requestId = req.headers["x-request-id"];

    if (typeof signature !== "string") {
      res.statusCode = 400;
      res.end("missing X-Webhook-Signature");
      return;
    }

    if (signature.startsWith("sha256=")) {
      res.statusCode = 400;
      res.end("signature must be raw hex");
      return;
    }

    const expected = createHmac("sha256", secret).update(body).digest("hex");
    if (signature !== expected) {
      res.statusCode = 401;
      res.end("invalid signature");
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end("invalid json");
      return;
    }

    const signalId = payload?.signal?.signal_id;
    if (typeof signalId !== "string") {
      res.statusCode = 400;
      res.end("missing signal.signal_id");
      return;
    }

    if (requestId !== signalId) {
      res.statusCode = 400;
      res.end("X-Request-ID mismatch");
      return;
    }

    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          signature_prefix: signature.slice(0, 16),
          request_id: requestId,
          signal_id: signalId,
          event_type: payload?.signal?.event?.type ?? null,
          body: payload,
        },
        null,
        2,
      ) + "\n",
    );

    res.statusCode = 200;
    res.end("ok");
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    JSON.stringify({ ok: true, listening: `http://127.0.0.1:${port}`, secret }, null, 2) + "\n",
  );
});
