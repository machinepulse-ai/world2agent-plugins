#!/usr/bin/env bash
# uninstall-bootstrap.sh — reverse bootstrap.sh.
#
# Steps:
#   1. launchctl bootout / systemctl --user disable --now (whichever exists)
#   2. delete the plist or unit file
#   3. remove the managed block from ~/.hermes/config.yaml and ~/.hermes/.env
#
# Does NOT delete ~/.world2agent/ (sensor configs / state stay; that's
# remove-sensor.sh's job).
#
# Args:    none
# Stdout:  {"ok":true,"service":{"kind":"launchd|systemd|none","path":"...|null"},
#           "config_yaml_modified":bool,"env_modified":bool}
# Exit:    0 (idempotent)

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

LABEL="dev.world2agent.hermes-supervisor"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVICE="world2agent-hermes-supervisor.service"
UNIT="$HOME/.config/systemd/user/$SERVICE"

service_kind="none"
service_path='null'

case "$(uname -s)" in
  Darwin)
    if [ -f "$PLIST" ]; then
      launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
      rm -f "$PLIST"
      service_kind="launchd"
      service_path=$(jq -nc --arg p "$PLIST" '$p')
    fi
    ;;
  Linux)
    if [ -f "$UNIT" ]; then
      systemctl --user disable --now "$SERVICE" >/dev/null 2>&1 || true
      rm -f "$UNIT"
      systemctl --user daemon-reload >/dev/null 2>&1 || true
      service_kind="systemd"
      service_path=$(jq -nc --arg p "$UNIT" '$p')
    fi
    ;;
esac

yaml_modified=false
remove_managed_block "$(hermes_home)/config.yaml" && yaml_modified=true || true

env_modified=false
remove_managed_block "$(hermes_home)/.env" && env_modified=true || true

out_ok "$(jq -nc \
  --arg kind "$service_kind" \
  --argjson path "$service_path" \
  --argjson yml "$yaml_modified" \
  --argjson env "$env_modified" \
  '{service:{kind:$kind,path:$path},config_yaml_modified:$yml,env_modified:$env}')"
