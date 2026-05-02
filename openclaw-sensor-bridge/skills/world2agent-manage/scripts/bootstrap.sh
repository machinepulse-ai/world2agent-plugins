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

# Step 1: binary on PATH. If missing, auto-install the bridge package globally
# via npm. The agent will surface npm's stderr (sudo prompt, EACCES, etc.) so
# the user can re-run with elevated rights if needed.
binary_status="present"
if ! command -v world2agent-openclaw-supervisor >/dev/null 2>&1 \
   || ! command -v world2agent-openclaw-runner >/dev/null 2>&1; then
  command -v npm >/dev/null 2>&1 \
    || out_err "world2agent-openclaw-supervisor not on PATH and 'npm' is unavailable; install Node.js + npm first, or install the bridge runtime manually"
  printf '[bootstrap] installing @world2agent/openclaw-sensor-bridge globally...\n' >&2
  install_log=$(mktemp)
  if ! npm install -g @world2agent/openclaw-sensor-bridge >"$install_log" 2>&1; then
    cat "$install_log" >&2
    rm -f "$install_log"
    out_err "auto-install of @world2agent/openclaw-sensor-bridge failed; you may need 'sudo npm install -g @world2agent/openclaw-sensor-bridge'"
  fi
  rm -f "$install_log"
  hash -r 2>/dev/null || true
  if ! command -v world2agent-openclaw-supervisor >/dev/null 2>&1 \
     || ! command -v world2agent-openclaw-runner >/dev/null 2>&1; then
    out_err "bridge binaries still not on PATH after install; check that npm's global bin dir is on PATH (npm bin -g)"
  fi
  binary_status="installed"
fi
add_step binary "$binary_status"

# Step 2: bridge state.
state_path=$(bridge_state_path)
state_existed=true
[ -f "$state_path" ] || state_existed=false
ensure_bridge_state || out_err "could not write $state_path"
add_step state "$([ "$state_existed" = true ] && echo "present" || echo "created")"

# Step 3: ensure OpenClaw hooks are ready. We mutate the gateway config when
# needed (idempotent; existing tokens are preserved). If we did mutate, the
# user must restart `openclaw gateway` for the new block to take effect —
# we surface that via gateway_restart_needed in the output.
hooks_action=$(ensure_openclaw_hooks 2>/tmp/.w2a-hooks-err) || {
  err=$(cat /tmp/.w2a-hooks-err 2>/dev/null); rm -f /tmp/.w2a-hooks-err
  out_err "could not configure OpenClaw hooks: ${err:-unknown error}. Edit $(openclaw_config_path) manually to set hooks.enabled=true, hooks.token=\"<secret>\", hooks.allowRequestSessionKey=true, hooks.allowedSessionKeyPrefixes=[\"hook:\",\"w2a:\"]; then restart the gateway."
}
rm -f /tmp/.w2a-hooks-err
gateway_restart_needed=false
hooks_backup=""
case "$hooks_action" in
  noop)
    add_step openclaw_hooks "ready"
    ;;
  wrote:*)
    hooks_backup=${hooks_action#wrote:}
    add_step openclaw_hooks "wrote-managed-fields"
    gateway_restart_needed=true
    ;;
  *)
    out_err "unexpected ensure_openclaw_hooks output: $hooks_action"
    ;;
esac
prefix=$(default_session_key_prefix)

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
  --argjson restart "$gateway_restart_needed" \
  --arg backup "$hooks_backup" \
  '{steps:$s,openclaw_home:$oh,control_port:$port,session_key_prefix:$prefix,
    gateway_restart_needed:$restart,
    openclaw_config_backup: (if $backup == "" then null else $backup end)}')"
