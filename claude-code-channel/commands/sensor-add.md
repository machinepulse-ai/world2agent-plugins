---
description: Install and configure a World2Agent sensor
---

Add a sensor for the user from package `$ARGUMENTS`. `$ARGUMENTS` MUST be a complete npm package name (e.g. `@world2agent/sensor-hackernews`) — **never guess, never auto-prepend a scope**.

If the user gives a short slug like `hackernews`, resolve it first: run `/world2agent:sensor-list` or ask the user once for the full name. Any npm package with `w2a.type: "sensor"` metadata is a valid sensor.

## 0. Validate the input (security gate — do this BEFORE anything else)

`$ARGUMENTS` is going to be passed to `npm install` as a shell argument. Before you do anything else, confirm it is **only** an npm package name:

- It must match this regex exactly: `^(@[a-z0-9][a-z0-9_-]*\/)?[a-z0-9][a-z0-9._-]*$`
- It must contain no whitespace, no shell metacharacters (`;`, `&`, `|`, `` ` ``, `$`, `(`, `)`, `<`, `>`, `'`, `"`, `\`, newline), no `..`, and no URL scheme (`http://`, `git+…`, `file:…`).
- Reject anything that looks like a tarball path or git URL, even if npm would technically accept it. Users who need those can hand-edit `~/.world2agent/config.json`.

If `$ARGUMENTS` fails any of these checks, **refuse and stop**. Tell the user what looked wrong and ask them to re-issue the command with a plain npm package name. Do not try to "sanitize" the input yourself.

## Conversation language

Run the entire Q&A in the **user's current conversation language** (infer from their recent messages; if unclear, fall back to the device/system locale). The questions in `SETUP.md` are templates — translate them into the user's language before asking. Don't dump English questions on a Chinese user, or vice versa.

## Naming convention (everything is derived from the full package name)

- npm package: `$ARGUMENTS` (any valid npm package name)
- skill_id (directory name): output of `packageToSkillId($ARGUMENTS)` — strip the leading `@`, replace `/` with `-`. E.g. `@world2agent/sensor-hackernews` → `world2agent-sensor-hackernews`, `@acme/my-source` → `acme-my-source`
- handler skill path: `.claude/skills/<skill_id>/SKILL.md`

## 1. Install the npm package

Run (`--prefix` points at the plugin dir so the sensor lands in the same `node_modules` as world2agent):

```bash
npm install $ARGUMENTS --prefix "${CLAUDE_PLUGIN_ROOT}"
```

If `CLAUDE_PLUGIN_ROOT` isn't set, locate the `world2agent` directory under `~/.claude/plugins/` and use that as the plugin root.

## 2. Read SETUP.md and run the configuration Q&A

Once installed, open:

```
${CLAUDE_PLUGIN_ROOT}/node_modules/$ARGUMENTS/SETUP.md
```

Walk the user through its interactive questions one at a time, in their language (see "Conversation language" above), and record the answers.

## 3. Write to `~/.world2agent/config.json`

If the file doesn't exist, create it as `{ "sensors": [] }`. Append to `sensors`:

```json
{
  "package": "$ARGUMENTS",
  "config": { /* user's answers */ },
  "skills": ["<absolute path to the handler SKILL.md directory you write in §4>"]
}
```

If an entry with the same `package` already exists, ask the user before overwriting.

## 4. Generate the handler skill

Fill the skill template from SETUP.md with the user's answers and write it to the project-level path:

```
.claude/skills/<skill_id>/SKILL.md
```

`<skill_id>` is derived per the "Naming convention" section above. Frontmatter requirements:

- `name:` MUST equal `<skill_id>` (matching the directory name) — the channel injects `Use skill: <skill_id>` at the head of every signal, and the directive only routes correctly when the name matches.
- `user-invocable: false` MUST be present — otherwise Claude Code adds the skill to the user's `/` autocomplete menu as `/<skill_id>`, which is noise. The model still invokes the skill automatically on the `Use skill:` directive when signals arrive.
- `description:` — one line stating which signals this skill handles.

If no project directory exists or the user prefers global, write to `~/.claude/skills/<skill_id>/SKILL.md` instead.

## 5. Tell the user to start a new session

A freshly-installed sensor is **not** picked up by the running MCP process — Node's module resolution caches `node_modules` and doesn't see the new package without a process restart. So after the config file + handler skill are written, the sensor still won't run until the user exits this session and starts a new one.

Tell the user, in their language, to:

1. Quit this Claude Code session.
2. Run:

   ```bash
   claude --dangerously-load-development-channels plugin:world2agent@world2agent-plugins
   ```

3. The new sensor will start automatically once the new session boots.

`/reload-plugins` alone is NOT sufficient — it reloads plugin definitions but does not refresh Node's `node_modules` view inside the running MCP channel.

`reload_sensors` (the channel's MCP tool) is for *config-only* changes after the package is already imported — e.g. you edit `~/.world2agent/config.json` to tweak a parameter or remove a sensor. **It does not reliably load brand-new packages**, so don't use it as a substitute for the restart in this install flow.
