#!/usr/bin/env bash
# read-setup.sh — fetch a sensor package and emit its SETUP.md.
#
# Args:    <package>  full package name
# Env in:  NPM_DEBUG=1 to leak the package-manager output to stderr
# Stdout:  {"ok":true,"package":"...","package_dir":"...","skill_id":"...",
#           "setup_md_present":bool,"setup_md":"..."}
# Exit:    0 ok / 1 invalid name, fetch failure, etc.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

[ $# -eq 1 ] || out_err "usage: read-setup.sh <package>"
pkg=$1
validate_package_name "$pkg"

skill_id=$(package_to_skill_id "$pkg")
npm_root=$(w2a_npm_root)
mkdir -p "$npm_root"

if [ "${NPM_DEBUG:-}" = "1" ]; then
  npm install --prefix "$npm_root" --no-audit --no-fund "$pkg" >&2 \
    || out_err "fetching $pkg failed (see stderr)"
else
  log=$(mktemp)
  if ! npm install --prefix "$npm_root" --no-audit --no-fund "$pkg" >"$log" 2>&1; then
    cat "$log" >&2
    rm -f "$log"
    out_err "fetching $pkg failed (set NPM_DEBUG=1 to see full output)"
  fi
  rm -f "$log"
fi

pkg_dir="$npm_root/node_modules/$pkg"
[ -d "$pkg_dir" ] || out_err "$pkg_dir does not exist after fetch — package name may be wrong"

setup_md=""
setup_md_present=false
if [ -f "$pkg_dir/SETUP.md" ]; then
  setup_md=$(cat "$pkg_dir/SETUP.md")
  setup_md_present=true
fi

out_ok "$(jq -nc \
  --arg pkg "$pkg" \
  --arg pkg_dir "$pkg_dir" \
  --arg skill_id "$skill_id" \
  --arg setup_md "$setup_md" \
  --argjson present "$setup_md_present" \
  '{package:$pkg,package_dir:$pkg_dir,skill_id:$skill_id,setup_md_present:$present,setup_md:$setup_md}')"
