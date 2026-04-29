import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OpenClawConnection {
  /** e.g. "http://127.0.0.1:18789" — no trailing slash. */
  gatewayUrl: string;
  /** Bearer token for `Authorization: Bearer <token>`. */
  hookToken: string;
  /**
   * Default sessionKey prefix applied when a sensor entry doesn't supply
   * its own `session_key`. This prefix MUST match one of the gateway's
   * `hooks.allowedSessionKeyPrefixes`, otherwise /hooks/agent rejects with
   * `400 sessionKey must start with one of: ...`.
   */
  defaultSessionKeyPrefix: string;
}

interface ResolveOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve OpenClaw connection settings.
 *
 * Precedence (per field):
 *   1. Env override (OPENCLAW_GATEWAY_URL, OPENCLAW_HOOK_TOKEN, W2A_SESSION_KEY_PREFIX)
 *   2. ~/.openclaw/openclaw.json — `gateway.port` + `hooks.token` + `hooks.allowedSessionKeyPrefixes`
 *
 * Throws if `hooks.enabled !== true` or required fields are missing.
 */
export async function resolveOpenClawConnection(
  options: ResolveOptions = {},
): Promise<OpenClawConnection> {
  const env = options.env ?? process.env;
  const configPath =
    options.configPath ??
    env.OPENCLAW_CONFIG_PATH ??
    join(env.HOME ?? homedir(), ".openclaw", "openclaw.json");

  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    // No config file — env overrides become required.
  }

  const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const hooks = (cfg.hooks ?? {}) as Record<string, unknown>;
  const gateway = (cfg.gateway ?? {}) as Record<string, unknown>;

  // Allow env override to bypass `hooks.enabled` check (mostly for testing).
  if (!env.OPENCLAW_HOOK_TOKEN && hooks.enabled !== true) {
    throw new Error(
      `OpenClaw hooks subsystem is disabled. Set hooks.enabled=true in ${configPath} (or pass OPENCLAW_HOOK_TOKEN env to override).`,
    );
  }

  const hookToken =
    env.OPENCLAW_HOOK_TOKEN ?? optionalNonEmptyString(hooks.token);
  if (!hookToken) {
    throw new Error(
      `OpenClaw hook token not found. Set hooks.token in ${configPath} (or OPENCLAW_HOOK_TOKEN env).`,
    );
  }

  const gatewayUrl = resolveGatewayUrl(env, gateway);

  const defaultSessionKeyPrefix =
    env.W2A_SESSION_KEY_PREFIX ?? pickDefaultPrefix(hooks);

  return { gatewayUrl, hookToken, defaultSessionKeyPrefix };
}

function resolveGatewayUrl(
  env: NodeJS.ProcessEnv,
  gateway: Record<string, unknown>,
): string {
  if (env.OPENCLAW_GATEWAY_URL) {
    return env.OPENCLAW_GATEWAY_URL.replace(/\/+$/, "");
  }
  const port =
    typeof gateway.port === "number" && Number.isInteger(gateway.port)
      ? gateway.port
      : 18789;
  return `http://127.0.0.1:${port}`;
}

/**
 * Pick a default sessionKey prefix.
 *
 * If gateway has `allowedSessionKeyPrefixes`, prefer one we recognize as
 * sensor-oriented (`w2a:` first, then `hook:`); fall back to the first one
 * listed. If no allowlist is set we still emit `w2a:` and let the gateway
 * tell us off — that's a clearer config error than silently using `hook:`.
 */
function pickDefaultPrefix(hooks: Record<string, unknown>): string {
  const allowed = hooks.allowedSessionKeyPrefixes;
  if (Array.isArray(allowed) && allowed.length > 0) {
    const strings = allowed.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    for (const preferred of ["w2a:", "hook:"]) {
      if (strings.includes(preferred)) return preferred;
    }
    if (strings[0]) return strings[0];
  }
  return "w2a:";
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
