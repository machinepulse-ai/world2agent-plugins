import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { SensorSupervisor } from "./spawn.js";
import type { BridgePaths } from "./manifest.js";
import { listBridgeSensors, readConfig } from "./manifest.js";

interface ControlServerOptions {
  paths: BridgePaths;
  supervisor: SensorSupervisor;
  token: string;
  port: number;
  startedAt: number;
  supervisorPid: number;
  log: (line: string) => void;
}

export interface RunningControlServer {
  close(): Promise<void>;
}

export async function startControlServer(
  options: ControlServerOptions,
): Promise<RunningControlServer> {
  const server = createServer((req, res) => {
    void handleRequest(req, res, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  options.log(`[w2a/control] listening on http://127.0.0.1:${options.port}`);

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ControlServerOptions,
): Promise<void> {
  if (!authorize(req, options.token)) {
    writeJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/_w2a/health") {
    writeJson(res, 200, {
      ok: true,
      uptime_ms: Date.now() - options.startedAt,
      child_count: options.supervisor.snapshot().length,
      supervisor_pid: options.supervisorPid,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/_w2a/list") {
    const config = await readConfig(options.paths);
    writeJson(res, 200, {
      ok: true,
      sensors: listBridgeSensors(config),
      handles: options.supervisor.snapshot(),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/_w2a/reload") {
    try {
      const config = await readConfig(options.paths);
      const applied = await options.supervisor.applyConfig(listBridgeSensors(config));
      writeJson(res, 200, {
        ok: true,
        applied,
      });
    } catch (error) {
      writeJson(res, 422, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  writeJson(res, 404, { ok: false, error: "not found" });
}

function authorize(req: IncomingMessage, token: string): boolean {
  return req.headers["x-w2a-token"] === token;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(payload);
}
