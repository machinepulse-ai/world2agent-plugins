# @world2agent/openclaw-plugin

Native OpenClaw plugin for running World2Agent sensors and dispatching their signals into OpenClaw agent turns as **system events** (not user messages).

The default path is in-process: enabled sensors are imported directly inside the plugin process, and each emitted signal is enqueued as a system event for a dedicated agent. OpenClaw drains queued system events at the start of the next agent turn and prepends them to the prompt as `System:` lines — matching the semantics `claude-code-channel` uses with MCP `notifications/claude/channel`.

`isolated: true` is opt-in and reuses the Hermes bridge runner/supervisor patterns for subprocess execution plus plugin-local HTTP ingest.

## Install

> ⚠️ OpenClaw config is **JSON**, not YAML. All steps below assume `~/.openclaw/openclaw.json`.

### 1. Set the contextInjection prerequisite

The plugin refuses to start unless `agents.defaults.contextInjection` is exactly `"continuation-skip"` (otherwise OpenClaw's default `"always"` re-injects bootstrap on every signal and silently turns sensors into a token sink).

```bash
# Edit in place (no `sponge` dependency — works on stock macOS / Linux)
jq '.agents.defaults.contextInjection = "continuation-skip"' \
  ~/.openclaw/openclaw.json > /tmp/openclaw.json.tmp && \
  mv /tmp/openclaw.json.tmp ~/.openclaw/openclaw.json

# Verify
jq '.agents.defaults.contextInjection' ~/.openclaw/openclaw.json
# → "continuation-skip"
```

### 2. Install the plugin

> ⚠️ The plugin uses `child_process` for sensor subprocess management (required for `isolated: true` mode and for npm install/uninstall of sensor packages). OpenClaw's built-in security scan **blocks** plugins with `child_process` by default. The output will show a wall of `WARNING` lines listing every `child_process` site — **that is expected**. The actual success markers are at the bottom: `Linked plugin path` (or `Installed plugin`) and `Restart the gateway to load plugins`.

#### Standard (from npm)

```bash
openclaw plugins install @world2agent/openclaw-plugin --dangerously-force-unsafe-install
openclaw gateway restart
```

#### Contributors / pre-release testing (from local source)

If you're hacking on this plugin and haven't published to npm yet:

```bash
cd world2agent-plugins/openclaw-plugin
pnpm install
pnpm build

# Use an ABSOLUTE path. OpenClaw's `plugins install` also accepts hook packs
# (a different concept) — a relative or `~` path can be misclassified and
# yield a confusing "HOOK.md missing in ..." error. Absolute path tells
# OpenClaw "this is the plugin you just built."
openclaw plugins install -l --dangerously-force-unsafe-install \
  "$(pwd)"
openclaw gateway restart
```

Verify it loaded:

```bash
openclaw plugins list | grep world2agent
# → │ World2Agent │ world2agent │ openclaw │ enabled │ ... │ 0.0.0-dev │
openclaw world2agent --help
# → Commands: reload, sensor
```

### 4. Subscribe to your first source — by talking to OpenClaw

> ℹ️ By default W2A signals lane through your **existing `main` agent** but on a different sessionKey (one per sensor), so they don't pollute your normal chat session. If you'd rather route them to a dedicated agent for full isolation, set `defaultAgentId: "world2agent"` (or any other id) in this plugin's config and `openclaw agents add <id>` first.

The preferred path is conversational. Just tell main agent what you want:

```bash
openclaw chat --agent main
```

```
> 帮我订阅 Hacker News，我关心 AI 和安全话题
```

The plugin ships a `world2agent-manage` skill that activates on this kind of intent. Main agent will:

1. Read the sensor's `SETUP.md` (e.g. `node_modules/@world2agent/sensor-hackernews/SETUP.md`)
2. Ask you 1–3 questions defined in that file (poll thresholds, your topics of interest, reply depth)
3. Fill the SKILL.md template with your answers and write it to `~/.openclaw/skills/world2agent-sensor-hackernews/SKILL.md`
4. Run `openclaw world2agent sensor add ... --skip-generate-skill` to register
5. Ask **you** to run `openclaw gateway restart` in your terminal (the agent
   intentionally does NOT run this itself — restarting the gateway from
   inside the chat would kill this very chat session mid-reply)
6. Tell you when the first signal will arrive **and which session lane to
   open in dashboard** to see the agent's replies (signals route to a
   separate `w2a-<sensor>` session, not your main chat — see
   ["Where to view signal-driven agent runs"](#where-to-view-signal-driven-agent-runs) below)

This personalized SKILL.md is what makes the agent reply meaningfully to relevant signals (instead of skipping every signal silently because it has no anchor for "what's relevant to this user").

#### CLI fallback (power users / scripting)

If you want to script the install or skip the Q&A, you can still call the CLI directly:

```bash
openclaw world2agent sensor add @world2agent/sensor-hackernews \
  --config-json '{"top_n":10,"min_score":50,"min_comments":0,"interval_seconds":60}'
```

Without `--skip-generate-skill`, the CLI will write a **generic** SKILL.md to `~/.openclaw/skills/world2agent-sensor-hackernews/SKILL.md` (only if no SKILL.md is already there). The generic skill makes the agent reply briefly to every signal — fine for testing, noisy for daily use. Edit that file later to add filtering rules.

> ⚠️ Plugin config is cached at register time — newly-added sensors are visible to the running plugin only after a reload:

```bash
openclaw world2agent reload
# falls back to `openclaw gateway restart` if reload times out
```

> ⚠️ **Run the restart in your own terminal — never inside an OpenClaw chat session.** `openclaw gateway restart` kills the gateway process, which terminates any in-flight chat reply mid-sentence. The conversational install path explicitly hands the restart back to the user for this reason.

Within ~60 seconds of the restart, the sensor will start polling. Each emitted signal triggers an agent turn under sessionKey `agent:main:w2a-<sensor>`, with the signal framed as a `# System Event` block.

## Where to view signal-driven agent runs

Each sensor gets its own session lane, separate from your main chat. The
lane is keyed `agent:<defaultAgentId>:w2a-<sensor_id>` (e.g.
`agent:main:w2a-hackernews`), with stable session id `w2a-<sensor_id>`. The
plugin dispatches signals via `runEmbeddedAgent` with a `# System Event`
markdown frame in the prompt, so the signal lives in user-role position
within the W2A session — but **never in your main chat session**.

Concrete: if you ran the conversational install for Hacker News, look for
the `w2a-hackernews` session, not `main`. Your `main` chat is untouched.

```bash
# CLI — list W2A sessions on the main agent (with last-active filter)
openclaw sessions --agent main --active 60
# expected to include: w2a-hackernews

# Dashboard — open OpenClaw's control UI, then switch to the
# `w2a-hackernews` (or w2a-<your sensor>) session in the sidebar
open http://127.0.0.1:18789/

# Direct file access (for debugging)
ls ~/.openclaw/agents/main/sessions/
# w2a-hackernews.jsonl              ← signal-handling transcript
# w2a-hackernews.trajectory.jsonl   ← full LLM tool-call trajectory
# sessions.json                     ← OpenClaw session index (lists both
#                                     `agent:main:main` chat lane AND
#                                     `agent:main:w2a-<sensor>` lanes)
```

Your normal chat with the `main` agent (sessionKey `agent:main:main`) is
**untouched** — W2A signals only show up under `agent:main:w2a-<sensor_id>`
lanes. Open one of those lanes to see how the agent is reacting to
incoming signals; that's where you'll spot whether your handler SKILL.md
needs tuning.

## Scope

- Reads and writes the W2A sensor manifest at `~/.world2agent/sensors.json` by default.
- Runs sensors in-process unless a sensor entry sets `isolated: true`.
- Reuses the Hermes runner/supervisor patterns instead of inventing a second isolation protocol.
- Uses a stable per-sensor session id: `w2a-<sensor_id>` (and session key `agent:<defaultAgentId>:w2a-<sensor_id>`).
- Requires plugin config `ingestUrl` only when `isolated: true` sensors are used.

## ContextInjection Prerequisite

This plugin refuses to start unless `agents.defaults.contextInjection` is exactly `"continuation-skip"`.

That check also runs before `openclaw world2agent sensor add`. There is no warning mode, no fallback mode, and no override flag. The design requires a hard failure because OpenClaw's default `"always"` setting would re-inject bootstrap on every sensor signal and silently turn high-frequency sensors into a token sink.

## Relation to `hermes-sensor-bridge`

`hermes-sensor-bridge` solved the same World2Agent runtime problem for Hermes with webhook subscriptions plus supervised subprocesses. This package keeps the same manifest shape and reuses the runner/supervisor mechanics for `isolated: true`, but the primary OpenClaw path is simpler: native plugin registration plus `enqueueSystemEvent(...)` + `runEmbeddedAgent(...)`.

## Troubleshooting

**Plugin install blocked by safety scanner**: that's the security warning about `child_process`. Use `--dangerously-force-unsafe-install` (see step 3).

**`openclaw world2agent --help` says "unknown command"**: gateway hasn't reloaded the plugin yet. Run `openclaw gateway restart`.

**Sensors run but `openclaw sessions --agent world2agent` is empty**: you skipped step 4 (`openclaw agents add world2agent`) or step 5's `openclaw world2agent reload`. Each sensor's `dispatch failed` will be logged in `/tmp/openclaw/openclaw-*.log` — grep for the sensor id.

**Wizards or interactive commands hang on the same terminal as the gateway**: sensor logs go to a namespaced logger, but very early gateway boot output still goes to stdout. Run interactive commands (`openclaw agents add ...`) from a terminal that isn't tailing gateway logs.
