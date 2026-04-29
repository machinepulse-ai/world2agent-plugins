#!/usr/bin/env bash
# bootstrap.sh — one-shot host setup. Idempotent; safe to re-run.
#
# Steps (each is a no-op when already done):
#   1. supervisor + runner binaries on PATH
#   2. ~/.world2agent/.bridge-state.json populated
#   3. managed `platforms.webhook` block in ~/.hermes/config.yaml
#   4. managed mirror in ~/.hermes/.env
#   5. supervisor process running (delegates to start.sh)
#
# Args:    none
# Stdout:  {"ok":true,"steps":{binary,state,config_yaml,env,supervisor},
#           "hermes_home":"...","webhook_port":8644}
# Exit:    0 ok / 1 hard failure (binary missing, refused merge, etc.)

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

steps='{}'
add_step() {
  steps=$(jq -c --arg k "$1" --arg v "$2" '. + {($k):$v}' <<<"$steps")
}

# Step 1: binary on PATH.
if ! command -v world2agent-hermes-supervisor >/dev/null 2>&1 \
   || ! command -v world2agent-sensor-runner >/dev/null 2>&1; then
  out_err "world2agent-hermes-supervisor / world2agent-sensor-runner not on PATH; install bridge first (npm install -g @world2agent/hermes-sensor-bridge)"
fi
add_step binary "present"

# Step 2: bridge state.
state_path=$(bridge_state_path)
state_existed=true
[ -f "$state_path" ] || state_existed=false
ensure_bridge_state || out_err "could not write $state_path"
add_step state "$([ "$state_existed" = true ] && echo "present" || echo "created")"

secret=$(jq -r '.hmac_secret' "$state_path")
port=8644

# Step 3: ~/.hermes/config.yaml managed block.
yaml_file="$(hermes_home)/config.yaml"
if has_managed_block "$yaml_file"; then
  yaml_status="managed-block-exists"
elif detect_webhook_enabled_in_yaml "$yaml_file"; then
  yaml_status="hand-written-already-enabled"
elif has_unmanaged_top_level_platforms "$yaml_file"; then
  out_err "$yaml_file has a hand-written 'platforms:' block. Refusing to merge. Add 'webhook: { enabled: true, extra: { host: 127.0.0.1, port: $port, secret: ... } }' under it yourself, or run 'hermes gateway setup'."
else
  write_managed_yaml_block "$yaml_file" "$port" "$secret"
  yaml_status="wrote-managed-block"
fi
add_step config_yaml "$yaml_status"

# Step 4: ~/.hermes/.env managed block.
env_file="$(hermes_home)/.env"
if has_managed_block "$env_file"; then
  env_status="managed-block-exists"
else
  write_managed_env_block "$env_file" "$port" "$secret"
  env_status="wrote-managed-block"
fi
add_step env "$env_status"

# Step 5: supervisor process.
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

out_ok "$(jq -nc \
  --argjson s "$steps" \
  --arg hh "$(hermes_home)" \
  --argjson port "$port" \
  '{steps:$s,hermes_home:$hh,webhook_port:$port}')"
