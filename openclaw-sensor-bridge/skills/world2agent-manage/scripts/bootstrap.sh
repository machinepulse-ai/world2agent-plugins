#!/usr/bin/env bash
# bootstrap.sh — one-shot host setup. Idempotent; safe to re-run.
#
# Steps (each is a no-op when already done):
#   1. supervisor + runner binaries on PATH
#   2. bridge-state file populated under the W2A home dir
#   3. OpenClaw hooks subsystem ready (hooks.enabled, .token, .allowRequestSessionKey)
#   4. supervisor process running (delegates to start.sh)
#
# Args:    none
# Stdout:  {"ok":true,"steps":{binary,state,openclaw_hooks,supervisor},
#           "openclaw_home":"...","control_port":8646,"session_key_prefix":"w2a:"}
# Exit:    0 ok / 1 hard failure (binary missing, hooks misconfigured, etc.)

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

steps='{}'
add_step() {
  steps=$(jq -c --arg k "$1" --arg v "$2" '. + {($k):$v}' <<<"$steps")
}

# Step 1: binary on PATH.
if ! command -v world2agent-openclaw-supervisor >/dev/null 2>&1 \
   || ! command -v world2agent-sensor-runner >/dev/null 2>&1; then
  out_err "world2agent-openclaw-supervisor / world2agent-sensor-runner not on PATH; install the bridge runtime first (see package README)"
fi
add_step binary "present"

# Step 2: bridge state.
state_path=$(bridge_state_path)
state_existed=true
[ -f "$state_path" ] || state_existed=false
ensure_bridge_state || out_err "could not write $state_path"
add_step state "$([ "$state_existed" = true ] && echo "present" || echo "created")"

# Step 3: verify OpenClaw hooks are ready. Read-only — we don't silently
# modify the gateway config; the user opted into hooks themselves.
hooks_err=$(openclaw_hooks_ready 2>&1) && hooks_err=""
if [ -n "$hooks_err" ]; then
  out_err "OpenClaw hooks not ready: $hooks_err. Edit $(openclaw_config_path) to set hooks.enabled=true, hooks.token=\"<secret>\", hooks.allowRequestSessionKey=true, and at least one entry in hooks.allowedSessionKeyPrefixes (e.g. \"w2a:\"). Then restart the gateway."
fi
prefix=$(default_session_key_prefix)
add_step openclaw_hooks "ready"

# Step 4: supervisor process.
if supervisor_alive; then
  add_step supervisor "already-running"
else
  if bash "$(dirname "${BASH_SOURCE[0]}")/start.sh" >/dev/null 2>&1; then
    sleep 0.5
    if supervisor_alive; then
      add_step supervisor "started"
    else
      add_step supervisor "started-but-not-yet-healthy"
    fi
  else
    add_step supervisor "start-failed"
  fi
fi

control_port=$(jq -r '.control_port' "$state_path")

out_ok "$(jq -nc \
  --argjson s "$steps" \
  --arg oh "$(openclaw_home)" \
  --argjson port "$control_port" \
  --arg prefix "$prefix" \
  '{steps:$s,openclaw_home:$oh,control_port:$port,session_key_prefix:$prefix}')"
