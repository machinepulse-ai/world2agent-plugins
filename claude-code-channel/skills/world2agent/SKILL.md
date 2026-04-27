---
name: world2agent
description: Manage World2Agent sensors — add, list, remove. Use when the user asks to subscribe to, follow, or be notified about an outside-world source — e.g. "subscribe me to Hacker News", "watch this GitHub repo for releases", "ping me when that stock moves", "tell me when this page changes".
user-invocable: false
---

# World2Agent sensor manager

You are the World2Agent assistant inside Claude Code. Sensors are long-running probes that watch the outside world — news feeds, code repos, markets, social accounts, calendars, web pages — and push structured signals into this session in real time.

## Commands

`<package>` is always a full npm package name (e.g. `@world2agent/sensor-hackernews`). Any npm package that declares `w2a.type: "sensor"` in its `package.json` is a valid sensor. If the user gives only a short slug like "hackernews", run `/world2agent:sensor-list` first to see what's already installed rather than guessing a scope.

- `/world2agent:sensor-add <package>` — install a sensor and walk the user through its configuration.
- `/world2agent:sensor-list` — show currently enabled sensors.
- `/world2agent:sensor-remove <package>` — stop and uninstall a sensor.

## Config file

Sensors are declared in `~/.world2agent/config.json`:

```json
{
  "sensors": [
    { "package": "@scope/sensor-<name>", "config": { ... } }
  ]
}
```

When the user changes this file:

- **Adding a new sensor** (whose npm package wasn't previously installed) → the user MUST start a new session: `claude --dangerously-load-development-channels plugin:world2agent@world2agent-plugins`. Node's module resolution doesn't pick up freshly-installed packages inside a running MCP process, and `reload_sensors` cannot work around this.
- **Editing an existing sensor's config, or removing a sensor** → call the channel's `reload_sensors` MCP tool. It diffs the new config against what's running and starts/stops/restarts the affected sensors in place. No restart needed.

## Per-sensor setup

Every sensor package ships its own `SETUP.md` defining the questions to ask the user and a handler-skill template. `/world2agent:sensor-add` reads that file and drives the Q&A one question at a time, in the user's language.

## Handling incoming signals

When a sensor fires, Claude Code receives a notification whose first line is `Use skill: <skill_id>`. Load the matching skill at `.claude/skills/<skill_id>/SKILL.md` (project) or `~/.claude/skills/<skill_id>/SKILL.md` (global) and follow its rules for how to classify, surface, or ignore the signal. The `<skill_id>` is derived from the package name: strip the leading `@` and replace `/` with `-` (so `@world2agent/sensor-hackernews` → `world2agent-sensor-hackernews`).
