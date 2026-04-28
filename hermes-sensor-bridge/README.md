# @world2agent/hermes-sensor-bridge

World2Agent bridge for [Hermes Agent](https://hermes-agent.nousresearch.com/).

Runs W2A sensors as supervised Node subprocesses and delivers their signals into Hermes via the gateway's native webhook subscriptions. Each signal triggers a fresh `AIAgent.run_conversation()` with the corresponding handler skill auto-loaded by Hermes.

> Status: in development. See [`docs/channel-hermes-agent-design.md`](../docs/channel-hermes-agent-design.md) for the design.

## Layout

```
src/
  runner/        Node sensor-runner subprocess (one per enabled sensor)
  supervisor/    Independent local daemon — spawns/monitors runners,
                 exposes 127.0.0.1 control HTTP for reload/list/health
  cli/           `world2agent-hermes` CLI (start/stop/status/add/remove/list)
skills/
  world2agent-manage/   Agent-facing skill that wraps the CLI for
                        natural-language sensor management
```

## Bins

- `world2agent-hermes` — user-facing CLI
- `world2agent-hermes-supervisor` — daemon (started by `world2agent-hermes start`)
- `world2agent-sensor-runner` — per-sensor subprocess (spawned by the supervisor)

## Current CLI Flow

`world2agent-hermes add` currently expects a hand-written config JSON file:

```bash
world2agent-hermes add @world2agent/sensor-hackernews \
  --config-file ./hackernews.json
```

Supported add-time overrides:

- `--config-file <path>` — bypasses interactive setup and writes the manifest directly
- `--webhook-url <url>` — provide the target webhook URL yourself
- `--hmac-secret <secret>` — override the shared bridge HMAC secret
- `--no-hermes-subscribe` — skip the `hermes webhook subscribe` shellout entirely

The last three flags are intended mainly for local development and testing. In
the normal path, the bridge calls `hermes webhook subscribe`, stores the
returned webhook URL in the manifest, and reloads the local supervisor.

When a sensor package does not ship a machine-runnable setup helper, the bridge
generates a generic Hermes skill for that sensor instead of a fully customized
handler. The package's `SETUP.md` remains the source of truth for richer,
sensor-specific behavior.

## Relation to `claude-code-channel`

Sibling package. `claude-code-channel` is an in-process MCP channel for Claude Code; this package is an out-of-process bridge for Hermes. Both load the same `@world2agent/sensor-*` packages without modification.
