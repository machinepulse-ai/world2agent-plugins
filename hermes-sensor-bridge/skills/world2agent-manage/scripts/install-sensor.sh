#!/usr/bin/env bash
# install-sensor.sh — full install transaction.
#
# Args:
#   <package>                  full npm package name (positional)
#   --config <inline-json>     sensor config object (mutually exclusive with --config-file)
#   --config-file <path>       JSON file with the sensor config object
#   --skill-md <path>          rendered handler SKILL.md to copy in
#   [--sensor-id <id>]         override; defaults to packageToSkillId(package)
#   [--deliver <platform>]     forwarded to hermes; if omitted, auto-detected
#                              from <PLATFORM>_HOME_CHANNEL in ~/.hermes/.env
#                              (priority: feishu, telegram, discord, slack,
#                              signal, whatsapp, wecom, dingtalk); falls back
#                              to "log" if no home channel is configured.
#   [--deliver-chat-id <id>]   forwarded to hermes; auto-filled from the same
#                              env var when --deliver is auto-detected.
#   [--deliver-only]           skip agent run; --skills is automatically dropped
#
# Stdout:  {"ok":true,"package","sensor_id","skill_id","subscription_name",
#           "webhook_url","skill_path","supervisor_reload"}
# Exit:    0 ok / 1 any step fails

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

pkg="" config_inline="" config_file="" skill_md_path="" sensor_id_arg=""
deliver="" deliver_chat_id="" deliver_only=false

while [ $# -gt 0 ]; do
  case $1 in
    --config)            config_inline=$2; shift 2;;
    --config-file)       config_file=$2; shift 2;;
    --skill-md)          skill_md_path=$2; shift 2;;
    --sensor-id)         sensor_id_arg=$2; shift 2;;
    --deliver)           deliver=$2; shift 2;;
    --deliver-chat-id)   deliver_chat_id=$2; shift 2;;
    --deliver-only)      deliver_only=true; shift;;
    --)                  shift; break;;
    -*)                  out_err "unknown flag: $1";;
    *)
      [ -z "$pkg" ] || out_err "extra positional arg: $1"
      pkg=$1; shift;;
  esac
done

[ -n "$pkg" ] || out_err "usage: install-sensor.sh <package> --config|--config-file ... --skill-md <path> [...]"
[ -n "$skill_md_path" ] || out_err "--skill-md is required"

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
sensor_id=${sensor_id_arg:-$skill_id}
[[ "$sensor_id" =~ ^[a-z0-9][a-z0-9_-]*$ ]] \
  || out_err "sensor_id must match [a-z0-9][a-z0-9_-]*: $sensor_id"

# Frontmatter check: refuse if name doesn't match the skill_id we'll route to.
fm_err=$(assert_skill_frontmatter "$skill_md_path" "$skill_id" 2>&1) \
  || out_err "skill_md frontmatter check failed: $fm_err"

[ -f "$(bridge_state_path)" ] \
  || out_err "$(bridge_state_path) missing; run scripts/bootstrap.sh first"
hmac=$(jq -r '.hmac_secret // empty' "$(bridge_state_path)")
[ -n "$hmac" ] || out_err "hmac_secret missing from $(bridge_state_path)"

# Step 1: npm install (idempotent).
npm_root=$(w2a_npm_root)
mkdir -p "$npm_root"
log=$(mktemp)
if ! npm install --prefix "$npm_root" --no-audit --no-fund "$pkg" >"$log" 2>&1; then
  cat "$log" >&2; rm -f "$log"
  out_err "npm install $pkg failed"
fi
rm -f "$log"
pkg_dir="$npm_root/node_modules/$pkg"
[ -d "$pkg_dir" ] || out_err "$pkg_dir does not exist after npm install"

# Step 2: write handler SKILL.md.
skill_dir="$(hermes_home)/skills/$skill_id"
mkdir -p "$skill_dir"
cp "$skill_md_path" "$skill_dir/SKILL.md"

# Step 3: hermes webhook subscribe.

# Auto-derive default deliver target when --deliver is omitted.
# Scans ~/.hermes/.env for the first non-empty <PLATFORM>_HOME_CHANNEL —
# that env var is set when the user pairs a chat platform via hermes setup,
# so it's a reliable signal that "this platform is paired and this is the
# user's preferred chat for inbound notifications."
if [ -z "$deliver" ]; then
  env_file="$(hermes_home)/.env"
  if [ -f "$env_file" ]; then
    for plat in feishu telegram discord slack signal whatsapp wecom dingtalk; do
      var=$(printf '%s_HOME_CHANNEL' "$plat" | tr '[:lower:]' '[:upper:]')
      # `|| home=""` swallows the case where grep finds nothing — pipefail
      # would otherwise let grep's exit-1 escalate to set-e and abort the script.
      home=$(grep -E "^${var}=" "$env_file" 2>/dev/null | head -1 \
        | sed -E "s/^${var}=//; s/^['\"]//; s/['\"]$//") || home=""
      if [ -n "$home" ]; then
        deliver=$plat
        [ -z "$deliver_chat_id" ] && deliver_chat_id=$home
        break
      fi
    done
  fi
  deliver=${deliver:-log}
fi

sub_name="world2agent-$sensor_id"
hermes_args=(webhook subscribe "$sub_name"
  --description "World2Agent: $skill_id"
  --prompt "{prompt}"
  --secret "$hmac"
  --deliver "$deliver")
if [ "$deliver_only" = true ]; then
  hermes_args+=(--deliver-only)
else
  hermes_args+=(--skills "$skill_id")
fi
[ -n "$deliver_chat_id" ] && hermes_args+=(--deliver-chat-id "$deliver_chat_id")

command -v hermes >/dev/null 2>&1 || out_err "hermes CLI not on PATH"
sub_log=$(mktemp)
if ! hermes "${hermes_args[@]}" >"$sub_log" 2>&1; then
  cat "$sub_log" >&2; rm -f "$sub_log"
  out_err "hermes webhook subscribe $sub_name failed"
fi
sub_stdout=$(cat "$sub_log"); rm -f "$sub_log"

parsed=$(parse_subscribe_output "$sub_stdout")
url=$(jq -r '.url // empty' <<<"$parsed")
[ -n "$url" ] || out_err "hermes webhook subscribe returned without URL; raw output: $sub_stdout"

# Step 4: upsert config.json.
cfg_path=$(config_json_path)
mkdir -p "$(dirname "$cfg_path")"
[ -f "$cfg_path" ] || printf '{"sensors":[]}\n' >"$cfg_path"

new_entry=$(jq -nc \
  --arg pkg "$pkg" \
  --argjson cfg "$config_json" \
  --arg skill_dir "$skill_dir" \
  --arg sensor_id "$sensor_id" \
  --arg skill_id "$skill_id" \
  --arg sub "$sub_name" \
  --arg url "$url" \
  '{
    package:$pkg,
    config:$cfg,
    skills:[$skill_dir],
    _hermes:{sensor_id:$sensor_id,skill_id:$skill_id,subscription_name:$sub,webhook_url:$url},
    enabled:true
  }')

tmp=$(mktemp)
if ! jq --argjson new "$new_entry" \
        '.sensors = ((.sensors // []) | map(select(.package != $new.package)) + [$new])' \
        "$cfg_path" >"$tmp"; then
  rm -f "$tmp"; out_err "could not upsert $cfg_path"
fi
mv "$tmp" "$cfg_path"

# Step 5: nudge supervisor (file watcher would also pick it up).
reload_result=$(control_request POST /_w2a/reload 2>/dev/null || true)
if [ -z "$reload_result" ] || ! jq -e . <<<"$reload_result" >/dev/null 2>&1; then
  reload_result='null'
fi

out_ok "$(jq -nc \
  --arg pkg "$pkg" \
  --arg sensor_id "$sensor_id" \
  --arg skill_id "$skill_id" \
  --arg sub "$sub_name" \
  --arg url "$url" \
  --arg skill_path "$skill_dir/SKILL.md" \
  --argjson reload "$reload_result" \
  '{package:$pkg,sensor_id:$sensor_id,skill_id:$skill_id,subscription_name:$sub,
    webhook_url:$url,skill_path:$skill_path,supervisor_reload:$reload}')"
