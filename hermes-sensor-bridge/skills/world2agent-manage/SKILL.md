---
name: world2agent-manage
description: |
  Install, list, and remove World2Agent sensors on this Hermes machine.
  Trigger whenever the user wants to subscribe to / watch / be notified about
  an outside-world source (Hacker News, GitHub, X, market data, RSS, papers,
  etc.) or wants to manage their existing W2A sensors.
version: 0.2.0
---

# World2Agent sensor management

You manage the user's W2A sensors. **All host-side work is delegated to shell
scripts in `scripts/` — you never run `npm install`, `hermes webhook
subscribe`, jq mutations, curl calls, or YAML edits inline.** Your job is:

1. Decide which script to run, with which args.
2. Run it via `bash <abs-path>` (the scripts ship without the executable bit).
3. Parse the JSON the script prints on stdout — every script except `log.sh`
   emits exactly one JSON object, either `{"ok":true,...}` or
   `{"ok":false,"error":"..."}`.
4. Branch on the result, ask the user when needed, generate handler content
   yourself when needed.

## Script path

The canonical install location is `~/.hermes/skills/world2agent-manage/scripts/`.
A developer override via the `WORLD2AGENT_MANAGE_SCRIPTS` env var is honored
in case you're testing against an unpacked checkout. Use this expansion in
every invocation so both work in one line:

```bash
"${WORLD2AGENT_MANAGE_SCRIPTS:-$HOME/.hermes/skills/world2agent-manage/scripts}/<name>.sh"
```

(Examples below abbreviate this to `$SCRIPTS/<name>.sh` for readability.)

## Conversation language

Run the entire Q&A in **the user's current conversation language**. Translate
SETUP.md questions before asking. Don't dump English questions on a Chinese
user, or vice versa.

---

## Pre-flight: bootstrap

**Before any sensor install or remove, call `bootstrap.sh` once.** It is
idempotent; second runs just confirm existing state.

```bash
bash "$SCRIPTS/bootstrap.sh"
```

What it does:

- verifies `world2agent-hermes-supervisor` and `world2agent-sensor-runner`
  are on PATH;
- creates / preserves `~/.world2agent/.bridge-state.json`
  (`hmac_secret` / `control_token` / `control_port`, mode 0600);
- writes a managed `platforms.webhook` block to `~/.hermes/config.yaml`
  (refuses if the user has a hand-written top-level `platforms:` block);
- mirrors the same secret to `~/.hermes/.env`;
- starts the supervisor (foreground, `nohup`-detached).

Output shape:

```json
{
  "ok": true,
  "steps": {
    "binary": "present",
    "state": "created" | "present",
    "config_yaml": "wrote-managed-block" | "managed-block-exists" | "hand-written-already-enabled",
    "env": "wrote-managed-block" | "managed-block-exists",
    "supervisor": "started" | "already-running" | "started-but-not-yet-healthy" | "start-failed"
  },
  "hermes_home": "...",
  "webhook_port": 8644
}
```

Failure modes that need a user message:

- `error: "world2agent-hermes-supervisor / world2agent-sensor-runner not on PATH..."`
  → tell the user to run `npm install -g @world2agent/hermes-sensor-bridge`.
- `error: "<file> has a hand-written 'platforms:' block. Refusing to merge..."`
  → tell the user to add a `webhook:` subkey under their existing
  `platforms:` themselves, or run `hermes gateway setup`.

---

## Install a sensor — full flow

### Step 1: install package and read its SETUP.md

```bash
bash "$SCRIPTS/read-setup.sh" "<package>"
```

Returns `{"ok":true,"package","package_dir","skill_id","setup_md_present","setup_md"}`.
If `setup_md_present` is false, fall back to reading `<package_dir>/README.md`
yourself for config knobs.

### Step 2: SETUP.md Q&A in the user's language

Walk the questions one at a time. Record answers as a JSON object (this
becomes the sensor's `config`). Never invent credentials — if SETUP.md asks
for an API key, ask the user explicitly. Write the answers to a temp file
(`mktemp` works fine):

```bash
config_file=$(mktemp)
cat >"$config_file" <<'JSON'
{ "field_a": "...", "field_b": "..." }
JSON
```

### Step 3: choose delivery mode

Three options:

| Mode | Effect | Pick when |
|---|---|---|
| `log` | Agent runs the handler skill; the response lands in `~/.hermes/logs/agent.log`. The handler decides whether to notify (e.g., by calling `telegram_send_*`). | User has no chat paired, or wants the skill itself to gate notifications. |
| `agent` + deliver (**default**) | Agent runs, response auto-delivered to `<platform>` + `<chat-id>`. | User wants every signal piped to a specific chat after agent processing. |
| `deliver-only` | Skip agent entirely; render `--prompt` template literal and dispatch. Zero LLM cost, sub-second. | High-volume self-contained signals (alerts, scoreboards). |

**Default behavior:** if you don't pass `--deliver`, `install-sensor.sh`
auto-detects the first non-empty `<PLATFORM>_HOME_CHANNEL` in
`~/.hermes/.env` (priority order: `feishu`, `telegram`, `discord`, `slack`,
`signal`, `whatsapp`, `wecom`, `dingtalk`) and uses `agent + deliver` mode
with that chat as the target. Only when no home channel is configured does
it fall back to `log`. So **don't ask the user about delivery mode unless
they bring it up** — the env var is a strong signal that they've already
chosen their preferred channel during platform setup.

Pass `--deliver log` explicitly if the user wants log-only despite having
a paired channel, or `--deliver-only` for zero-LLM dispatch.

### Step 4: compose the handler SKILL.md

Most SETUP.md files include a SKILL template. Fill it with the user's
answers. The frontmatter **must** have:

- `name: <skill_id>` — exactly the value Step 1 returned in `.skill_id`
  (`package_to_skill_id(package)`); the install script will refuse if these
  don't match.
- `user-invocable: false` — keeps the handler off the user's `/` autocomplete.
- `description:` one line stating which signals the handler covers.

Write the rendered SKILL to a temp file:

```bash
skill_file=$(mktemp --suffix=.md 2>/dev/null || mktemp)
cat >"$skill_file" <<'MD'
---
name: <skill_id>
description: ...
user-invocable: false
---

# Handler for <skill_id>
... your prose ...
MD
```

### Step 5: install

```bash
bash "$SCRIPTS/install-sensor.sh" "<package>" \
  --config-file "$config_file" \
  --skill-md "$skill_file" \
  [--sensor-id <id>] \
  [--deliver <platform>] \
  [--deliver-chat-id "<id>"] \
  [--deliver-only]
```

Successful output:

```json
{
  "ok": true,
  "package": "...",
  "sensor_id": "...",
  "skill_id": "...",
  "subscription_name": "world2agent-<sensor_id>",
  "webhook_url": "http://127.0.0.1:8644/webhooks/...",
  "skill_path": "/.../SKILL.md",
  "supervisor_reload": { ... } | null
}
```

`supervisor_reload` may be `null` when the supervisor's control HTTP isn't
reachable from this process — that's fine, the supervisor's file watcher
picks up the new `~/.world2agent/config.json` entry within ~500 ms anyway.

If the install script refuses with a frontmatter mismatch, fix the rendered
SKILL's `name` and retry.

### Step 6: report to the user

One sentence: `Installed <package> (subscription <sub>); next matching
signal will trigger an agent run.`

---

## Remove a sensor

```bash
bash "$SCRIPTS/remove-sensor.sh" "<package>" [--purge]
```

`--purge` additionally `rm -rf`s the handler skill directory and runs
`npm uninstall` — only pass it when the user explicitly wants a clean wipe.

Output shapes:

- `{"ok":true,"package":"...","removed":true,"subscription_name":"...","subscription_removed":true,"supervisor_reload":...,"purged":{"skill":bool,"npm":bool,"npm_error":null|"..."}}`
- `{"ok":true,"package":"...","removed":false,"reason":"not in config.json"}` —
  not installed; tell the user that and stop.

---

## List installed sensors

```bash
bash "$SCRIPTS/list-sensors.sh"
```

Returns:

```json
{
  "ok": true,
  "sensors": [/* full entries from ~/.world2agent/config.json */],
  "runtime": { /* /_w2a/list output */ } | null,
  "runtime_error": null | "..."
}
```

`sensors` is the source of truth (config). `runtime` is the supervisor's
live view of subprocess handles; if the supervisor is down, that's `null`
and `runtime_error` says why — that does NOT mean the sensors are broken,
only that the supervisor isn't reachable right now.

---

## Diagnose

```bash
bash "$SCRIPTS/status.sh"
```

Always exits 0. Returns supervisor health + control-HTTP probe results +
`hermes webhook list`. Use this when the user reports "my sensor isn't
working" — it'll quickly show whether the supervisor is alive, whether the
subscription exists in Hermes, and what handles the supervisor knows about.

---

## Tail logs

`log.sh` is the **one script that does NOT emit JSON** — it streams raw log
lines so you can forward them to the user as-is.

```bash
bash "$SCRIPTS/log.sh"                    # last 200 lines, all sensors
bash "$SCRIPTS/log.sh" -n 500             # last 500 lines
bash "$SCRIPTS/log.sh" "<sensor_id>"      # only [w2a/<sensor_id>] lines
bash "$SCRIPTS/log.sh" -f "<sensor_id>"   # follow mode (BLOCKS; use sparingly)
```

Avoid `-f` unless the user explicitly asks to live-tail — it never returns.

---

## Persistent autostart (only if user asks)

`bootstrap.sh` starts the supervisor under `nohup`, which dies on reboot.
For a daemon that survives login:

```bash
bash "$SCRIPTS/install-launchd.sh"     # macOS — writes ~/Library/LaunchAgents/dev.world2agent.hermes-supervisor.plist
bash "$SCRIPTS/install-systemd.sh"     # Linux — writes ~/.config/systemd/user/world2agent-hermes-supervisor.service
```

Reverse with:

```bash
bash "$SCRIPTS/uninstall-bootstrap.sh"
```

That removes the plist/unit, the managed `platforms.webhook` block from
`config.yaml`, and the managed mirror in `.env`. It does **not** touch
`~/.world2agent/` (sensor configs and bridge state stay; that's
`remove-sensor.sh`'s job).

---

## Manual lifecycle (rare)

```bash
bash "$SCRIPTS/start.sh"   # via launchd / systemd / nohup, in that order
bash "$SCRIPTS/stop.sh"    # SIGTERM / launchctl bootout / systemctl stop
```

Both idempotent. When the user is troubleshooting, prefer `status.sh` first.

---

## Validation rules and gotchas

- **Package name regex** (enforced by every script that takes a `<package>`):
  `^(@scope/)?name$` over `[a-z0-9._-]`, no whitespace, no shell metas, no
  `..`, no URL schemes. **If a script refuses, do NOT "sanitize" the name
  yourself** — ask the user to re-issue.
- **`INSECURE_NO_AUTH`**: never set the bridge HMAC secret to this magic
  value. It disables HMAC checks on the supervisor → Hermes hop. Only OK in
  bridge e2e tests.
- **Static routes win**: if the user has a hand-written webhook route in
  `~/.hermes/config.yaml` with the same name as our auto-generated
  `world2agent-<sensor_id>`, the static route takes precedence and our
  dynamic subscription has no effect. Notice and tell them.
- **Reconciliation triggers a restart**: editing `.config` for an entry in
  `~/.world2agent/config.json` causes the supervisor to terminate + respawn
  that sensor (config-hash mismatch). Don't edit the file casually mid-session.
- **Rate limits**: Hermes webhook routes default to 30 req/min per route.
  If a sensor is high-frequency (market ticks, real-time chat), suggest
  bumping `extra.rate_limit` in `~/.hermes/config.yaml`.
- **Hot-reload, not gateway restart**: `install-sensor.sh` / `remove-sensor.sh`
  do NOT need a gateway restart — Hermes hot-reloads
  `~/.hermes/webhook_subscriptions.json` on every incoming request. A
  restart is only needed when `bootstrap.sh` writes the managed block for
  the first time (the `platforms.webhook.*` config has changed); tell the
  user once after the initial `bootstrap.sh` to run `hermes gateway restart`.

## Output style

After each action, summarize in one or two sentences. Don't dump JSON unless
the user asks. If a script returned `ok:false`, paraphrase the `error` and
suggest the next step.
