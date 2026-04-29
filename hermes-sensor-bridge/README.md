# @world2agent/hermes-sensor-bridge

World2Agent bridge for [Hermes Agent](https://hermes-agent.nousresearch.com/).

Runs W2A sensors as supervised Node subprocesses and delivers their signals into Hermes via the gateway's native webhook subscriptions. Each signal triggers a fresh `AIAgent.run_conversation()` with the corresponding handler skill auto-loaded by Hermes.

> Status: alpha (`0.1.0-alpha.0`).

---

## Install

The bridge ships two pieces — a Node runtime (this npm package) and a portable skill that the agent uses to drive it.

### 1. Install the runtime

```bash
npm install -g @world2agent/hermes-sensor-bridge
```

Provides `world2agent-hermes-supervisor` and `world2agent-sensor-runner` on PATH.

### 2. Install the agent-facing skill

```bash
hermes skills install machinepulse-ai/world2agent-plugins/hermes-sensor-bridge/skills/world2agent-manage
```

That follows Hermes's standard `<org>/<repo>/<subpath>` install form (see [the skills docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)). It drops `SKILL.md` + `scripts/` under `~/.hermes/skills/world2agent-manage/`, after which the skill is automatically exposed as both a description-matched intent and the `/world2agent-manage` slash command.

---

## Use it

Open an interactive Hermes session:

```bash
hermes
```

Two equivalent ways to invoke the management skill:

**Natural language** — same conversation language the agent will Q&A back in:

> install the hacker news sensor

> 帮我订阅这个 GitHub 仓库的 release 通知:owner/repo

**Slash command** — Hermes auto-exposes every installed skill as `/world2agent-manage <intent>`:

```
/world2agent-manage add @world2agent/sensor-hackernews
/world2agent-manage list
/world2agent-manage remove @world2agent/sensor-hackernews
/world2agent-manage status
```

Both paths run the same flow — the agent walks the sensor's `SETUP.md` Q&A, generates a handler skill, registers the Hermes webhook subscription, and starts the sensor subprocess. Subsequent signals trigger fresh `AIAgent.run_conversation()` runs against the generated handler.

The agent runs `bootstrap.sh` automatically the first time it's needed; you don't bootstrap by hand.

> **First-time hiccup, once per machine**: the very first install writes a managed `platforms.webhook` block to `~/.hermes/config.yaml`. Hermes only hot-reloads dynamic webhook *subscriptions*, not the platform config itself, so the agent will ask you to **restart `hermes gateway` once** at this point. Every install after that is seamless.

For persistent supervisor autostart on login (otherwise it dies on reboot):

```bash
bash ~/.hermes/skills/world2agent-manage/scripts/install-launchd.sh    # macOS
bash ~/.hermes/skills/world2agent-manage/scripts/install-systemd.sh    # Linux
```

Or skip the agent and call the scripts directly (handy for debugging — every script except `log.sh` emits a single JSON object on stdout):

```bash
bash ~/.hermes/skills/world2agent-manage/scripts/list-sensors.sh   | jq .
bash ~/.hermes/skills/world2agent-manage/scripts/status.sh         | jq .
bash ~/.hermes/skills/world2agent-manage/scripts/remove-sensor.sh "@world2agent/sensor-hackernews" | jq .
```

### Delivery mode

`install-sensor.sh` auto-detects the deliver target from `<PLATFORM>_HOME_CHANNEL` in `~/.hermes/.env` (priority: `feishu`, `telegram`, `discord`, `slack`, `signal`, `whatsapp`, `wecom`, `dingtalk`). If you've paired a chat platform via `hermes`, signals automatically reach that chat after agent processing. Override per sensor with explicit flags via the agent ("install hacker news but log only", or "deliver-only mode for that alert sensor").

---

## Lifecycle scripts

All under `~/.hermes/skills/world2agent-manage/scripts/`. Run with `bash <path>`; they are not chmod +x by design (so they survive npm packaging).

| Script | Purpose |
| --- | --- |
| `bootstrap.sh` | First-time setup (binary check, state, `platforms.webhook`, supervisor start). |
| `install-launchd.sh` / `install-systemd.sh` | Persistent supervisor autostart on macOS / Linux. |
| `uninstall-bootstrap.sh` | Reverse `bootstrap.sh` (autostart + managed `config.yaml`/`env` block). |
| `read-setup.sh <pkg>` | Install the npm package, return its `SETUP.md`. |
| `install-sensor.sh <pkg> --config-file <json> --skill-md <md>` | Full install transaction. |
| `remove-sensor.sh <pkg> [--purge]` | Reverse of install. |
| `list-sensors.sh` | Configured sensors + supervisor runtime view. |
| `status.sh` | Diagnostics (supervisor health + Hermes subscriptions). |
| `start.sh` / `stop.sh` | Manual supervisor lifecycle. |
| `log.sh [-f] [-n N] [<sensor_id>]` | Tail `~/.world2agent/supervisor.log` (raw lines, NOT JSON). |

---

## Architecture

```
sensor child process              supervisor (parent)              hermes gateway
─────────────────────             ─────────────────────            ──────────────
startSensor + SDK                 read child.stdout line-by-line   /webhooks/<name>
stdoutTransport()       ───→      parse → POST(body, headers)  ──→ HMAC + X-Request-ID
                                  with retry on 5xx/network         dedup, then
                                                                    AIAgent.run_conversation
                                                                    with --skills loaded
```

The runner has **zero Hermes knowledge** — it's a stock `startSensor` + SDK `stdoutTransport`. All Hermes-specific work (HMAC signing, X-Request-ID, prompt body shape, HTTP retries, route subscription, platform bootstrap) lives in the supervisor. Same runner can be reused by future channels.

### Files & paths

| Path | What it is |
| --- | --- |
| `~/.world2agent/_npm/node_modules/<pkg>/` | Sensor packages installed by `install-sensor.sh` / `read-setup.sh`. |
| `~/.world2agent/config.json` | Source of truth for which sensors are enabled (shared with `claude-code-channel`). |
| `~/.world2agent/.bridge-state.json` | Bridge runtime secrets — `hmac_secret`, `control_token`, `control_port`. Mode `0600`. |
| `~/.world2agent/supervisor.log` | Supervisor + child-process logs. |
| `~/.hermes/skills/<skill_id>/SKILL.md` | Per-sensor handler skill that Hermes auto-loads when the sensor's webhook fires. |
| `~/.hermes/config.yaml` | Hermes gateway config; bootstrap appends a managed `platforms.webhook` block. |
| `~/.hermes/webhook_subscriptions.json` | Hermes-managed; the install/remove scripts only touch this via `hermes webhook subscribe` / `remove`. |

### Bins

- `world2agent-hermes-supervisor` — daemon. Spawns/monitors runners with config-hash-aware reconciliation, hot-reloads `~/.world2agent/config.json` (`fs.watch` with 500 ms debounce + 100 ms re-attach for atomic rename), POSTs each signal to Hermes with `X-Webhook-Signature` (HMAC-SHA256 hex) and `X-Request-ID` (= `signal.signal_id`), retries on 5xx/network, fails fast on 4xx.
- `world2agent-sensor-runner` — per-sensor subprocess. Channel-agnostic: signals to stdout (one JSON line each), diagnostics to stderr.

### Control HTTP

The supervisor binds `127.0.0.1:<control_port>` (default `8645`, recorded in `.bridge-state.json`):

- `GET  /_w2a/health` — uptime, child count, supervisor pid.
- `GET  /_w2a/list` — desired sensors (from `config.json`) and live child handles.
- `POST /_w2a/reload` — re-read `config.json` and reconcile (the file watcher does this automatically; this endpoint is for forcing a reapply).

All endpoints require `X-W2A-Token: <control_token>`.

---

## Relation to `claude-code-channel`

Sibling package. `claude-code-channel` is an in-process MCP channel for Claude Code; this package is an out-of-process bridge for Hermes. Both share `~/.world2agent/config.json` and load the same `@world2agent/sensor-*` packages without modification.

---

## Development

```bash
pnpm install
pnpm run build
pnpm test    # delivery + config-watcher + skill-scripts (67 assertions, sandboxed)
```

For hacking on the skill in this checkout without re-installing it each time, point the SKILL at the local scripts dir:

```bash
export WORLD2AGENT_MANAGE_SCRIPTS=$(pwd)/skills/world2agent-manage/scripts
```

The SKILL honors that env var and falls back to `~/.hermes/skills/world2agent-manage/scripts` otherwise.
