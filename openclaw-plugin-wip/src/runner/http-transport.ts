import { createHmac } from "node:crypto";
import type { W2ASignal } from "@world2agent/sdk";
import type { HttpIngestEnvelope } from "../types.js";

export interface IngestTransportOptions {
  url: string;
  hmacSecret: string;
  sensorId: string;
  skillId: string;
  timeoutMs: number;
  retries?: number;
  retryDelayMs?: number;
}

export function ingestTransport(options: IngestTransportOptions) {
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 500;

  return async (signal: W2ASignal): Promise<void> => {
    const envelope: HttpIngestEnvelope = {
      sensor_id: options.sensorId,
      skill_id: options.skillId,
      signal,
    };
    const body = JSON.stringify(envelope);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Request-ID": signal.signal_id,
      "X-Webhook-Signature": createHmac("sha256", options.hmacSecret)
        .update(body)
        .digest("hex"),
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(options.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        if (response.ok) return;
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => "")}`);
        }
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }

      if (attempt < retries) {
        await sleep(retryDelayMs * 2 ** attempt);
      }
    }

    throw lastError;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

