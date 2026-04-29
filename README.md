# world2agent-plugins

Channel adapters that connect [World2Agent](https://github.com/machinepulse-ai/world2agent) sensors to AI agent runtimes — give your agent real-time awareness of external events (Hacker News, GitHub, stocks, X, calendars, …) via pluggable sensors.

## What's in here

| Package | Runtime | Description |
| --- | --- | --- |
| [`claude-code-channel`](./claude-code-channel) | [Claude Code](https://docs.claude.com/en/docs/claude-code) | MCP channel adapter + Claude Code plugin bundle. Signals arrive as in-session MCP notifications. |
| [`hermes-sensor-bridge`](./hermes-sensor-bridge) | [Hermes Agent](https://hermes-agent.nousresearch.com/) | Out-of-process supervisor + webhook bridge. Each signal triggers a fresh `AIAgent.run_conversation()` with the generated handler skill auto-loaded. |
| [`openclaw-plugin`](./openclaw-plugin) | [OpenClaw](https://docs.openclaw.ai/) | Native OpenClaw plugin. Conversational install via chat (Q&A driven by the sensor's `SETUP.md`), in-process polling, dispatch via `runEmbeddedAgent` into a per-sensor session lane keyed `agent:main:w2a-<sensor>` (main chat untouched). |

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

## Quick start — OpenClaw

Prereq — the plugin refuses to start unless `agents.defaults.contextInjection` is exactly `"continuation-skip"` in `~/.openclaw/openclaw.json`. This is hard-fail by design (the default `"always"` re-injects bootstrap on every signal and silently turns sensors into a token sink):

```bash
jq '.agents.defaults.contextInjection = "continuation-skip"' \
  ~/.openclaw/openclaw.json > /tmp/openclaw.json.tmp && \
  mv /tmp/openclaw.json.tmp ~/.openclaw/openclaw.json
```

Install the plugin (`--dangerously-force-unsafe-install` is required because the plugin uses `child_process` to npm-install sensor packages on demand — OpenClaw's security scan blocks it otherwise):

```bash
openclaw plugins install @world2agent/openclaw-plugin --dangerously-force-unsafe-install
openclaw gateway restart
```

Then in a chat session with your `main` agent, just describe what you want to subscribe to:

```
> subscribe me to Hacker News — I care about AI and security stories
```

The bundled `world2agent-manage` skill takes over: reads the sensor's `SETUP.md`, asks you 1–3 questions to personalize the handler, writes both the config and the personalized SKILL.md, and registers the sensor — without any manual CLI work.

> First time only: the agent will ask **you** to run `openclaw gateway restart` once after registration. It intentionally doesn't run that command itself — restarting the gateway from inside the chat would kill the gateway process and truncate the agent's reply mid-sentence. After the restart, the sensor starts polling within ~60 seconds.

Signals route to a per-sensor session lane (`agent:main:w2a-<sensor>`) — your `main` chat is untouched. Open the `w2a-<sensor>` lane in the OpenClaw dashboard (<http://127.0.0.1:18789/>) to see how the agent reacts to each signal. See [`openclaw-plugin/README.md`](./openclaw-plugin/README.md) for the full install reference, dispatcher internals, and CLI fallback.

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
├── hermes-sensor-bridge/       # @world2agent/hermes-sensor-bridge
│   ├── src/
│   │   ├── runner/             # per-sensor subprocess
│   │   └── supervisor/         # daemon (signal → HMAC → POST → Hermes)
│   ├── skills/world2agent-manage/
│   │   ├── SKILL.md            # agent-facing skill
│   │   └── scripts/            # all host-side work (install, remove, list, …)
│   ├── e2e/
│   └── package.json
└── openclaw-plugin/            # @world2agent/openclaw-plugin
    ├── src/
    │   ├── dispatch.ts         # runEmbeddedAgent + `# System Event` framing
    │   ├── runtime.ts          # in-process sensor lifecycle
    │   ├── isolated.ts         # opt-in subprocess mode (reuses Hermes runner)
    │   └── cli.ts              # `openclaw world2agent sensor add | list | remove`
    ├── skills/world2agent-manage/
    │   └── SKILL.md            # conversational install + management skill
    ├── test/
    └── package.json
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

### OpenClaw plugin (`openclaw-plugin`)

Bump `version` in `openclaw-plugin/package.json`, then `pnpm publish --access public --tag alpha` (alpha) or `latest` (stable). Users pull updates with:

```bash
openclaw plugins install @world2agent/openclaw-plugin@<tag> --dangerously-force-unsafe-install
openclaw gateway restart
```

The bundled `world2agent-manage` skill ships inside the package, so it updates atomically with the plugin — no separate install step.

---

## License

Apache-2.0
