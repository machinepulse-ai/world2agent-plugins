#!/usr/bin/env bash
# uninstall-bootstrap.sh — reverse bootstrap.sh.
#
# Steps:
#   1. launchctl bootout / systemctl --user disable --now (whichever exists)
#   2. delete the user-agent / unit file
#
# Does NOT touch ~/.openclaw/openclaw.json (we never wrote there). Does NOT
# delete the W2A home dir (sensor configs / state stay; that's
# remove-sensor.sh's job).
#
# Args:    none
# Stdout:  {"ok":true,"service":{"kind":"launchd|systemd|none","path":"...|null"}}
# Exit:    0 (idempotent)

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

PLIST=$(launchd_plist_path)
UNIT=$(systemd_unit_path)

service_kind="none"
service_path='null'

case "$(uname -s)" in
  Darwin)
    if [ -f "$PLIST" ]; then
      launchctl bootout "$(launchd_target)" >/dev/null 2>&1 || true
      rm -f "$PLIST"
      service_kind="launchd"
      service_path=$(jq -nc --arg p "$PLIST" '$p')
    fi
    ;;
  Linux)
    if [ -f "$UNIT" ]; then
      systemctl --user disable --now "$SYSTEMD_SERVICE" >/dev/null 2>&1 || true
      rm -f "$UNIT"
      systemctl --user daemon-reload >/dev/null 2>&1 || true
      service_kind="systemd"
      service_path=$(jq -nc --arg p "$UNIT" '$p')
    fi
    ;;
esac

out_ok "$(jq -nc \
  --arg kind "$service_kind" \
  --argjson path "$service_path" \
  '{service:{kind:$kind,path:$path}}')"
