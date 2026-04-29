#!/usr/bin/env bash
# status.sh — diagnostics. Read-only; never mutates anything; always exits 0.
#
# Args:    none
# Stdout:  {"ok":true,
#           "bridge_state_present":bool,
#           "health":{...}|null,
#           "handles":{...}|null,
#           "control_error":null|"...",
#           "hermes_subscriptions":[...]}

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

state_present=false
[ -f "$(bridge_state_path)" ] && state_present=true

health='null'
handles='null'
control_error='null'

if [ "$state_present" = true ]; then
  if h=$(control_request GET /_w2a/health 2>/dev/null); then
    if jq -e . <<<"$h" >/dev/null 2>&1; then
      health=$h
    else
      control_error=$(jq -nc --arg t "non-JSON /_w2a/health response" '$t')
    fi
  else
    control_error='"could not reach supervisor /_w2a/health"'
  fi
  if [ "$health" != null ]; then
    if l=$(control_request GET /_w2a/list 2>/dev/null); then
      jq -e . <<<"$l" >/dev/null 2>&1 && handles=$l
    fi
  fi
fi

# hermes webhook list — best effort; tries --json then falls back to []
subs='[]'
if command -v hermes >/dev/null 2>&1; then
  if s=$(hermes webhook list --json 2>/dev/null); then
    if jq -e 'type == "array"' <<<"$s" >/dev/null 2>&1; then
      subs=$s
    fi
  fi
fi

out_ok "$(jq -nc \
  --argjson present "$state_present" \
  --argjson health "$health" \
  --argjson handles "$handles" \
  --argjson cerr "$control_error" \
  --argjson subs "$subs" \
  '{
    bridge_state_present:$present,
    health:$health,
    handles:$handles,
    control_error:$cerr,
    hermes_subscriptions:$subs
  }')"
