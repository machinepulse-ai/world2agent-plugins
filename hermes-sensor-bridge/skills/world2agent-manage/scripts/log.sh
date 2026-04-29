#!/usr/bin/env bash
# log.sh — tail ~/.world2agent/supervisor.log.
#
# Args:
#   [-f|--follow]                follow new lines
#   [-n|--tail <N>]              tail line count (default 200)
#   [<sensor_id>]                only show lines tagged [w2a/<sensor_id>]
#
# Stdout:  raw log lines (NOT JSON — agent forwards to user as-is)
# Exit:    0 ok / 1 log file missing or unknown flag

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

follow=false
tail_n=200
sensor_filter=""

while [ $# -gt 0 ]; do
  case $1 in
    -f|--follow) follow=true; shift;;
    -n|--tail)   tail_n=$2; shift 2;;
    --)          shift; break;;
    -*)          out_err "unknown flag: $1";;
    *)
      [ -z "$sensor_filter" ] || out_err "extra positional arg: $1"
      sensor_filter=$1; shift;;
  esac
done

[[ "$tail_n" =~ ^[0-9]+$ ]] || out_err "--tail must be a positive integer"

log=$(supervisor_log_path)
[ -f "$log" ] || out_err "no log file at $log"

if [ "$follow" = true ]; then
  if [ -n "$sensor_filter" ]; then
    exec tail -n "$tail_n" -F "$log" 2>/dev/null | grep --line-buffered -F "[w2a/$sensor_filter]"
  else
    exec tail -n "$tail_n" -F "$log" 2>/dev/null
  fi
else
  if [ -n "$sensor_filter" ]; then
    tail -n "$tail_n" "$log" 2>/dev/null | grep -F "[w2a/$sensor_filter]" || true
  else
    tail -n "$tail_n" "$log" 2>/dev/null || true
  fi
fi
