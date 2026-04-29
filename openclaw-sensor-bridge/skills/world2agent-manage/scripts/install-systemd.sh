#!/usr/bin/env bash
# install-systemd.sh — Linux persistent autostart (user service) for the supervisor.
#
# Idempotent. Run AFTER bootstrap.sh and after the bridge npm package is
# installed globally (so `world2agent-openclaw-supervisor` is on PATH).
#
# Args:    none
# Stdout:  {"ok":true,"unit":"...","service":"world2agent-openclaw-supervisor.service"}
# Exit:    0 ok / 1 not on Linux, binary missing, systemctl --user failure

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

[ "$(uname -s)" = "Linux" ] || out_err "install-systemd.sh only runs on Linux"

binary=$(command -v world2agent-openclaw-supervisor || true)
[ -n "$binary" ] || out_err "world2agent-openclaw-supervisor not on PATH; install the bridge runtime first"

UNIT=$(systemd_unit_path)
LOG=$(supervisor_log_path)

mkdir -p "$(dirname "$UNIT")" "$(w2a_home)"

cat >"$UNIT" <<EOF
[Unit]
Description=World2Agent OpenClaw Bridge Supervisor
After=default.target

[Service]
Type=simple
ExecStart=$binary --foreground
Restart=on-failure
RestartSec=2
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload >/dev/null 2>&1 || true
systemctl --user enable --now "$SYSTEMD_SERVICE" >/dev/null 2>&1 \
  || out_err "systemctl --user enable --now $SYSTEMD_SERVICE failed"

out_ok "$(jq -nc --arg unit "$UNIT" --arg svc "$SYSTEMD_SERVICE" '{unit:$unit,service:$svc}')"
