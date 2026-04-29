#!/usr/bin/env bash
# remove-sensor.sh — remove this bridge's claim on a sensor.
#
# Args:
#   <package>      full npm package name
#   [--purge]      additionally rm ~/.openclaw/skills/<skill_id>/ + npm uninstall
#                  the package (only when no other runtime still references it)
#
# Behavior: only the `_openclaw_bridge` block is dropped. If the entry
# carries other `_<runtime>` blocks (e.g. `_hermes`, `_openclaw`) the entry
# survives so those runtimes keep working. If no namespaced block remains
# AND the entry has no other consumer, the entry is dropped entirely.
#
# Stdout:
#   {"ok":true,"package":"...","removed":true,"sensor_id":"...","skill_id":"...",
#    "entry_remaining":bool,"supervisor_reload":{...},
#    "purged":{"skill":bool,"npm":bool,"npm_error":null|"..."}}
#   or:
#   {"ok":true,"package":"...","removed":false,"reason":"<...>"}
# Exit:    0 ok / 1 hard failure

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

bridge_block=$(jq -c '._openclaw_bridge // null' <<<"$entry")
if [ "$bridge_block" = "null" ]; then
  out_ok "$(jq -nc --arg pkg "$pkg" '{package:$pkg,removed:false,reason:"entry exists but has no _openclaw_bridge block"}')"
fi

skill_id=$(jq -r '._openclaw_bridge.skill_id // ""' <<<"$entry")
sensor_id=$(jq -r '._openclaw_bridge.sensor_id // ""' <<<"$entry")
[ -n "$skill_id" ]  || skill_id=$(package_to_skill_id "$pkg")
[ -n "$sensor_id" ] || sensor_id=$(package_to_default_sensor_id "$pkg")

# 1. drop our block, atomic. If the entry has no other `_<runtime>` blocks
# remaining, drop the whole entry.
tmp=$(mktemp)
jq --arg pkg "$pkg" '
  .sensors |= ((. // []) | map(
    if .package == $pkg then
      ( del(._openclaw_bridge) ) as $stripped
      | if ($stripped | to_entries | map(select(.key | startswith("_"))) | length) > 0
        then $stripped
        else null
        end
    else .
    end
  ) | map(select(. != null)))
' "$cfg_path" >"$tmp" || { rm -f "$tmp"; out_err "could not rewrite $cfg_path"; }
mv "$tmp" "$cfg_path"

# 2. determine whether the entry survived.
entry_remaining=$(jq -c --arg pkg "$pkg" '(.sensors // []) | map(select(.package == $pkg)) | length > 0' "$cfg_path")

# 3. reload supervisor.
reload_result=$(control_request POST /_w2a/reload 2>/dev/null || true)
if [ -z "$reload_result" ] || ! jq -e . <<<"$reload_result" >/dev/null 2>&1; then
  reload_result='null'
fi

# 4. optional purge — only if no other runtime still references the package.
purged_skill=false
purged_npm=false
purge_npm_error=""
if [ "$purge" = true ]; then
  skill_dir="$(openclaw_home)/skills/$skill_id"
  if [ -d "$skill_dir" ]; then
    rm -rf "$skill_dir" && purged_skill=true
  fi
  if [ "$entry_remaining" = "false" ] && command -v npm >/dev/null 2>&1; then
    if npm uninstall --prefix "$(w2a_npm_root)" "$pkg" >/dev/null 2>&1; then
      purged_npm=true
    else
      purge_npm_error="npm uninstall failed (non-fatal)"
    fi
  elif [ "$entry_remaining" = "true" ]; then
    purge_npm_error="package still used by another runtime; left npm install in place"
  fi
fi

out_ok "$(jq -nc \
  --arg pkg "$pkg" \
  --arg sid "$sensor_id" \
  --arg kid "$skill_id" \
  --argjson rem "$entry_remaining" \
  --argjson reload "$reload_result" \
  --argjson p_skill "$purged_skill" \
  --argjson p_npm "$purged_npm" \
  --arg p_err "$purge_npm_error" \
  '{
    package:$pkg,
    removed:true,
    sensor_id:$sid,
    skill_id:$kid,
    entry_remaining:$rem,
    supervisor_reload:$reload,
    purged:{
      skill:$p_skill,
      npm:$p_npm,
      npm_error: (if $p_err == "" then null else $p_err end)
    }
  }')"
