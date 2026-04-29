#!/usr/bin/env bash
# remove-sensor.sh — full remove transaction.
#
# Args:
#   <package>      full npm package name
#   [--purge]      additionally rm ~/.hermes/skills/<skill_id>/ + npm uninstall
#
# Stdout:
#   {"ok":true,"package":"...","removed":true,"subscription_name":"...",
#    "subscription_removed":bool,"supervisor_reload":{...},
#    "purged":{"skill":bool,"npm":bool,"npm_error":null|"..."}}
#   or if not in config.json:
#   {"ok":true,"package":"...","removed":false,"reason":"not in config.json"}
# Exit:    0 ok / 1 hermes CLI hard failure (other than "not found")

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

pkg=""
purge=false
while [ $# -gt 0 ]; do
  case $1 in
    --purge) purge=true; shift;;
    --)      shift; break;;
    -*)      out_err "unknown flag: $1";;
    *)
      [ -z "$pkg" ] || out_err "extra positional arg: $1"
      pkg=$1; shift;;
  esac
done
[ -n "$pkg" ] || out_err "usage: remove-sensor.sh <package> [--purge]"
validate_package_name "$pkg"

cfg_path=$(config_json_path)
if [ ! -f "$cfg_path" ]; then
  out_ok "$(jq -nc --arg pkg "$pkg" '{package:$pkg,removed:false,reason:"config.json missing"}')"
fi

entry=$(jq -c --arg pkg "$pkg" '(.sensors // []) | map(select(.package == $pkg)) | .[0] // null' "$cfg_path")
if [ "$entry" = "null" ]; then
  out_ok "$(jq -nc --arg pkg "$pkg" '{package:$pkg,removed:false,reason:"not in config.json"}')"
fi

skill_id=$(jq -r '._hermes.skill_id // ""' <<<"$entry")
sensor_id=$(jq -r '._hermes.sensor_id // ""' <<<"$entry")
[ -n "$skill_id" ]  || skill_id=$(package_to_skill_id "$pkg")
[ -n "$sensor_id" ] || sensor_id=$(package_to_skill_id "$pkg")
sub_name=$(jq -r --arg fb "world2agent-$sensor_id" '._hermes.subscription_name // $fb' <<<"$entry")

# 1. hermes webhook remove (idempotent — "not found" is success).
subscription_removed=true
if command -v hermes >/dev/null 2>&1; then
  rm_log=$(mktemp)
  if ! hermes webhook remove "$sub_name" >"$rm_log" 2>&1; then
    if grep -qiE 'not found|no such' "$rm_log"; then
      :  # already gone
    else
      cat "$rm_log" >&2; rm -f "$rm_log"
      out_err "hermes webhook remove $sub_name failed"
    fi
  fi
  rm -f "$rm_log"
else
  subscription_removed=false
fi

# 2. drop entry, atomic.
tmp=$(mktemp)
jq --arg pkg "$pkg" '.sensors |= ((. // []) | map(select(.package != $pkg)))' "$cfg_path" >"$tmp" \
  || { rm -f "$tmp"; out_err "could not rewrite $cfg_path"; }
mv "$tmp" "$cfg_path"

# 3. reload supervisor.
reload_result=$(control_request POST /_w2a/reload 2>/dev/null || true)
if [ -z "$reload_result" ] || ! jq -e . <<<"$reload_result" >/dev/null 2>&1; then
  reload_result='null'
fi

# 4. optional purge.
purged_skill=false
purged_npm=false
purge_npm_error=""
if [ "$purge" = true ]; then
  skill_dir="$(hermes_home)/skills/$skill_id"
  if [ -d "$skill_dir" ]; then
    rm -rf "$skill_dir" && purged_skill=true
  fi
  if command -v npm >/dev/null 2>&1; then
    if npm uninstall --prefix "$(w2a_npm_root)" "$pkg" >/dev/null 2>&1; then
      purged_npm=true
    else
      purge_npm_error="npm uninstall failed (non-fatal)"
    fi
  fi
fi

out_ok "$(jq -nc \
  --arg pkg "$pkg" \
  --arg sub "$sub_name" \
  --argjson sub_removed "$subscription_removed" \
  --argjson reload "$reload_result" \
  --argjson p_skill "$purged_skill" \
  --argjson p_npm "$purged_npm" \
  --arg p_err "$purge_npm_error" \
  '{
    package:$pkg,
    removed:true,
    subscription_name:$sub,
    subscription_removed:$sub_removed,
    supervisor_reload:$reload,
    purged:{
      skill:$p_skill,
      npm:$p_npm,
      npm_error: (if $p_err == "" then null else $p_err end)
    }
  }')"
