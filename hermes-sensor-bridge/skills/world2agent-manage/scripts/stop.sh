#!/usr/bin/env bash
# stop.sh — stop the supervisor. Idempotent.
#
# Args:    none
# Stdout:  {"ok":true,"mode":"launchd|systemd|signal|none","killed_pid":N|null}
# Exit:    0 always (already-stopped is fine)

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

PLIST=$(launchd_plist_path)
UNIT=$(systemd_unit_path)

case "$(uname -s)" in
  Darwin)
    if [ -f "$PLIST" ]; then
      launchctl bootout "$(launchd_target)" >/dev/null 2>&1 || true
      out_ok "$(jq -nc '{mode:"launchd",killed_pid:null}')"
    fi
    ;;
  Linux)
    if [ -f "$UNIT" ]; then
      systemctl --user stop "$SYSTEMD_SERVICE" >/dev/null 2>&1 || true
      out_ok "$(jq -nc '{mode:"systemd",killed_pid:null}')"
    fi
    ;;
esac

state_path=$(bridge_state_path)
if [ ! -f "$state_path" ]; then
  out_ok "$(jq -nc '{mode:"none",killed_pid:null}')"
fi

pid=$(jq -r '.supervisor_pid // empty' "$state_path" 2>/dev/null || echo "")
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  kill "$pid" 2>/dev/null || true
  out_ok "$(jq -nc --argjson pid "$pid" '{mode:"signal",killed_pid:$pid}')"
fi

out_ok "$(jq -nc '{mode:"none",killed_pid:null}')"
