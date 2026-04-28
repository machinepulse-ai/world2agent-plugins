---
name: world2agent-manage
description: Manage World2Agent sensors for Hermes. Use when the user asks to install, list, remove, or inspect W2A sensors, or wants to subscribe to an outside-world source such as Hacker News, GitHub, RSS, calendars, or market feeds.
user-invocable: false
---

# World2Agent Sensor Management

You manage the user's World2Agent sensors on this Hermes machine.

All mutations go through the `world2agent-hermes` CLI. The shell scripts in
`scripts/` are thin wrappers that exec the CLI directly.

## List sensors

Run:

```bash
bash "$W2A_PLUGIN_HOME/skills/world2agent-manage/scripts/list.sh"
```

The CLI prints JSON with the manifest state and any live runtime status reported
by the local supervisor.

## Install a sensor

1. Confirm the npm package name with the user.
2. Inspect the sensor package's `SETUP.md` to determine the config fields it
   needs. The current bridge implementation does **not** run an interactive
   setup helper automatically.
3. Write a temporary JSON file containing the sensor config object only.
4. Run:

```bash
bash "$W2A_PLUGIN_HOME/skills/world2agent-manage/scripts/add.sh" <pkg> --config-file <temp-json>
```

Optional flags:

- `--sensor-id <id>` if the user wants a non-default instance id.
- `--webhook-url <url> --hmac-secret <secret> --no-hermes-subscribe` for local
  dev/test runs that bypass `hermes webhook subscribe`.

Never invent credentials or secrets. Ask the user explicitly when the config
requires them.

## Remove a sensor

Run:

```bash
bash "$W2A_PLUGIN_HOME/skills/world2agent-manage/scripts/remove.sh" <sensor_id>
```

Pass `--purge` only if the user explicitly wants the generated Hermes skill
directory removed too.

## Output style

After each action, summarize:

- which sensor ids were affected
- whether the supervisor reload succeeded
- any warnings or errors returned by the CLI
