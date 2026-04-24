# world2agent-plugins

A [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) for [World2Agent](https://github.com/machinepulse-ai/world2agent) — give Claude Code real-time awareness of external events via pluggable sensors (Hacker News, GitHub, stocks, X, calendars, and more).

## Install

In Claude Code:

```
/plugin marketplace add machinepulse-ai/world2agent-plugins
/plugin install world2agent@world2agent-plugins
```

Then wire up a sensor:

```
/world2agent:sensor-add @world2agent/sensor-github
```

Incoming signals will appear in your Claude Code session as MCP notifications.

## What's in this marketplace

| Plugin | Description |
| :-- | :-- |
| [`world2agent`](./claude-code-channel) | MCP channel adapter + plugin bundle that receives signals from World2Agent sensors and surfaces them in the active Claude Code session. Ships slash commands (`/world2agent:sensor-add`, `sensor-list`, `sensor-remove`) and handler skills. |

## Repository layout

```
.
├── .claude-plugin/
│   └── marketplace.json        # marketplace catalog (this is what Claude Code reads)
└── claude-code-channel/        # the `world2agent` plugin
    ├── .claude-plugin/
    │   └── plugin.json
    ├── commands/
    ├── skills/
    ├── src/
    └── package.json
```

## For plugin authors: updating

Bump `version` in `claude-code-channel/.claude-plugin/plugin.json` on every release — Claude Code uses that field to detect updates. Pushing new commits without bumping the version will leave existing users on the cached copy.

Users pull updates with:

```
/plugin marketplace update
/plugin update
```

## License

Apache-2.0
