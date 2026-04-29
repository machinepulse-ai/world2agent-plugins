#!/usr/bin/env bash
# start.sh — start the supervisor.
#
# Resolution order:
#   1. macOS + plist exists  → launchctl kickstart
#   2. Linux + unit exists   → systemctl --user start
#   3. fallback              → nohup detach; supervisor self-bootstraps state
#
# Args:    none
# Stdout:  {"ok":true,"mode":"launchd|systemd|nohup","log":"...path..."}
# Exit:    0 ok / 1 binary missing or service start failed

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

LABEL="dev.world2agent.hermes-supervisor"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVICE="world2agent-hermes-supervisor.service"
UNIT="$HOME/.config/systemd/user/$SERVICE"

case "$(uname -s)" in
  Darwin)
    if [ -f "$PLIST" ]; then
      launchctl kickstart "gui/$(id -u)/$LABEL" >/dev/null 2>&1 \
        || out_err "launchctl kickstart $LABEL failed"
      out_ok "$(jq -nc --arg log "$(supervisor_log_path)" '{mode:"launchd",log:$log}')"
    fi
    ;;
  Linux)
    if [ -f "$UNIT" ]; then
      systemctl --user start "$SERVICE" >/dev/null 2>&1 \
        || out_err "systemctl --user start $SERVICE failed"
      out_ok "$(jq -nc --arg log "$(supervisor_log_path)" '{mode:"systemd",log:$log}')"
    fi
    ;;
esac

binary=$(command -v world2agent-hermes-supervisor || true)
[ -n "$binary" ] || out_err "world2agent-hermes-supervisor not on PATH; install bridge first"

mkdir -p "$(w2a_home)"
log=$(supervisor_log_path)
nohup "$binary" --foreground >>"$log" 2>&1 </dev/null &
disown 2>/dev/null || true
sleep 0.4

out_ok "$(jq -nc --arg log "$log" '{mode:"nohup",log:$log}')"
