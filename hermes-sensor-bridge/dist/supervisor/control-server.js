import { createServer } from "node:http";
import { readManifest } from "./manifest.js";
export async function startControlServer(options) {
    const server = createServer((req, res) => {
        void handleRequest(req, res, options);
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    options.log(`[w2a/control] listening on http://127.0.0.1:${options.port}`);
    return {
        close: () => new Promise((resolve, reject) => {
            server.close((error) => {
                if (error)
                    reject(error);
                else
                    resolve();
            });
        }),
    };
}
async function handleRequest(req, res, options) {
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
        });
        return;
    }
    if (req.method === "GET" && url.pathname === "/_w2a/list") {
        writeJson(res, 200, {
            ok: true,
            handles: options.supervisor.snapshot(),
        });
        return;
    }
    if (req.method === "POST" && url.pathname === "/_w2a/reload") {
        try {
            const manifest = await readManifest(options.paths);
            const applied = await options.supervisor.applyConfig(manifest.sensors);
            writeJson(res, 200, {
                ok: true,
                applied,
            });
        }
        catch (error) {
            writeJson(res, 422, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return;
    }
    writeJson(res, 404, { ok: false, error: "not found" });
}
function authorize(req, token) {
    return req.headers["x-w2a-token"] === token;
}
function writeJson(res, status, body) {
    const payload = JSON.stringify(body, null, 2);
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(payload);
}
