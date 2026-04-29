#!/usr/bin/env bash
# list-sensors.sh — config sensors + supervisor runtime view.
#
# Args:    none
# Stdout:  {"ok":true,
#           "sensors":[/* full entries from config.json */],
#           "runtime":{ok:true,sensors:[...],handles:[...]}|null,
#           "runtime_error":null|"..."}
# Exit:    0 always (config-only result is still useful when supervisor is down)
#          1 only if config.json is unreadable

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

cfg_path=$(config_json_path)
if [ -f "$cfg_path" ]; then
  sensors=$(jq -c '.sensors // []' "$cfg_path") \
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
