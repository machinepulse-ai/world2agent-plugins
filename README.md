# world2agent-plugins

Channel adapters that connect [World2Agent](https://github.com/machinepulse-ai/world2agent) sensors to AI agent runtimes — give your agent real-time awareness of external events (Hacker News, GitHub, stocks, X, calendars, …) via pluggable sensors.

## What's in here

| Package | Runtime | Description |
| --- | --- | --- |
| [`claude-code-channel`](./claude-code-channel) | [Claude Code](https://docs.claude.com/en/docs/claude-code) | MCP channel adapter + Claude Code plugin bundle. Signals arrive as in-session MCP notifications. |
| [`hermes-sensor-bridge`](./hermes-sensor-bridge) | [Hermes Agent](https://hermes-agent.nousresearch.com/) | Out-of-process supervisor + webhook bridge. Each signal triggers a fresh `AIAgent.run_conversation()` with the generated handler skill auto-loaded. |

---

## Quick start — Claude Code

In Claude Code:

```
/plugin marketplace add machinepulse-ai/world2agent-plugins
/plugin install world2agent@world2agent-plugins
```

Then wire up a sensor:

```
/world2agent:sensor-add @world2agent/sensor-hackernews
```

Incoming signals appear in your Claude Code session as MCP notifications.

---

## Quick start — Hermes

Install once:

```bash
npm install -g @world2agent/hermes-sensor-bridge
hermes skills install machinepulse-ai/world2agent-plugins/hermes-sensor-bridge/skills/world2agent-manage
```

Then in an interactive `hermes` session, just describe the intent in natural language or use the slash form. The agent handles the rest (npm install, SETUP.md Q&A, webhook subscription, subprocess startup):

```
/world2agent-manage add @world2agent/sensor-hackernews
```

> First time only: the agent will ask you to restart `hermes gateway` once after it enables the webhook platform — this is a one-time hiccup because Hermes hot-reloads webhook *subscriptions* but not the *platform* config. Every install after that is seamless.

Each signal triggers a fresh agent run against the generated handler skill. See [`hermes-sensor-bridge/README.md`](./hermes-sensor-bridge/README.md) for lifecycle / debugging reference.

---

## Repository layout

```
.
├── .claude-plugin/
│   └── marketplace.json        # Claude Code marketplace catalog
├── claude-code-channel/        # the `world2agent` Claude Code plugin
│   ├── .claude-plugin/
│   ├── commands/               # /world2agent:sensor-add, sensor-list, sensor-remove
│   ├── skills/                 # MCP-side handler skills
│   ├── src/
│   └── package.json
└── hermes-sensor-bridge/       # @world2agent/hermes-sensor-bridge
│   ├── src/
│   │   ├── runner/             # per-sensor subprocess
│   │   └── supervisor/         # daemon (signal → HMAC → POST → Hermes)
│   ├── skills/world2agent-manage/
│   │   ├── SKILL.md            # agent-facing skill
│   │   └── scripts/            # all host-side work (install, remove, list, …)
│   ├── e2e/
│   └── package.json
```

---

## For plugin authors: updating

### Claude Code plugin (`claude-code-channel`)

Bump `version` in `claude-code-channel/.claude-plugin/plugin.json` on every release — Claude Code uses that field to detect updates. Pushing new commits without bumping the version will leave existing users on the cached copy.

Users pull updates with:

```
/plugin marketplace update
/plugin update
```

### Hermes bridge (`hermes-sensor-bridge`)

Bump `version` in `hermes-sensor-bridge/package.json`, then `pnpm publish --access public --tag alpha` (alpha) or `latest` (stable). Users pull the runtime with `npm install -g @world2agent/hermes-sensor-bridge@<tag>`. The skill is installed separately via `hermes skills install …`; re-run that command with `--force` to refresh to the latest skill content.

## License

Apache-2.0
