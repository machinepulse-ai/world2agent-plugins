---
name: world2agent-manage
description: Manage World2Agent sensors for OpenClaw. Use when the user asks to install, list, remove, or inspect W2A sensors, or wants an outside-world source such as Hacker News, GitHub, RSS, calendars, or market feeds.
user-invocable: false
---

# World2Agent Sensor Management

You manage the user's World2Agent sensors on this OpenClaw machine.

All mutations go through the `openclaw world2agent` CLI. The shell scripts in
`scripts/` are thin wrappers around those commands.

## Prerequisite

Before adding sensors, OpenClaw must be configured with:

```yaml
agents:
  defaults:
    contextInjection: continuation-skip
```

If that field is not set exactly, `openclaw world2agent sensor add` will fail on
purpose. Do not try to work around it.

## List sensors

Run:

```bash
bash "$W2A_PLUGIN_HOME/skills/world2agent-manage/scripts/list.sh"
```

## Install a sensor

1. Confirm the npm package name with the user.
2. Inspect the sensor package's `SETUP.md` to determine the config fields it needs.
3. Write a temporary JSON file containing the sensor config object only.
4. Run:

```bash
bash "$W2A_PLUGIN_HOME/skills/world2agent-manage/scripts/add.sh" <pkg> --config-file <temp-json>
```

Optional flags:

- `--sensor-id <id>` if the user wants a non-default instance id.
- `--isolated` if the sensor should run out-of-process.

Never invent credentials or secrets. Ask the user when the config requires them.

## Remove a sensor

Run:

```bash
bash "$W2A_PLUGIN_HOME/skills/world2agent-manage/scripts/remove.sh" <sensor_id>
```

Pass `--purge` only if the user explicitly wants the generated OpenClaw skill
directory removed too.

## Reload sensors

Run:

```bash
bash "$W2A_PLUGIN_HOME/skills/world2agent-manage/scripts/reload.sh"
```

## Output style

After each action, summarize:

- which sensor ids were affected
- whether the reload succeeded
- any warnings or errors returned by the CLI

