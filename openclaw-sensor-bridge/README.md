# @world2agent/openclaw-sensor-bridge

World2Agent bridge for [OpenClaw](https://openclaw.ai).

Runs W2A sensors as supervised Node subprocesses and delivers their signals into OpenClaw via the gateway's built-in `/hooks/agent` webhook. Each signal triggers a fresh isolated agent turn with the corresponding handler skill auto-loaded by OpenClaw.

> Status: alpha (`0.1.0-alpha.0`).

---

## How it works

A standalone supervisor daemon manages sensor subprocesses on your host and POSTs each emitted signal to OpenClaw's public `/hooks/agent` webhook with a Bearer token. The bridge talks to OpenClaw only over that one HTTP surface — no in-process integration, no private gateway APIs, no extra OpenClaw permission grants. Each signal triggers a fresh isolated agent turn against the corresponding handler skill.

The bridge is structurally identical to [`@world2agent/hermes-sensor-bridge`](../hermes-sensor-bridge); the only difference is the delivery hop. Same manifest (`~/.world2agent/config.json`), same channel-agnostic runner, same supervisor framework — just `/hooks/agent` + Bearer token instead of per-sensor webhook URLs + HMAC.

---

## Install

The bridge ships two pieces — a Node runtime (this npm package) and a portable skill that the agent uses to drive it.

### 1. Install the runtime

```bash
npm install -g @world2agent/openclaw-sensor-bridge
```

Provides `world2agent-openclaw-supervisor` and `world2agent-sensor-runner` on PATH.

### 2. Enable hooks in OpenClaw

Edit `~/.openclaw/openclaw.json` to include:

```json
"hooks": {
  "enabled": true,
  "token": "<a long random secret you keep private>",
  "allowRequestSessionKey": true,
  "allowedSessionKeyPrefixes": ["hook:", "w2a:"]
}
```

Then `openclaw gateway restart`. The bridge auto-discovers token + gateway port from this file at startup; environment overrides (`OPENCLAW_HOOK_TOKEN`, `OPENCLAW_GATEWAY_URL`, `W2A_SESSION_KEY_PREFIX`) take precedence when set.

### 3. Install the agent-facing skill

Drop the skill under OpenClaw's skills dir so the main agent picks it up:

```bash
mkdir -p ~/.openclaw/skills/world2agent-manage
cp -r $(npm prefix -g)/lib/node_modules/@world2agent/openclaw-sensor-bridge/skills/world2agent-manage/* \
      ~/.openclaw/skills/world2agent-manage/
```

(Adjust the source path if your `npm prefix -g` differs.)

---

## Use it

Open an interactive OpenClaw chat:

```bash
openclaw chat --agent main
```

Then talk to it:

> install the hacker news sensor
>
> 帮我订阅这个 GitHub 仓库的 release 通知:owner/repo

The agent runs the SETUP.md Q&A, generates a handler skill, registers the
sensor in `~/.world2agent/config.json`, and starts the supervisor. Subsequent
signals each trigger a fresh `/hooks/agent` call against the handler skill.

For persistent supervisor autostart on login (otherwise it dies on reboot):

```bash
bash ~/.openclaw/skills/world2agent-manage/scripts/install-launchd.sh   # macOS
bash ~/.openclaw/skills/world2agent-manage/scripts/install-systemd.sh   # Linux
```

Or skip the agent and call the scripts directly (handy for debugging — every script except `log.sh` emits a single JSON object on stdout):

```bash
bash ~/.openclaw/skills/world2agent-manage/scripts/list-sensors.sh   | jq .
bash ~/.openclaw/skills/world2agent-manage/scripts/status.sh         | jq .
bash ~/.openclaw/skills/world2agent-manage/scripts/remove-sensor.sh "@world2agent/sensor-hackernews" | jq .
```

### Delivery target

Signals can be delivered three ways:

| Mode | How | Effect |
|---|---|---|
| dashboard-only (default) | omit `--notify-*` flags | Agent runs, reply lands in `~/.openclaw/agents/<agent>/sessions/`. Visit `openclaw sessions --agent main` or the dashboard to see it. |
| auto-push to channel | pass `--notify-channel <ch> --notify-to <handle>` to `install-sensor.sh` | Agent runs, reply auto-delivered via OpenClaw's outbound channel layer (Feishu, iMessage, Telegram, Slack, …). |
| handler-side push | omit `--notify-*` and have the handler skill emit `imsg`/`feishu`/etc. tool calls itself | Most flexibility; the handler decides whether each signal is worth pushing. |

---

## Architecture

```
sensor child process              supervisor (parent)              openclaw gateway
─────────────────────             ─────────────────────            ────────────────
startSensor + SDK                 read child.stdout line-by-line   POST /hooks/agent
stdoutTransport()       ───→      parse → dedup signal_id      ──→ Authorization: Bearer
                                  POST /hooks/agent + Bearer       SECURITY NOTICE wrap +
                                  retry on 5xx/network             EXTERNAL_UNTRUSTED_CONTENT,
                                                                    spawn fresh agent turn
                                                                    against the handler skill,
                                                                    optionally deliver reply
                                                                    to channel
```

The runner has **zero OpenClaw knowledge** — it's a stock `startSensor` + SDK `stdoutTransport`. All OpenClaw-specific work (token resolution, sessionKey routing, Bearer auth, dedup, HTTP retries) lives in the supervisor. Same runner can be reused by any future bridge.

### Files & paths

| Path | What it is |
| --- | --- |
| `~/.world2agent/_npm/node_modules/<pkg>/` | Sensor packages installed by `install-sensor.sh` / `read-setup.sh`. |
| `~/.world2agent/config.json` | Source of truth for sensor enable state (shared with sibling W2A runtimes via per-runtime `_<runtime>` namespace blocks). |
| `~/.world2agent/.openclaw-bridge-state.json` | Bridge runtime state — `control_token`, `control_port`. Mode `0600`. |
| `~/.world2agent/openclaw-supervisor.log` | Supervisor + child-process logs. |
| `~/.openclaw/openclaw.json` | OpenClaw gateway config; `hooks.token` + `hooks.allowedSessionKeyPrefixes` are read at supervisor startup. **The bridge never writes to this file.** |
| `~/.openclaw/skills/<skill_id>/SKILL.md` | Per-sensor handler skill that OpenClaw auto-loads when the sensor's signal arrives. |

### Manifest schema

`~/.world2agent/config.json` is shared with sibling W2A runtimes. Each runtime owns one `_<runtime>` namespace block; foreign blocks are passed through verbatim so multiple bridges can coexist on the same machine without stepping on each other.

```jsonc
{
  "sensors": [
    {
      "package": "@world2agent/sensor-hackernews",
      "enabled": true,
      "config": { "top_n": 30, "min_score": 50, "interval_seconds": 300 },
      "_openclaw_bridge": {
        "sensor_id": "hackernews",
        "skill_id": "world2agent-sensor-hackernews",
        "session_key": "w2a:hackernews",
        // optional:
        "agent_id": "main",
        "model": "openrouter/moonshotai/kimi-k2.6",
        "notify": { "channel": "feishu", "to": "<chat-id>" }
      }
    }
  ]
}
```

This bridge's contract:

- **Read**: only acts on entries that carry an `_openclaw_bridge` block. Entries owned exclusively by other W2A runtimes are ignored — their sensors keep running under their own runtime; we don't double-start them.
- **Write**: matches by `package`. If an entry exists, shared fields and `_openclaw_bridge` are overwritten; other `_<runtime>` blocks are preserved verbatim.
- **Identity**: `_openclaw_bridge.sensor_id` is the lookup key for `remove-sensor.sh`.

### Bins

- `world2agent-openclaw-supervisor` — daemon. Spawns/monitors runners with config-hash-aware reconciliation, hot-reloads `~/.world2agent/config.json` (`fs.watch` with 500 ms debounce + 100 ms re-attach for atomic rename), POSTs each signal to `/hooks/agent` with `Authorization: Bearer`, retries on 5xx/network, fails fast on 4xx. Idempotency-dedups by `signal.signal_id` for one hour to absorb sensor retries.
- `world2agent-sensor-runner` — per-sensor subprocess. Channel-agnostic: signals to stdout (one JSON line each), diagnostics to stderr.

### Control HTTP

The supervisor binds `127.0.0.1:<control_port>` (default `8646`, recorded in `.openclaw-bridge-state.json`):

- `GET  /_w2a/health` — uptime, child count, supervisor pid.
- `GET  /_w2a/list` — desired sensors (from `config.json`) and live child handles.
- `POST /_w2a/reload` — re-read `config.json` and reconcile (the file watcher does this automatically; this endpoint is for forcing a reapply).

All endpoints require `X-W2A-Token: <control_token>`.

### Untrusted-content framing

OpenClaw automatically wraps every `/hooks/agent` payload in a `SECURITY NOTICE` + `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` envelope before the model sees it. This is good — webhook content is genuinely external. But it means a handler skill that doesn't explicitly opt into trusting `Source: Webhook` content will default to `NO_REPLY`. The `world2agent-manage` skill bakes a "trust hint" snippet into every generated handler skill that defeats this, but if you're hand-writing a handler, copy that snippet into yours (see `skills/world2agent-manage/SKILL.md` → "Step 4: compose the handler SKILL.md").

---

## Relation to `hermes-sensor-bridge`

[`@world2agent/hermes-sensor-bridge`](../hermes-sensor-bridge) is the sibling for Hermes Agent. Shares the same `~/.world2agent/config.json` (different `_<runtime>` namespace block), the same channel-agnostic runner, and the same supervisor framework. Both bridges can run simultaneously on the same host — different control ports, different log/pid files, manifest entries co-exist via per-runtime namespace blocks.

---

## Development

```bash
pnpm install
pnpm run build
node e2e/test-delivery.mjs       # spawns supervisor against a mock /hooks/agent
node e2e/test-config-watcher.mjs # verifies hot-reload of config.json
```

For hacking on the skill in this checkout without re-installing it each time, point the SKILL at the local scripts dir:

```bash
export WORLD2AGENT_MANAGE_SCRIPTS=$(pwd)/skills/world2agent-manage/scripts
```

The SKILL honors that env var and falls back to `~/.openclaw/skills/world2agent-manage/scripts` otherwise.
