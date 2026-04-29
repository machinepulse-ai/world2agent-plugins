#!/usr/bin/env bash
# install-launchd.sh — macOS persistent autostart for the supervisor.
#
# Idempotent. Run AFTER bootstrap.sh and after the bridge npm package is
# installed globally (so `world2agent-hermes-supervisor` is on PATH).
#
# Args:    none
# Stdout:  {"ok":true,"plist":"...","label":"dev.world2agent.hermes-supervisor"}
# Exit:    0 ok / 1 not on macOS, binary missing, launchctl bootstrap failed

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

[ "$(uname -s)" = "Darwin" ] || out_err "install-launchd.sh only runs on macOS"

binary=$(command -v world2agent-hermes-supervisor || true)
[ -n "$binary" ] || out_err "world2agent-hermes-supervisor not on PATH; install bridge first"

LABEL="dev.world2agent.hermes-supervisor"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG=$(supervisor_log_path)

mkdir -p "$(dirname "$PLIST")" "$(w2a_home)"

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$binary</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
EOF

# Idempotent: bootout existing copy first.
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 \
  || out_err "launchctl bootstrap $PLIST failed"
launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true

out_ok "$(jq -nc --arg plist "$PLIST" --arg label "$LABEL" '{plist:$plist,label:$label}')"
