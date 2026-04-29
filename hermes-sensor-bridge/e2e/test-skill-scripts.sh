#!/usr/bin/env bash
# e2e/test-skill-scripts.sh — exercise every world2agent-manage shell script
# inside an isolated sandbox so we never touch the real $HOME state, the real
# `hermes` CLI, or the real npm registry.
#
# Run from any directory:  bash e2e/test-skill-scripts.sh
# Exit:  0 if all checks pass, 1 if any fails.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scripts_dir="$repo_root/skills/world2agent-manage/scripts"

# ---- sandbox setup ---------------------------------------------------------

sandbox=$(mktemp -d -t w2a-skill-test-XXXXXX)
trap 'cleanup' EXIT
cleanup() {
  # Best-effort: kill anything we spawned, then nuke sandbox.
  if [ -f "$sandbox/state/supervisor.pid" ]; then
    kill "$(cat "$sandbox/state/supervisor.pid")" 2>/dev/null || true
  fi
  rm -rf "$sandbox"
}

export HOME="$sandbox/home"
export HERMES_HOME="$sandbox/hermes"
export WORLD2AGENT_HOME="$sandbox/world2agent"
mkdir -p "$HOME" "$HERMES_HOME" "$WORLD2AGENT_HOME"

mock_bin="$sandbox/bin"
mkdir -p "$mock_bin"

# Mock hermes CLI: configurable via env vars per call site.
cat >"$mock_bin/hermes" <<'EOF'
#!/usr/bin/env bash
# minimal stub — only routes the calls our scripts actually make
# Behavior controllable via:
#   W2A_TEST_HERMES_FAIL=1                  → exit 1 with stderr message
#   W2A_TEST_HERMES_SUB_NOT_FOUND=1         → "remove" prints "not found" and exits 1
case "$1 $2" in
  "webhook subscribe")
    if [ "${W2A_TEST_HERMES_FAIL:-0}" = "1" ]; then
      echo "mock hermes: forced failure" >&2; exit 1
    fi
    # Locate the route name (third positional after `webhook subscribe`).
    name="$3"
    printf '{"name":"%s","url":"http://127.0.0.1:8644/webhooks/%s"}\n' "$name" "$name"
    ;;
  "webhook remove")
    if [ "${W2A_TEST_HERMES_SUB_NOT_FOUND:-0}" = "1" ]; then
      echo "subscription not found" >&2; exit 1
    fi
    echo "removed: $3"
    ;;
  "webhook list")
    # supports `webhook list --json`
    echo '[]'
    ;;
  *)
    echo "mock hermes: unhandled call: $*" >&2; exit 99
    ;;
esac
EOF
chmod +x "$mock_bin/hermes"

# Mock npm — installs a fake package with package.json and SETUP.md.
cat >"$mock_bin/npm" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  install)
    shift
    prefix=""; pkg=""
    while [ $# -gt 0 ]; do
      case $1 in
        --prefix) prefix=$2; shift 2;;
        --no-audit|--no-fund|--silent) shift;;
        -*) shift;;
        *) [ -z "$pkg" ] && pkg=$1; shift;;
      esac
    done
    [ -n "$prefix" ] || { echo "mock npm: no --prefix" >&2; exit 1; }
    [ -n "$pkg" ]    || { echo "mock npm: no package" >&2; exit 1; }
    if [ "${W2A_TEST_NPM_FAIL:-0}" = "1" ]; then
      echo "mock npm: forced failure" >&2; exit 1
    fi
    target="$prefix/node_modules/$pkg"
    mkdir -p "$target"
    printf '{"name":"%s","version":"0.0.0-test"}\n' "$pkg" >"$target/package.json"
    cat >"$target/SETUP.md" <<MD
# Mock SETUP.md for $pkg

- field_a: ?
- field_b: ?
MD
    ;;
  uninstall)
    shift
    prefix=""; pkg=""
    while [ $# -gt 0 ]; do
      case $1 in
        --prefix) prefix=$2; shift 2;;
        -*) shift;;
        *) [ -z "$pkg" ] && pkg=$1; shift;;
      esac
    done
    rm -rf "$prefix/node_modules/$pkg" 2>/dev/null || true
    ;;
  *) echo "mock npm: unhandled $*" >&2; exit 99;;
esac
EOF
chmod +x "$mock_bin/npm"

# Mock supervisor binary — never actually runs (start.sh execs it via nohup,
# and we don't want a real subprocess in tests). Just an executable shim.
cat >"$mock_bin/world2agent-hermes-supervisor" <<'EOF'
#!/usr/bin/env bash
# Fake supervisor: idle for 5 seconds so `command -v` works and start.sh's
# nohup spawn doesn't immediately exit. We don't bind any port; the control
# HTTP probes will fail, which is what tests expect.
sleep 5
EOF
chmod +x "$mock_bin/world2agent-hermes-supervisor"

cat >"$mock_bin/world2agent-sensor-runner" <<'EOF'
#!/usr/bin/env bash
exec sleep 5
EOF
chmod +x "$mock_bin/world2agent-sensor-runner"

# Prepend our mock dir.
export PATH="$mock_bin:$PATH"

# ---- check helpers ---------------------------------------------------------

failures=0
check() {
  local label=$1 cond=$2 detail=${3:-}
  if [ "$cond" = "true" ]; then
    printf 'PASS  %s\n' "$label"
  else
    printf 'FAIL  %s\n' "$label"
    [ -n "$detail" ] && printf '      %s\n' "$detail"
    failures=$((failures + 1))
  fi
}

# Run a script and capture stdout / status into a caller-named variable.
# Args: <script> <stdout-var> <args...>
# Local names are prefixed with `_` so they don't shadow the caller's `<stdout-var>`.
run() {
  local _script=$1 _outvar=$2; shift 2
  local _out _status
  _out=$(bash "$scripts_dir/$_script" "$@" 2>/dev/null) || true
  _status=$?
  printf -v "$_outvar" '%s' "$_out"
  return "$_status"
}

# JSON field reader.
jget() {
  local json=$1 path=$2
  jq -r "$path" <<<"$json" 2>/dev/null || echo ""
}

# After bootstrap, redirect the supervisor control HTTP to an unbound port so
# tests are isolated from any real `world2agent-hermes-supervisor` the user may
# have running on the default 8645 (e.g., from a prior `npm install -g`). Our
# tests assert "supervisor unreachable" behavior, so a real one returning
# `unauthorized` would silently fool the script.
patch_state_port() {
  local sp="$WORLD2AGENT_HOME/.bridge-state.json"
  [ -f "$sp" ] || return 0
  jq '.control_port = 18645' "$sp" >"$sp.tmp" && mv "$sp.tmp" "$sp"
}

# ---- _lib.sh unit tests ----------------------------------------------------

. "$scripts_dir/_lib.sh"

# package validation
( validate_package_name "@world2agent/sensor-hackernews" >/dev/null 2>&1 )
check "_lib: validate scoped package accepted"  "$([ $? -eq 0 ] && echo true || echo false)"

( validate_package_name "sensor-foo" >/dev/null 2>&1 )
check "_lib: validate unscoped package accepted" "$([ $? -eq 0 ] && echo true || echo false)"

( validate_package_name "Has-Caps" >/dev/null 2>&1 )
check "_lib: validate rejects uppercase" "$([ $? -ne 0 ] && echo true || echo false)"

( validate_package_name "../etc/passwd" >/dev/null 2>&1 )
check "_lib: validate rejects path-traversal" "$([ $? -ne 0 ] && echo true || echo false)"

( validate_package_name "git+https://example.com/foo" >/dev/null 2>&1 )
check "_lib: validate rejects git+ URL" "$([ $? -ne 0 ] && echo true || echo false)"

# packageToSkillId
got=$(package_to_skill_id "@world2agent/sensor-hackernews")
check "_lib: packageToSkillId scoped" "$([ "$got" = "world2agent-sensor-hackernews" ] && echo true || echo false)" "got=$got"

got=$(package_to_skill_id "plain-pkg")
check "_lib: packageToSkillId unscoped" "$([ "$got" = "plain-pkg" ] && echo true || echo false)" "got=$got"

# random_hex
hex=$(random_hex 16)
check "_lib: random_hex 32 chars" "$([ "${#hex}" = "32" ] && echo true || echo false)" "got=$hex (${#hex} chars)"

# ensure_bridge_state
rm -f "$WORLD2AGENT_HOME/.bridge-state.json"
ensure_bridge_state
check "_lib: ensure_bridge_state creates file" "$([ -f "$WORLD2AGENT_HOME/.bridge-state.json" ] && echo true || echo false)"
hmac1=$(jq -r .hmac_secret "$WORLD2AGENT_HOME/.bridge-state.json")
ensure_bridge_state
hmac2=$(jq -r .hmac_secret "$WORLD2AGENT_HOME/.bridge-state.json")
check "_lib: ensure_bridge_state preserves hmac" "$([ "$hmac1" = "$hmac2" ] && echo true || echo false)"

mode=$(stat -f '%Lp' "$WORLD2AGENT_HOME/.bridge-state.json" 2>/dev/null \
       || stat -c '%a' "$WORLD2AGENT_HOME/.bridge-state.json" 2>/dev/null)
check "_lib: bridge-state file mode 0600" "$([ "$mode" = "600" ] && echo true || echo false)" "mode=$mode"

# managed block helpers
yaml="$sandbox/cfg.yaml"
rm -f "$yaml"
check "_lib: has_managed_block on missing file false" "$(has_managed_block "$yaml" && echo false || echo true)"

write_managed_yaml_block "$yaml" 8644 "secret-abc"
check "_lib: write_managed_yaml_block adds block" "$(has_managed_block "$yaml" && echo true || echo false)"
check "_lib: managed yaml has port" "$(grep -q 'port: 8644' "$yaml" && echo true || echo false)"
check "_lib: managed yaml has secret" "$(grep -q 'secret: "secret-abc"' "$yaml" && echo true || echo false)"

# unmanaged platforms detection
echo 'platforms:' >"$sandbox/handwritten.yaml"
echo '  webhook:' >>"$sandbox/handwritten.yaml"
check "_lib: detects unmanaged platforms" "$(has_unmanaged_top_level_platforms "$sandbox/handwritten.yaml" && echo true || echo false)"

# Managed block alone should not trigger unmanaged detection
check "_lib: managed yaml NOT flagged as unmanaged" "$(has_unmanaged_top_level_platforms "$yaml" && echo false || echo true)"

# remove_managed_block
remove_managed_block "$yaml"
check "_lib: remove_managed_block strips it" "$(has_managed_block "$yaml" && echo false || echo true)"

# parse_subscribe_output
js='{"name":"sub-x","url":"http://127.0.0.1:8644/webhooks/abc"}'
parsed=$(parse_subscribe_output "$js")
check "_lib: parse JSON subscribe output url" "$([ "$(jget "$parsed" .url)" = "http://127.0.0.1:8644/webhooks/abc" ] && echo true || echo false)" "parsed=$parsed"

text=$(printf 'Created subscription\nname: my-sub\nURL: http://localhost/x\n')
parsed=$(parse_subscribe_output "$text")
check "_lib: parse line-format url" "$([ "$(jget "$parsed" .url)" = "http://localhost/x" ] && echo true || echo false)" "parsed=$parsed"

# assert_skill_frontmatter
fm_ok="$sandbox/skill_ok.md"
cat >"$fm_ok" <<'MD'
---
name: world2agent-sensor-test
description: x
---
body
MD
err=$(assert_skill_frontmatter "$fm_ok" "world2agent-sensor-test" 2>&1) && rc=0 || rc=$?
check "_lib: assert_skill_frontmatter accepts matching name" "$([ "$rc" = "0" ] && echo true || echo false)" "err=$err"

err=$(assert_skill_frontmatter "$fm_ok" "wrong-name" 2>&1) && rc=0 || rc=$?
check "_lib: assert_skill_frontmatter rejects mismatch" "$([ "$rc" != "0" ] && echo true || echo false)"

fm_bad="$sandbox/skill_bad.md"
echo "no frontmatter here" >"$fm_bad"
err=$(assert_skill_frontmatter "$fm_bad" "anything" 2>&1) && rc=0 || rc=$?
check "_lib: assert_skill_frontmatter rejects missing frontmatter" "$([ "$rc" != "0" ] && echo true || echo false)"

# ---- script-level tests ----------------------------------------------------

# Reset state for script tests.
rm -rf "$WORLD2AGENT_HOME" "$HERMES_HOME"
mkdir -p "$WORLD2AGENT_HOME" "$HERMES_HOME"

# bootstrap.sh: happy path
run bootstrap.sh out
check "bootstrap: ok" "$([ "$(jget "$out" .ok)" = "true" ] && echo true || echo false)" "out=$out"
check "bootstrap: state created" "$([ "$(jget "$out" '.steps.state')" = "created" ] && echo true || echo false)" "out=$out"
check "bootstrap: yaml managed-block" "$([ "$(jget "$out" '.steps.config_yaml')" = "wrote-managed-block" ] && echo true || echo false)" "out=$out"
check "bootstrap: env managed-block" "$([ "$(jget "$out" '.steps.env')" = "wrote-managed-block" ] && echo true || echo false)"
check "bootstrap: bridge-state file exists" "$([ -f "$WORLD2AGENT_HOME/.bridge-state.json" ] && echo true || echo false)"
check "bootstrap: yaml has webhook block" "$(grep -q 'webhook:' "$HERMES_HOME/config.yaml" && echo true || echo false)"
check "bootstrap: env has WEBHOOK_PORT" "$(grep -q 'WEBHOOK_PORT=8644' "$HERMES_HOME/.env" && echo true || echo false)"

# Isolate from any real supervisor on port 8645.
patch_state_port

# bootstrap.sh: re-run is idempotent
run bootstrap.sh out
check "bootstrap: 2nd run state present" "$([ "$(jget "$out" '.steps.state')" = "present" ] && echo true || echo false)" "out=$out"
check "bootstrap: 2nd run yaml managed-block-exists" "$([ "$(jget "$out" '.steps.config_yaml')" = "managed-block-exists" ] && echo true || echo false)"
patch_state_port

# bootstrap.sh: refuses on hand-written platforms
rm -rf "$HERMES_HOME"; mkdir -p "$HERMES_HOME"
rm -rf "$WORLD2AGENT_HOME"; mkdir -p "$WORLD2AGENT_HOME"
cat >"$HERMES_HOME/config.yaml" <<'YML'
platforms:
  someother: {}
YML
run bootstrap.sh out
check "bootstrap: refuses hand-written platforms" "$([ "$(jget "$out" .ok)" = "false" ] && echo true || echo false)" "out=$out"

# bootstrap.sh: missing supervisor binary
# Use a minimal PATH (system bins only) so we bypass both the mock dir AND any
# real install in $HOME/.nvm/.../bin or /usr/local/bin. command -v should fail.
rm -rf "$HERMES_HOME"; mkdir -p "$HERMES_HOME"
rm -rf "$WORLD2AGENT_HOME"; mkdir -p "$WORLD2AGENT_HOME"
out=$(PATH=/usr/bin:/bin bash "$scripts_dir/bootstrap.sh" 2>/dev/null) || true
check "bootstrap: detects missing binary" "$([ "$(jget "$out" .ok)" = "false" ] && echo true || echo false)" "out=$out"

# read-setup.sh: happy
rm -rf "$WORLD2AGENT_HOME/_npm"
run read-setup.sh out "@w2a/test-sensor"
check "read-setup: ok" "$([ "$(jget "$out" .ok)" = "true" ] && echo true || echo false)" "out=$out"
check "read-setup: setup_md_present true" "$([ "$(jget "$out" .setup_md_present)" = "true" ] && echo true || echo false)"
check "read-setup: skill_id derived" "$([ "$(jget "$out" .skill_id)" = "w2a-test-sensor" ] && echo true || echo false)" "out=$out"

# read-setup.sh: invalid name
run read-setup.sh out "Bad Name"
check "read-setup: rejects invalid name" "$([ "$(jget "$out" .ok)" = "false" ] && echo true || echo false)" "out=$out"

# install-sensor.sh: missing args
run install-sensor.sh out
check "install-sensor: missing args fails" "$([ "$(jget "$out" .ok)" = "false" ] && echo true || echo false)"

# install-sensor.sh: requires bootstrap.sh first
run install-sensor.sh out "@w2a/test-sensor" --config '{"a":1}' --skill-md /nonexistent
check "install-sensor: missing skill_md fails" "$([ "$(jget "$out" .ok)" = "false" ] && echo true || echo false)"

# Re-do bootstrap so install-sensor can proceed.
run bootstrap.sh out
[ "$(jget "$out" .ok)" = "true" ] || { echo "FATAL: bootstrap failed before install-sensor test: $out"; exit 1; }
patch_state_port

# Build a valid handler skill for the sensor.
sensor_pkg="@w2a/test-sensor"
sensor_skill_id="w2a-test-sensor"
skill_md_file="$sandbox/handler.md"
cat >"$skill_md_file" <<EOM
---
name: $sensor_skill_id
description: handles test-sensor signals
---

# Handler
EOM

run install-sensor.sh out "$sensor_pkg" --config '{"key":"val"}' --skill-md "$skill_md_file"
check "install-sensor: ok" "$([ "$(jget "$out" .ok)" = "true" ] && echo true || echo false)" "out=$out"
check "install-sensor: emits webhook_url" "$([ -n "$(jget "$out" .webhook_url)" ] && echo true || echo false)"
check "install-sensor: skill_path under HERMES_HOME" "$(echo "$(jget "$out" .skill_path)" | grep -q "^$HERMES_HOME/skills" && echo true || echo false)"
check "install-sensor: handler skill written" "$([ -f "$HERMES_HOME/skills/$sensor_skill_id/SKILL.md" ] && echo true || echo false)"
check "install-sensor: config.json contains entry" "$(jq -e --arg pkg "$sensor_pkg" '.sensors | map(select(.package==$pkg)) | length == 1' "$WORLD2AGENT_HOME/config.json" >/dev/null 2>&1 && echo true || echo false)"

# install-sensor.sh: idempotent (re-run upserts, single entry)
run install-sensor.sh out "$sensor_pkg" --config '{"key":"val2"}' --skill-md "$skill_md_file"
check "install-sensor: idempotent ok" "$([ "$(jget "$out" .ok)" = "true" ] && echo true || echo false)"
count=$(jq --arg pkg "$sensor_pkg" '.sensors | map(select(.package==$pkg)) | length' "$WORLD2AGENT_HOME/config.json")
check "install-sensor: still one entry" "$([ "$count" = "1" ] && echo true || echo false)" "count=$count"
new_val=$(jq --arg pkg "$sensor_pkg" '.sensors | map(select(.package==$pkg))[0].config.key' "$WORLD2AGENT_HOME/config.json")
check "install-sensor: updates config in-place" "$([ "$new_val" = '"val2"' ] && echo true || echo false)" "new_val=$new_val"

# install-sensor.sh: rejects mismatched skill frontmatter
bad_skill="$sandbox/bad_handler.md"
cat >"$bad_skill" <<'MD'
---
name: wrong-skill-id
---
body
MD
run install-sensor.sh out "$sensor_pkg" --config '{}' --skill-md "$bad_skill"
check "install-sensor: rejects mismatched frontmatter" "$([ "$(jget "$out" .ok)" = "false" ] && echo true || echo false)" "out=$out"

# install-sensor.sh: deliver-only branch
run install-sensor.sh out "@w2a/test-deliver-only" --config '{}' --skill-md "$skill_md_file" --deliver telegram --deliver-chat-id 12345 --deliver-only
# Note: skill_md_file's name says w2a-test-sensor; deliver-only test uses different package. Need correct skill_md.
# The frontmatter check expects packageToSkillId(@w2a/test-deliver-only) = w2a-test-deliver-only.
# Above will fail frontmatter — that's a test bug, not script bug. Make a correct one:
cat >"$sandbox/handler-do.md" <<'EOM'
---
name: w2a-test-deliver-only
description: deliver-only handler
---
EOM
run install-sensor.sh out "@w2a/test-deliver-only" --config '{}' --skill-md "$sandbox/handler-do.md" --deliver telegram --deliver-chat-id 12345 --deliver-only
check "install-sensor: deliver-only ok" "$([ "$(jget "$out" .ok)" = "true" ] && echo true || echo false)" "out=$out"

# list-sensors.sh
run list-sensors.sh out
check "list-sensors: ok" "$([ "$(jget "$out" .ok)" = "true" ] && echo true || echo false)" "out=$out"
n=$(jget "$out" '.sensors | length')
check "list-sensors: 2 sensors" "$([ "$n" = "2" ] && echo true || echo false)" "n=$n"
check "list-sensors: runtime_error when supervisor down" "$([ "$(jget "$out" .runtime_error)" != "null" ] && echo true || echo false)" "runtime_error=$(jget "$out" .runtime_error)"

# remove-sensor.sh
run remove-sensor.sh out "$sensor_pkg"
check "remove-sensor: ok" "$([ "$(jget "$out" .ok)" = "true" ] && echo true || echo false)" "out=$out"
check "remove-sensor: removed=true" "$([ "$(jget "$out" .removed)" = "true" ] && echo true || echo false)"
n=$(jq '.sensors | length' "$WORLD2AGENT_HOME/config.json")
check "remove-sensor: config drops to 1 entry" "$([ "$n" = "1" ] && echo true || echo false)" "n=$n"

# remove-sensor.sh: not-installed package
run remove-sensor.sh out "@w2a/never-installed"
check "remove-sensor: not-installed ok" "$([ "$(jget "$out" .ok)" = "true" ] && echo true || echo false)" "out=$out"
check "remove-sensor: removed=false reason" "$([ "$(jget "$out" .removed)" = "false" ] && echo true || echo false)"

# remove-sensor.sh: tolerates "not found" from hermes
run install-sensor.sh out "@w2a/another" --config '{}' --skill-md "$sandbox/handler-another.md.notexist" 2>/dev/null || true
# (just exercising; skipping if the helper doesn't exist)

# status.sh: always 0
run status.sh out
check "status: ok" "$([ "$(jget "$out" .ok)" = "true" ] && echo true || echo false)" "out=$out"
check "status: bridge_state_present" "$([ "$(jget "$out" .bridge_state_present)" = "true" ] && echo true || echo false)"
check "status: control_error non-null (no real supervisor)" "$([ "$(jget "$out" .control_error)" != "null" ] && echo true || echo false)" "control_error=$(jget "$out" .control_error)"

# log.sh: missing log
rm -f "$WORLD2AGENT_HOME/supervisor.log"
out=$(bash "$scripts_dir/log.sh" 2>/dev/null) || rc=$? || rc=0
check "log: missing log fails" "$([ "$(jget "$out" .ok)" = "false" ] && echo true || echo false)" "out=$out"

# log.sh: with content
echo '[w2a/foo] hello' >"$WORLD2AGENT_HOME/supervisor.log"
echo '[w2a/bar] other' >>"$WORLD2AGENT_HOME/supervisor.log"
out=$(bash "$scripts_dir/log.sh" 2>/dev/null)
check "log: prints both lines no filter" "$([ "$(echo "$out" | wc -l | tr -d ' ')" = "2" ] && echo true || echo false)"

out=$(bash "$scripts_dir/log.sh" foo 2>/dev/null)
check "log: filter shows only matching" "$([ "$(echo "$out" | grep -c 'foo')" = "1" ] && [ "$(echo "$out" | grep -c 'bar')" = "0" ] && echo true || echo false)" "out=$out"

# install-launchd.sh: macOS-only check
case "$(uname -s)" in
  Darwin)
    : "(skipping real plist install in tests — would touch ~/Library/LaunchAgents/)"
    ;;
  Linux)
    run install-launchd.sh out
    check "install-launchd: refuses on Linux" "$([ "$(jget "$out" .ok)" = "false" ] && echo true || echo false)"
    ;;
esac

# install-systemd.sh: linux-only check
case "$(uname -s)" in
  Linux)
    : "(skipping real unit install in tests — would touch user systemd state)"
    ;;
  Darwin)
    run install-systemd.sh out
    check "install-systemd: refuses on macOS" "$([ "$(jget "$out" .ok)" = "false" ] && echo true || echo false)"
    ;;
esac

# uninstall-bootstrap.sh: should remove managed blocks
run uninstall-bootstrap.sh out
check "uninstall-bootstrap: ok" "$([ "$(jget "$out" .ok)" = "true" ] && echo true || echo false)" "out=$out"
check "uninstall-bootstrap: yaml block removed" "$(has_managed_block "$HERMES_HOME/config.yaml" && echo false || echo true)"
check "uninstall-bootstrap: env block removed" "$(has_managed_block "$HERMES_HOME/.env" && echo false || echo true)"

# ---- summary ---------------------------------------------------------------

echo
if [ "$failures" -eq 0 ]; then
  echo "all checks passed"
  exit 0
else
  echo "$failures check(s) failed"
  exit 1
fi
