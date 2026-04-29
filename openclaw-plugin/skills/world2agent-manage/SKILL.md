---
name: world2agent-manage
description: Manage World2Agent sensors for OpenClaw. Use when the user asks to install, list, remove, or inspect W2A sensors, or wants an outside-world source such as Hacker News, GitHub, RSS, calendars, or market feeds.
user-invocable: false
---

# World2Agent Sensor Management

You manage the user's World2Agent sensors on this OpenClaw machine. Sensors
are long-running probes that watch the outside world (news, repos, markets,
pages, calendars) and dispatch structured signals back into the agent as
`# System Event` turns.

## Prerequisite

OpenClaw must have `agents.defaults.contextInjection` set to
`"continuation-skip"` in `~/.openclaw/openclaw.json` (it's JSON, not YAML).
The plugin refuses to start otherwise. Verify before doing anything else:

```bash
jq '.agents.defaults.contextInjection' ~/.openclaw/openclaw.json
```

If the value is anything other than `"continuation-skip"`, ask the user for
permission to fix it, then run:

```bash
jq '.agents.defaults.contextInjection = "continuation-skip"' \
  ~/.openclaw/openclaw.json > /tmp/oc.tmp && \
  mv /tmp/oc.tmp ~/.openclaw/openclaw.json
```

## Install a sensor (the conversational flow — preferred)

When the user expresses interest in an outside-world source ("subscribe me to
Hacker News", "watch this GitHub repo", "ping me on calendar events"), drive
the install end-to-end through dialogue. Do NOT just shell out to the CLI
with default config — the auto-generated handler is generic and the agent
will not reply meaningfully to signals without the user's preferences baked
in.

### Step 1 — Identify the package

Map the user's phrase to an npm package name. Common ones:

- "Hacker News" / "HN" → `@world2agent/sensor-hackernews`
- "GitHub releases" / "watch repo" → `@world2agent/sensor-github`
- generic feed → ask the user for the npm package name

If unsure, look up what's available:

- **Sensor hub (canonical catalog)**: <https://world2agent.ai/hub/> — browse
  every published sensor with its description, configuration parameters,
  and the events it emits. Use the WebFetch tool on this URL to enumerate
  available sensors when the user asks "what can I subscribe to?".
- **npm discovery**: `npm search @world2agent/sensor- --json | jq '.[] | {name, description}'`
- **Already installed locally**: read `~/.world2agent/sensors.json`.

If the user describes something that doesn't match any sensor on the hub
(e.g. "subscribe to my Notion tasks" with no Notion sensor), say so plainly
and offer two paths: pick the closest existing sensor, or write a new
sensor following the W2A SDK template (linked from the hub).

Confirm the package name with the user before continuing.

### Step 2 — Read the sensor's SETUP.md

Every sensor package ships a `SETUP.md` that defines:
- the configuration parameters the sensor takes (with defaults)
- the questions YOU must ask the user, one at a time, in their language
- the SKILL.md template to fill from the user's answers

To locate SETUP.md you first need the plugin's install directory. Use
`openclaw plugins list --json` (the canonical way — works in both link mode
and copy mode):

```bash
PLUGIN_DIR=$(openclaw plugins list --json | \
  jq -r '.plugins[] | select(.id == "world2agent") | .rootDir')
echo "$PLUGIN_DIR"
# → e.g. /Users/<you>/Documents/.../openclaw-plugin
```

Then check whether the sensor package is already installed there:

```bash
SETUP="$PLUGIN_DIR/node_modules/<pkg>/SETUP.md"
ls "$SETUP" 2>/dev/null || echo "not installed yet"
```

If it isn't installed, install it in-place (no manifest mutation, just
populates `node_modules/`):

```bash
( cd "$PLUGIN_DIR" && npm install --no-save <pkg> )
```

Then read SETUP.md with the Read tool, passing the absolute path
`$PLUGIN_DIR/node_modules/<pkg>/SETUP.md`.

(Reading SETUP.md upfront — before `sensor add` — is preferred so the user
can answer questions before any state mutation. The actual sensor
registration happens in step 6.)

### Step 3 — Run the Q&A, one question at a time

SETUP.md lists 1-3 questions under "Questions to Ask". Ask them ONE AT A TIME,
in the user's language, waiting for each answer before continuing. Do NOT
batch-ask. Do NOT invent your own questions. Do NOT skip questions even if
the user seems impatient — every placeholder in the SKILL.md template
corresponds to one of these answers.

### Step 4 — Fill the SKILL.md template

SETUP.md provides a template in its "Output" section, with placeholders like
`[USER_TOPICS]`, `[USER_NORMAL_STYLE]`, `[USER_DEEP_DIVE_THRESHOLD]`. Replace
each placeholder with the user's answer (or the default the user accepted).
Show the filled SKILL.md to the user for confirmation before writing.

### Step 5 — Write the personalized SKILL.md

Write to `~/.openclaw/skills/<skill_id>/SKILL.md` (NOT to Claude Code's
`~/.claude/skills/...` — that's the channel-side path, irrelevant here).
Compute `<skill_id>` from the package name: strip leading `@`, replace `/`
with `-`. Example: `@world2agent/sensor-hackernews` →
`world2agent-sensor-hackernews`.

```bash
mkdir -p ~/.openclaw/skills/<skill_id>
# Then write SKILL.md via the Write tool, with the filled template.
```

### Step 6 — Register the sensor with the plugin

Build the sensor's config JSON object (just the `config` block from SETUP.md's
"Configuration Parameters" table, with the user's answers). Then call:

```bash
openclaw world2agent sensor add <pkg> \
  --config-json '<inline json>' \
  --skip-generate-skill
```

The `--skip-generate-skill` flag is critical: it tells the CLI to keep the
personalized SKILL.md you just wrote in step 5. Without it, the CLI's
fallback would overwrite your work with a generic template.

Optional flags:
- `--sensor-id <id>` for a non-default instance id (only if the user wants
  multiple instances of the same sensor)
- `--isolated` to run the sensor out-of-process (for unstable third-party
  sensors)
- `--deliver-channel <id> --deliver-to <id>` to push the agent's reply to a
  chat platform (see step 6b).

### Step 6b — Offer to push replies to a chat platform

Check whether the user has any inbound chat-platform plugin enabled:

```bash
openclaw plugins list --json | jq -r \
  '.plugins[] | select(.enabled == true) | select(.channelIds | length > 0) | .id'
```

If the output is **empty**, skip this step — there's no IM to push to. The
sensor will still run; replies stay in the OpenClaw session lane (visible via
`openclaw sessions --agent main` and the dashboard).

If one or more channels are listed (e.g. `feishu`, `lark`, `whatsapp`,
`telegram`, `discord`, `slack`, `signal`, `imessage`, `line`, `msteams`),
ask the user once — in their language — whether they want this sensor's
replies pushed to one of those chats. If yes, also ask for the recipient
target id (chat id, user id, or platform-specific target — the user knows
this from when they paired the channel; never invent it).

Append to the install command:

```bash
  --deliver-channel <channel_id> \
  --deliver-to <chat_id>
```

Optional: `--deliver-account <id>` for multi-account channels,
`--deliver-thread <id>` to post into a specific thread/topic.

The user can also set this once globally under
`plugins.world2agent.deliver` in `~/.openclaw/openclaw.json`; per-sensor
flags override that default. If the user wants the same target for
everything they're about to install, suggest they set the global default
instead of repeating the flags every time.

### Step 7 — Confirm and tell the user how to activate

If the CLI's `reload` field returns `ok: true`, the sensor is already
polling — done.

If reload failed (timeout is the common case), **DO NOT run
`openclaw gateway restart` yourself**. Restarting the gateway from inside
this chat would kill the gateway process — including this very chat
session — and the user would see your reply truncated mid-sentence. Always
hand the restart back to the user. Tell them — in **their** language, not
necessarily English — something equivalent to:

> The sensor is registered, but it needs a gateway restart before it
> starts polling. Please run `openclaw gateway restart` in your terminal
> (I can't run it myself — that command would kill this chat session
> mid-reply). The first signal will arrive within ~60 seconds after the
> restart.

Then summarize for the user:

- **sensor id** that was created (e.g. `hackernews`)
- **where the personalized SKILL.md lives** (`~/.openclaw/skills/<skill_id>/SKILL.md`)
  so they know what to edit later if their preferences change
- **where signal-driven runs will appear**: signals do NOT pollute their
  main chat lane. Each sensor gets its own session lane keyed
  `agent:main:w2a-<sensor_id>` (sessionId `w2a-<sensor_id>`). Tell the
  user to switch to that lane in dashboard
  (<http://127.0.0.1:18789/>) — or run
  `openclaw sessions --agent main --active 60` from CLI — to see
  the agent's responses to incoming signals. The SKILL.md they just
  configured drives those replies.
- **when to expect the first signal** based on the sensor's poll interval

## List sensors

```bash
openclaw world2agent sensor list
```

Returns the manifest plus the current `contextInjection` value.

## Remove a sensor

```bash
openclaw world2agent sensor remove <sensor_id>
```

Add `--purge` only if the user wants the generated handler skill directory
deleted too (this is destructive — confirm first).

## Reload after manual edits

If the user hand-edited `~/.world2agent/sensors.json` or a personalized
SKILL.md, run:

```bash
openclaw world2agent reload
```

If reload fails, fall back to `openclaw gateway restart`.

## Common mistakes to avoid

- Do NOT skip the SETUP.md Q&A flow. Without `[USER_TOPICS]` /
  `[USER_NORMAL_STYLE]` (or whatever the SETUP.md template defines) filled in,
  the agent has no anchor for "what's relevant" and will skip most signals
  silently — burning tokens on `NO_REPLY` turns.
- Do NOT write SKILL.md to `~/.claude/skills/...`. That's the channel-side
  (Claude Code) path. OpenClaw reads from `~/.openclaw/skills/...`.
- Do NOT invent credentials. If SETUP.md asks for an API key, ask the user.
- Do NOT call `sensor add` before writing SKILL.md if you intend to
  personalize. The CLI's fallback will skip when SKILL.md exists, but the
  cleaner ordering is: write SKILL.md first, then `sensor add
  --skip-generate-skill`.

## Output style

After each action, summarize concisely:
- which sensor ids were affected
- whether reload succeeded (or instruct user to restart gateway)
- where the personalized SKILL.md lives, so the user knows what to edit
  later if their preferences change
