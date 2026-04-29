#!/usr/bin/env bash
# status.sh — diagnostics. Read-only; never mutates anything; always exits 0.
#
# Args:    none
# Stdout:  {"ok":true,
#           "bridge_state_present":bool,
#           "openclaw_hooks":{enabled,token_set,allow_request_session_key,
#                             allowed_session_key_prefixes},
#           "openclaw_gateway_reachable":bool,
#           "health":{...}|null,
#           "handles":{...}|null,
#           "control_error":null|"..."}

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

state_present=false
[ -f "$(bridge_state_path)" ] && state_present=true

# OpenClaw hooks block view (read-only).
ocfg=$(openclaw_config_path)
hooks_view='null'
if [ -f "$ocfg" ]; then
  hooks_view=$(jq -c '
    {
      enabled: (.hooks.enabled // false),
      token_set: ((.hooks.token // "") != ""),
      allow_request_session_key: (.hooks.allowRequestSessionKey // false),
      allowed_session_key_prefixes: (.hooks.allowedSessionKeyPrefixes // [])
    }' "$ocfg" 2>/dev/null) || hooks_view='null'
fi

# Probe gateway port (best-effort; default 18789, override via OPENCLAW_GATEWAY_URL).
gateway_url=${OPENCLAW_GATEWAY_URL:-}
if [ -z "$gateway_url" ] && [ -f "$ocfg" ]; then
  port=$(jq -r '.gateway.port // 18789' "$ocfg" 2>/dev/null)
  gateway_url="http://127.0.0.1:$port"
fi
gateway_url=${gateway_url%/}
gateway_reachable=false
if [ -n "$gateway_url" ] && \
   curl -sS -o /dev/null -m 2 "$gateway_url/" >/dev/null 2>&1; then
  gateway_reachable=true
fi

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

out_ok "$(jq -nc \
  --argjson present "$state_present" \
  --argjson hooks "$hooks_view" \
  --argjson reach "$gateway_reachable" \
  --argjson health "$health" \
  --argjson handles "$handles" \
  --argjson cerr "$control_error" \
  --arg gw "$gateway_url" \
  '{
    bridge_state_present:$present,
    openclaw_hooks:$hooks,
    openclaw_gateway_url:$gw,
    openclaw_gateway_reachable:$reach,
    health:$health,
    handles:$handles,
    control_error:$cerr
  }')"
