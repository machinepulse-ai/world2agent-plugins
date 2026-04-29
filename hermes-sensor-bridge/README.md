# @world2agent/hermes-sensor-bridge

World2Agent bridge for [Hermes Agent](https://hermes-agent.nousresearch.com/).

Runs W2A sensors as supervised Node subprocesses and delivers their signals into Hermes via the gateway's native webhook subscriptions. Each signal triggers a fresh `AIAgent.run_conversation()` with the corresponding handler skill auto-loaded by Hermes.

> Status: in development. See [`docs/channel-hermes-agent-design.md`](../docs/channel-hermes-agent-design.md) for the design.

## v2 Model

- Shared user intent lives in `~/.world2agent/config.json`.
- Hermes-specific metadata is stored per sensor under `_hermes` (`sensor_id`, `skill_id`, `webhook_url`, optional `subscription_name`).
- Runtime secrets and control metadata live in `~/.world2agent/.bridge-state.json` (`hmac_secret`, `control_token`, `control_port`).
- Sensor packages are installed by the SKILL.md flow into `~/.world2agent/_npm` (e.g. `npm install --prefix ~/.world2agent/_npm <pkg>`); the supervisor resolves bare specifiers against that prefix at spawn time.
- `world2agent-hermes-supervisor` watches `config.json` and reconciles child sensors automatically — no restart needed when sensors are added, edited, or removed.

## Layout

```
src/
  runner/        Node sensor-runner subprocess (one per enabled sensor)
  supervisor/    Independent local daemon — spawns/monitors runners,
                 watches ~/.world2agent/config.json, exposes 127.0.0.1
                 control HTTP for reload/list/health
```

## Bins

- `world2agent-hermes-supervisor` — daemon
- `world2agent-sensor-runner` — per-sensor subprocess (spawned by the supervisor)

User-facing install/remove UX is owned by the World2Agent SKILL.md flow, which edits `~/.world2agent/config.json` (and installs the package under `~/.world2agent/_npm`). The supervisor's file watcher picks the change up and reconciles.

## Control HTTP

The supervisor binds `127.0.0.1:<control_port>` (default `8645`, recorded in `.bridge-state.json`) and accepts:

- `GET  /_w2a/health` — uptime, child count, supervisor pid
- `GET  /_w2a/list` — desired sensors (from `config.json`) and live child handles
- `POST /_w2a/reload` — re-read `config.json` and reconcile (the file watcher does this automatically; this endpoint is for forcing a reapply)

All endpoints require `X-W2A-Token: <control_token>`.

## Relation to `claude-code-channel`

Sibling package. `claude-code-channel` is an in-process MCP channel for Claude Code; this package is an out-of-process bridge for Hermes. Both share `~/.world2agent/config.json` and load the same `@world2agent/sensor-*` packages without modification.
