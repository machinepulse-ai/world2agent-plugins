# @world2agent/claude-code-channel

Deliver [World2Agent](https://github.com/machinepulse-ai/world2agent) signals into [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions as MCP notifications.

This package is both:

- the **channel adapter** — an MCP server that Claude Code connects to, receives signals over HTTP from your sensors, and surfaces them in the active session; and
- the **Claude Code plugin** — shipped via marketplace (`/plugin install world2agent`), bundling `.claude-plugin/`, `.mcp.json`, `commands/`, and `skills/`.

## Install (plugin, recommended)

```
/plugin marketplace add <marketplace-url>
/plugin install world2agent
```

Claude Code will pull this package, wire up the MCP server via the bundled `.mcp.json`, and expose `/world2agent:sensor-add` etc.

## Install (standalone npm, no plugin)

```bash
npm install -g @world2agent/claude-code-channel
```

Then add to your `~/.claude/settings.json` (or project-level `.claude/settings.json`):

```json
{
  "mcpServers": {
    "world2agent": {
      "command": "w2a-claude-code"
    }
  }
}
```

Restart Claude Code; the `world2agent` MCP server will auto-start and listen for incoming signals.

## Wire up a sensor

In **plugin mode**, use the bundled slash command — the plugin installs the sensor, runs the Q&A, writes config + handler skill, and starts the sensor in-process:

```
/world2agent:sensor-add @world2agent/sensor-github
```

In **standalone npm mode**, add the sensor to `~/.world2agent/config.json` and restart Claude Code. The MCP server loads every enabled sensor from that file on startup. Minimal shape:

```json
{
  "sensors": [
    { "package": "@world2agent/sensor-hackernews", "config": { "top_n": 5 } }
  ]
}
```

Incoming signals appear as Claude Code tool notifications.

## License

Apache-2.0
