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

PLIST=$(launchd_plist_path)
UNIT=$(systemd_unit_path)

case "$(uname -s)" in
  Darwin)
    if [ -f "$PLIST" ]; then
      launchctl kickstart "$(launchd_target)" >/dev/null 2>&1 \
        || out_err "launchctl kickstart $LAUNCHD_LABEL failed"
      out_ok "$(jq -nc --arg log "$(supervisor_log_path)" '{mode:"launchd",log:$log}')"
    fi
    ;;
  Linux)
    if [ -f "$UNIT" ]; then
      systemctl --user start "$SYSTEMD_SERVICE" >/dev/null 2>&1 \
        || out_err "systemctl --user start $SYSTEMD_SERVICE failed"
      out_ok "$(jq -nc --arg log "$(supervisor_log_path)" '{mode:"systemd",log:$log}')"
    fi
    ;;
esac

binary=$(command -v world2agent-openclaw-supervisor || true)
[ -n "$binary" ] || out_err "world2agent-openclaw-supervisor not on PATH; install the bridge runtime first"

mkdir -p "$(w2a_home)"
log=$(supervisor_log_path)
nohup "$binary" --foreground >>"$log" 2>&1 </dev/null &
disown 2>/dev/null || true
sleep 0.4

out_ok "$(jq -nc --arg log "$log" '{mode:"nohup",log:$log}')"
