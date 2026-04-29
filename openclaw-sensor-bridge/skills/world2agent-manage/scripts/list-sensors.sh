#!/usr/bin/env bash
# list-sensors.sh — bridge-owned sensors + supervisor runtime view.
#
# Only entries carrying an `_openclaw_bridge` block are reported (so a shared
# ~/.world2agent/config.json with hermes / openclaw-plugin entries doesn't
# leak unrelated sensors into our list).
#
# Args:    none
# Stdout:  {"ok":true,
#           "sensors":[/* entries with _openclaw_bridge from config.json */],
#           "runtime":{ok,sensors,handles}|null,
#           "runtime_error":null|"..."}
# Exit:    0 always (config-only result is still useful when supervisor is down)
#          1 only if config.json is unreadable

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

cfg_path=$(config_json_path)
if [ -f "$cfg_path" ]; then
  sensors=$(jq -c '(.sensors // []) | map(select(._openclaw_bridge != null))' "$cfg_path") \
    || out_err "$cfg_path is not valid JSON"
else
  sensors='[]'
fi

runtime='null'
runtime_error='null'
if [ -f "$(bridge_state_path)" ]; then
  if r=$(control_request GET /_w2a/list 2>/dev/null); then
    if jq -e . <<<"$r" >/dev/null 2>&1; then
      runtime=$r
    else
      runtime_error=$(jq -nc --arg t "non-JSON response from /_w2a/list" '$t')
    fi
  else
    runtime_error='"could not reach supervisor /_w2a/list"'
  fi
else
  runtime_error='"bridge state missing; run scripts/bootstrap.sh"'
fi

out_ok "$(jq -nc \
  --argjson sensors "$sensors" \
  --argjson runtime "$runtime" \
  --argjson runtime_error "$runtime_error" \
  '{sensors:$sensors,runtime:$runtime,runtime_error:$runtime_error}')"
