# @world2agent/openclaw-plugin

Native OpenClaw plugin for running World2Agent sensors and dispatching their signals into dedicated agent session lanes — **never into your main chat session**.

The default path is in-process: enabled sensors are imported directly inside the plugin process. Each emitted signal is wrapped in a `# System Event` markdown frame and dispatched via OpenClaw's `runtime.subagent.run` (or `runtime.agent.runEmbeddedAgent` for older runtimes). The framed signal lives in user-role position within a per-sensor lane keyed `agent:<defaultAgentId>:w2a-<sensor_id>`, but the framing makes the agent treat it as an external notification rather than a user message.

When [`deliver`](#pushing-replies-to-a-chat-platform-lark--whatsapp--telegram--) is configured, the same path also pushes the assistant reply back to a chat platform (lark / feishu / whatsapp / telegram / …) via the `subagent.run({ deliver: true })` flag — OpenClaw resolves the channel target from the session entry's `deliveryContext` we wrote.

`isolated: true` is opt-in and reuses the Hermes bridge runner/supervisor patterns for subprocess execution plus plugin-local HTTP ingest. (See [caveat](#pushing-replies-to-a-chat-platform-lark--whatsapp--telegram--) — `deliver` currently does not work for isolated sensors.)

## Install

> ⚠️ OpenClaw config is **JSON**, not YAML. All steps below assume `~/.openclaw/openclaw.json`.

### 1. Install the plugin

> ⚠️ The plugin uses `child_process` for sensor subprocess management (required for `isolated: true` mode and for npm install/uninstall of sensor packages). OpenClaw's built-in security scan **blocks** plugins with `child_process` by default. The output will show a wall of `WARNING` lines listing every `child_process` site — **that is expected**. The actual success markers are at the bottom: `Linked plugin path` (or `Installed plugin`) and `Restart the gateway to load plugins`.

#### Standard (from npm)

```bash
openclaw plugins install @world2agent/openclaw-plugin --dangerously-force-unsafe-install
openclaw gateway restart
```

Verify it loaded:

```bash
openclaw plugins list | grep world2agent
# → │ World2Agent │ world2agent │ openclaw │ enabled │ ... │ 0.1.0-alpha.0 │
openclaw world2agent --help
# → Commands: reload, sensor
```

### 2. Subscribe to your first source — by talking to OpenClaw

> ℹ️ By default W2A signals lane through your **existing `main` agent** but on a different sessionKey (one per sensor), so they don't pollute your normal chat session. If you'd rather route them to a dedicated agent for full isolation, set `defaultAgentId: "world2agent"` (or any other id) in this plugin's config and `openclaw agents add <id>` first.

The preferred path is conversational. Just tell main agent what you want:

```bash
openclaw chat --agent main
```

```
> subscribe me to Hacker News — I care about AI and security stories
```

The plugin ships a `world2agent-manage` skill that activates on this kind of intent. Main agent will:

1. Read the sensor's `SETUP.md` (e.g. `node_modules/@world2agent/sensor-hackernews/SETUP.md`)
2. Ask you 1–3 questions defined in that file (poll thresholds, your topics of interest, reply depth)
3. Fill the SKILL.md template with your answers and write it to `~/.openclaw/skills/world2agent-sensor-hackernews/SKILL.md`
4. Run `openclaw world2agent sensor add ... --skip-generate-skill` to register
5. Run `openclaw world2agent reload` so the running plugin picks up the new
   sensor (this is the normal path — adding a sensor only mutates
   `~/.world2agent/sensors.json`, the plugin's own config in
   `~/.openclaw/openclaw.json` is untouched)
6. If reload returns `ok: false` (e.g. the gateway-call socket times out),
   ask **you** to run `openclaw gateway restart` in **your own terminal**
   as a fallback. The agent never runs `gateway restart` itself —
   restarting from inside the chat would terminate the reply mid-sentence
7. Tell you when the first signal will arrive **and which session lane to
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

Within seconds of the reload (or restart), the sensor's first poll fires; subsequent polls follow the sensor's `interval_seconds` (e.g. 300 for `@world2agent/sensor-hackernews`). Each emitted signal triggers an agent turn under sessionKey `agent:main:w2a-<sensor>`, with the signal framed as a `# System Event` block.

## Where to view signal-driven agent runs

Each sensor gets its own session lane, separate from your main chat. The
lane is keyed `agent:<defaultAgentId>:w2a-<sensor_id>` (e.g.
`agent:main:w2a-hackernews`), with stable session id `w2a-<sensor_id>`. The
plugin dispatches signals via OpenClaw's embedded-agent runtime
(`runtime.subagent.run` when `deliver` is configured, otherwise
`runtime.agent.runEmbeddedAgent`) with a `# System Event` markdown frame
in the prompt, so the signal lives in user-role position within the W2A
session lane — but **never in your main chat session** (`agent:main:main`
is untouched).

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

## Pushing replies to a chat platform (Lark / WhatsApp / Telegram / …)

By default a sensor-driven turn stays inside the W2A session lane — the agent's
reply is only visible in `openclaw sessions --agent main` / the dashboard.

If you've already paired a chat platform (any plugin in `openclaw plugins list
--json` with a non-empty `channelIds` array — feishu, lark, whatsapp, telegram,
discord, slack, signal, imessage, line, msteams, matrix, …), you can have the
plugin route the assistant reply back to that chat. There are two grains:

**Plugin-wide default** — every sensor's reply lands in the same chat. Set in
this plugin's config block in `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "world2agent": {
      "deliver": {
        "channel": "feishu",
        "to": "oc_chat_xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

**Per-sensor override** — different sensors push to different chats. Pass at
install time:

```bash
openclaw world2agent sensor add @world2agent/sensor-hackernews \
  --config-json '{"top_n":10,"min_score":50}' \
  --deliver-channel feishu \
  --deliver-to oc_chat_xxxxxxxxxxxxxxxx
```

Optional flags: `--deliver-account <id>` for multi-account channels,
`--deliver-thread <id>` to post into a specific thread/topic.

When `deliver` is set, the plugin (a) writes `lastChannel` / `lastTo` /
`deliveryContext` onto the W2A session entry and (b) dispatches via
`runtime.subagent.run({ sessionKey, message, deliver: true })` instead of
the lower-level `runEmbeddedAgent`. The subagent path internally pairs
`runEmbeddedAgent` with `deliverAgentCommandResult` — that second step is
what actually reads `sessionEntry.deliveryContext` and invokes the channel
plugin's send. `runEmbeddedAgent` alone would produce a transcript reply
but never push it outbound. No second LLM call, no plugin-side IM client.

If `deliver` is not set, the reply stays in the W2A session lane (visible
in the dashboard, no IM push). If the named channel plugin isn't loaded,
the run still completes but OpenClaw's outbound resolver refuses to send
— check `openclaw plugins list --json` to confirm the channel id matches
an enabled plugin.

> ⚠️ **Known limitation — `deliver` does not currently apply to
> `isolated: true` sensors.** Subprocess sensors route signals through
> the plugin-local `/w2a/ingest` HTTP route, and that handler's call to
> `runtime.subagent.run` is rejected with `missing scope: operator.write`
> (in-process plugin calls have the scope; HTTP-route plugin calls do
> not). Those runs fall back to plain `runEmbeddedAgent` and the reply
> stays in the session lane only. In-process sensors (the default) push
> to the channel correctly.

## Relation to `hermes-sensor-bridge`

`hermes-sensor-bridge` solved the same World2Agent runtime problem for Hermes with webhook subscriptions plus supervised subprocesses. This package keeps the same manifest shape and reuses the runner/supervisor mechanics for `isolated: true`, but the primary OpenClaw path is simpler: native plugin registration plus `runtime.subagent.run` (which internally pairs `runEmbeddedAgent` with OpenClaw's outbound delivery resolver) — no separate gateway, no HMAC ingest, no platform bootstrap.

## Troubleshooting

**Plugin install blocked by safety scanner**: that's the security warning about `child_process`. Use `--dangerously-force-unsafe-install` (see [§ Install the plugin](#1-install-the-plugin)).

**`openclaw world2agent --help` says "unknown command"**: gateway hasn't reloaded the plugin yet. Run `openclaw gateway restart`.

**Sensors run but `openclaw sessions --agent main` shows no `w2a-<sensor>` lane**: the plugin manifest reload may have timed out. Verify with `openclaw world2agent sensor list` that the sensor is in the manifest, and grep `/tmp/openclaw/openclaw-*.log` for `[w2a/<sensor>]` to see emit / dispatch / dispatch failed lines. If you set `defaultAgentId: "world2agent"` in this plugin's config, replace `--agent main` with `--agent world2agent` and make sure that agent exists in `agents.list` (`openclaw agents add world2agent` once before reload).

**Wizards or interactive commands hang on the same terminal as the gateway**: sensor logs go to a namespaced logger, but very early gateway boot output still goes to stdout. Run interactive commands (`openclaw agents add ...`) from a terminal that isn't tailing gateway logs.

**Replies don't reach the configured chat platform (`deliver` set but nothing arrives)**: first confirm the relevant in-process emit produced a non-empty assistant reply (NO_REPLY / empty content correctly suppresses delivery). If the reply is non-empty but no message lands, check that `openclaw plugins list --json` shows the named channel as enabled, and that `~/.openclaw/agents/<agentId>/sessions/sessions.json` for your sensor's lane has `lastChannel` / `lastTo` / `deliveryContext` matching your config — the plugin writes those fields on every dispatch. If they're missing, the plugin loaded an older dist (before this feature) — rebuild and re-link.
