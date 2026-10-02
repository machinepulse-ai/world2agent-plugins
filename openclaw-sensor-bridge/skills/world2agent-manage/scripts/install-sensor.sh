#!/usr/bin/env bash
# install-sensor.sh — full install transaction for OpenClaw bridge.
#
# Args:
#   <package>                  full npm package name (positional)
#   --config <inline-json>     sensor config object (mutually exclusive with --config-file)
#   --config-file <path>       JSON file with the sensor config object
#   --skill-md <path>          rendered handler SKILL.md to install at ~/.openclaw/skills/<skill_id>/SKILL.md
#   [--sensor-id <id>]         override; defaults to the short form (strip `@scope/sensor-`)
#   [--agent-id <id>]          OpenClaw agent that owns the lane (default: main)
#   [--session-key <key>]      explicit sessionKey; default: <prefix><sensor_id>
#                              prefix auto-picked from hooks.allowedSessionKeyPrefixes
#                              (preferring `w2a:` then `hook:`)
#   [--model <id>]             model override forwarded to /hooks/agent
#   [--thinking <level>]       /hooks/agent `thinking` field (e.g. low/medium/high)
#   [--timeout-seconds <n>]    /hooks/agent `timeoutSeconds` field; positive integer
#   [--fallbacks <a,b,c>]      comma-separated /hooks/agent `fallbacks` model chain
#   [--notify-channel <ch>]    e.g. imessage / feishu / telegram — paired with --notify-to
#   [--notify-to <handle>]     channel-specific recipient handle
#   [--notify-account <id>]    optional account id when host has multiple
#
# Stdout:  {"ok":true,"package","sensor_id","skill_id","session_key",
#           "agent_id","skill_path","supervisor_reload"}
# Exit:    0 ok / 1 any step fails

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

pkg=""
config_inline=""
config_file=""
skill_md_path=""
sensor_id_arg=""
agent_id_arg=""
session_key_arg=""
model_arg=""
thinking_arg=""
timeout_seconds_arg=""
fallbacks_arg=""
notify_channel=""
notify_to=""
notify_account=""

while [ $# -gt 0 ]; do
  case $1 in
    --config)            config_inline=$2; shift 2;;
    --config-file)       config_file=$2; shift 2;;
    --skill-md)          skill_md_path=$2; shift 2;;
    --sensor-id)         sensor_id_arg=$2; shift 2;;
    --agent-id)          agent_id_arg=$2; shift 2;;
    --session-key)       session_key_arg=$2; shift 2;;
    --model)             model_arg=$2; shift 2;;
    --thinking)          thinking_arg=$2; shift 2;;
    --timeout-seconds)   timeout_seconds_arg=$2; shift 2;;
    --fallbacks)         fallbacks_arg=$2; shift 2;;
    --notify-channel)    notify_channel=$2; shift 2;;
    --notify-to)         notify_to=$2; shift 2;;
    --notify-account)    notify_account=$2; shift 2;;
    --)                  shift; break;;
    -*)                  out_err "unknown flag: $1";;
    *)
      [ -z "$pkg" ] || out_err "extra positional arg: $1"
      pkg=$1; shift;;
  esac
done

if [ -n "$timeout_seconds_arg" ]; then
  [[ "$timeout_seconds_arg" =~ ^[0-9]+$ ]] && [ "$timeout_seconds_arg" -gt 0 ] \
    || out_err "--timeout-seconds must be a positive integer: $timeout_seconds_arg"
fi

fallbacks_json='null'
if [ -n "$fallbacks_arg" ]; then
  fallbacks_json=$(jq -nc --arg s "$fallbacks_arg" \
    '$s | split(",") | map(. | gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))') \
    || out_err "could not parse --fallbacks: $fallbacks_arg"
  jq -e 'length > 0' <<<"$fallbacks_json" >/dev/null 2>&1 \
    || out_err "--fallbacks parsed to an empty list: $fallbacks_arg"
fi

[ -n "$pkg" ] || out_err "usage: install-sensor.sh <package> --config|--config-file ... --skill-md <path> [...]"
[ -n "$skill_md_path" ] || out_err "--skill-md is required"

if { [ -n "$notify_channel" ] && [ -z "$notify_to" ]; } || \
   { [ -z "$notify_channel" ] && [ -n "$notify_to" ]; }; then
  out_err "--notify-channel and --notify-to must be provided together (use both or neither)"
fi

# Auto-detect a default delivery target when neither --notify-channel nor
# --notify-to is supplied. Reads ~/.openclaw/.env for the first
# <PLATFORM>_HOME_CHANNEL=<handle> entry in priority order — same convention
# hermes-sensor-bridge uses, so users with paired chat platforms get signals
# pushed to their actual inbox by default instead of disappearing into a
# session lane only the dashboard surfaces.
if [ -z "$notify_channel" ] && [ -z "$notify_to" ]; then
  env_file="$(openclaw_home)/.env"
  if [ -f "$env_file" ]; then
    for plat in feishu imessage telegram slack discord signal whatsapp wecom dingtalk; do
      var=$(printf '%s_HOME_CHANNEL' "$plat" | tr '[:lower:]' '[:upper:]')
      home=$(grep -E "^${var}=" "$env_file" 2>/dev/null | head -1 \
        | sed -E "s/^${var}=//; s/^['\"]//; s/['\"]$//") || home=""
      if [ -n "$home" ]; then
        notify_channel=$plat
        notify_to=$home
        break
      fi
    done
  fi
fi

if [ -n "$config_inline" ] && [ -n "$config_file" ]; then
  out_err "pass exactly one of --config and --config-file"
fi
if [ -n "$config_file" ]; then
  [ -f "$config_file" ] || out_err "config file not found: $config_file"
  config_json=$(cat "$config_file")
elif [ -n "$config_inline" ]; then
  config_json=$config_inline
else
  config_json='{}'
fi
jq -e 'type == "object"' <<<"$config_json" >/dev/null 2>&1 \
  || out_err "config must be a valid JSON object"

validate_package_name "$pkg"
skill_id=$(package_to_skill_id "$pkg")
sensor_id=${sensor_id_arg:-$(package_to_default_sensor_id "$pkg")}
[[ "$sensor_id" =~ ^[a-z0-9][a-z0-9_-]*$ ]] \
  || out_err "sensor_id must match [a-z0-9][a-z0-9_-]*: $sensor_id"

agent_id=${agent_id_arg:-main}
[[ "$agent_id" =~ ^[a-z0-9][a-z0-9._-]*$ ]] \
  || out_err "agent_id must be a safe identifier: $agent_id"

# Frontmatter check on the rendered handler skill.
fm_err=$(assert_skill_frontmatter "$skill_md_path" "$skill_id" 2>&1) \
  || out_err "skill_md frontmatter check failed: $fm_err"

# Verify OpenClaw hooks are configured before we write anything to the
# manifest — better to fail loudly here than to write an entry the
# supervisor will reject on apply.
hooks_err=$(openclaw_hooks_ready 2>&1) && hooks_err=""
if [ -n "$hooks_err" ]; then
  out_err "OpenClaw hooks not ready: $hooks_err. Run scripts/bootstrap.sh for setup hints."
fi

# Resolve sessionKey + verify against the gateway's allowlist.
session_key=$session_key_arg
if [ -z "$session_key" ]; then
  prefix=$(default_session_key_prefix)
  session_key="${prefix}${sensor_id}"
fi
allowed=$(jq -c '.hooks.allowedSessionKeyPrefixes // []' "$(openclaw_config_path)")
matches=$(jq -nc \
  --arg sk "$session_key" \
  --argjson allowed "$allowed" \
  '$allowed | map(select($sk | startswith(.))) | length > 0')
[ "$matches" = "true" ] \
  || out_err "session_key \"$session_key\" doesn't match any of hooks.allowedSessionKeyPrefixes ($(jq -c <<<"$allowed")). Add a matching prefix to $(openclaw_config_path) or pass --session-key explicitly."

[ -f "$(bridge_state_path)" ] \
  || out_err "$(bridge_state_path) missing; run scripts/bootstrap.sh first"

# Step 1: ensure the sensor package is installed under the W2A npm root.
npm_root=$(w2a_npm_root)
mkdir -p "$npm_root"
log=$(mktemp)
if ! npm install --prefix "$npm_root" --no-audit --no-fund "$pkg" >"$log" 2>&1; then
  cat "$log" >&2; rm -f "$log"
  out_err "fetching $pkg failed"
fi
rm -f "$log"
pkg_dir="$npm_root/node_modules/$pkg"
[ -d "$pkg_dir" ] || out_err "$pkg_dir does not exist after the fetch"

# Step 2: write handler SKILL.md to ~/.openclaw/skills/<skill_id>/SKILL.md
# so OpenClaw auto-loads it when the agent turn references the skill.
skill_dir="$(openclaw_home)/skills/$skill_id"
mkdir -p "$skill_dir"
cp "$skill_md_path" "$skill_dir/SKILL.md"

# Step 3: build the _openclaw_bridge block and upsert into config.json.
notify_block='null'
if [ -n "$notify_channel" ]; then
  notify_block=$(jq -nc \
    --arg ch "$notify_channel" \
    --arg to "$notify_to" \
    --arg ac "$notify_account" \
    '{channel:$ch,to:$to} + (if $ac == "" then {} else {account:$ac} end)')
fi

timeout_seconds_json='null'
if [ -n "$timeout_seconds_arg" ]; then
  timeout_seconds_json=$timeout_seconds_arg
fi

bridge_block=$(jq -nc \
  --arg sensor_id "$sensor_id" \
  --arg skill_id "$skill_id" \
  --arg agent_id "$agent_id" \
  --arg session_key "$session_key" \
  --arg model "$model_arg" \
  --arg thinking "$thinking_arg" \
  --argjson timeout_seconds "$timeout_seconds_json" \
  --argjson fallbacks "$fallbacks_json" \
  --argjson notify "$notify_block" \
  '{sensor_id:$sensor_id, skill_id:$skill_id}
   + (if $agent_id == "main" then {} else {agent_id:$agent_id} end)
   + {session_key:$session_key}
   + (if $model == "" then {} else {model:$model} end)
   + (if $thinking == "" then {} else {thinking:$thinking} end)
   + (if $timeout_seconds == null then {} else {timeout_seconds:$timeout_seconds} end)
   + (if $fallbacks == null then {} else {fallbacks:$fallbacks} end)
   + (if $notify == null then {} else {notify:$notify} end)')

cfg_path=$(config_json_path)
mkdir -p "$(dirname "$cfg_path")"
[ -f "$cfg_path" ] || printf '{"sensors":[]}\n' >"$cfg_path"

# Upsert by package: keep all OTHER `_<runtime>` blocks on existing entries
# verbatim (so hermes / openclaw-plugin don't lose their state).
new_entry=$(jq -nc \
  --arg pkg "$pkg" \
  --argjson cfg "$config_json" \
  --argjson bridge "$bridge_block" \
  '{package:$pkg, enabled:true, config:$cfg, _openclaw_bridge:$bridge}')

tmp=$(mktemp)
if ! jq --argjson new "$new_entry" '
  .sensors = (
    (.sensors // [])
    | map(if .package == $new.package
          then ((. // {}) + ($new // {}))
          else .
          end)
    | if any(.package == $new.package) then . else . + [$new] end
  )' "$cfg_path" >"$tmp"; then
  rm -f "$tmp"; out_err "could not upsert $cfg_path"
fi
mv "$tmp" "$cfg_path"

# Step 4: nudge supervisor (file watcher would also pick it up).
reload_result=$(control_request POST /_w2a/reload 2>/dev/null || true)
if [ -z "$reload_result" ] || ! jq -e . <<<"$reload_result" >/dev/null 2>&1; then
  reload_result='null'
fi

# Surface the resolved delivery target so the SKILL/agent can give the user
# accurate post-install feedback. Without this, a sensor that silently fell
# back to "dashboard-only" looks identical to a fully-wired push sensor in
# the script output — agent reports "installed!" and the user never realises
# signals aren't being pushed anywhere.
if [ -n "$notify_channel" ]; then
  delivery_json=$(jq -nc \
    --arg ch "$notify_channel" \
    --arg to "$notify_to" \
    '{mode:"push", channel:$ch, to:$to}')
else
  delivery_json='{"mode":"dashboard-only","channel":null,"to":null}'
fi

out_ok "$(jq -nc \
  --arg pkg "$pkg" \
  --arg sensor_id "$sensor_id" \
  --arg skill_id "$skill_id" \
  --arg session_key "$session_key" \
  --arg agent_id "$agent_id" \
  --arg skill_path "$skill_dir/SKILL.md" \
  --argjson reload "$reload_result" \
  --argjson delivery "$delivery_json" \
  '{package:$pkg,sensor_id:$sensor_id,skill_id:$skill_id,session_key:$session_key,agent_id:$agent_id,skill_path:$skill_path,supervisor_reload:$reload,delivery:$delivery}')"
