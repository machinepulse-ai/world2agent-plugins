# Shared helpers for openclaw-sensor-bridge's world2agent-manage skill.
#
# Source from each script:  . "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
#
# Every script emits exactly one JSON object on stdout (success or error)
# and uses stderr for human diagnostics. Helpers below enforce that.
#
# Hard deps:
#   - bash 4+
#   - jq      (JSON read/write, atomic upserts, output shaping)
#   - curl    (talk to supervisor's loopback control HTTP)
#   - npm     (install/uninstall sensor packages — install-sensor / read-setup only)
#   - openclaw  CLI is NOT required here; we read ~/.openclaw/openclaw.json directly

w2a_home() {
  printf '%s' "${WORLD2AGENT_HOME:-$HOME/.world2agent}"
}

openclaw_home() {
  printf '%s' "${OPENCLAW_HOME:-$HOME/.openclaw}"
}

w2a_npm_root() {
  printf '%s/_npm' "$(w2a_home)"
}

bridge_state_path() {
  printf '%s/.openclaw-bridge-state.json' "$(w2a_home)"
}

config_json_path() {
  printf '%s/config.json' "$(w2a_home)"
}

supervisor_log_path() {
  printf '%s/openclaw-supervisor.log' "$(w2a_home)"
}

openclaw_config_path() {
  printf '%s/%s' "$(openclaw_home)" "${OPENCLAW_CONFIG_FILE:-openclaw.json}"
}

# ---- launchd / systemd identifiers -----------------------------------------

LAUNCHD_LABEL='dev.world2agent.openclaw-supervisor'
SYSTEMD_SERVICE='world2agent-openclaw-supervisor.service'

launchd_plist_path() {
  printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$LAUNCHD_LABEL"
}

launchd_target() {
  printf 'gui/%s/%s' "$(id -u)" "$LAUNCHD_LABEL"
}

systemd_unit_path() {
  printf '%s/.config/systemd/user/%s' "$HOME" "$SYSTEMD_SERVICE"
}

# ---- JSON output ------------------------------------------------------------

out_ok() {
  if [ $# -eq 0 ] || [ -z "${1:-}" ]; then
    printf '{"ok":true}\n'
  else
    jq -nc --argjson extra "$1" '{ok:true} + $extra'
  fi
  exit 0
}

out_err() {
  jq -nc --arg msg "${1:-unknown error}" '{ok:false,error:$msg}'
  exit 1
}

# ---- npm package name validation -------------------------------------------

validate_package_name() {
  local pkg=${1:?package name required}
  if [[ ! "$pkg" =~ ^(@[a-z0-9][a-z0-9_-]*/)?[a-z0-9][a-z0-9._-]*$ ]]; then
    out_err "invalid npm package name: $pkg"
  fi
  case "$pkg" in
    *..*|*://*|git+*|file:*) out_err "package name $pkg looks like a URL or path; refusing" ;;
  esac
}

# Mirror the SDK's packageToSkillId: strip leading @, replace / with -.
# @world2agent/sensor-hackernews → world2agent-sensor-hackernews
package_to_skill_id() {
  local pkg=${1:?package required}
  pkg=${pkg#@}
  printf '%s' "${pkg//\//-}"
}

# Default sensor_id mirrors openclaw-plugin's defaultSensorId: strip the
# `@scope/sensor-` prefix → the suffix only.
# @world2agent/sensor-hackernews → hackernews
package_to_default_sensor_id() {
  local pkg=${1:?package required}
  local suffix=${pkg##*/}
  printf '%s' "${suffix#sensor-}"
}

# ---- bridge-state.json access ----------------------------------------------
# Return values via stdout — MUST NOT call out_err / out_ok (those exit).

read_bridge_state_field() {
  local field=${1:?field required}
  local path
  path=$(bridge_state_path)
  if [ ! -f "$path" ]; then
    printf '%s missing; run scripts/bootstrap.sh first\n' "$path" >&2
    return 1
  fi
  jq -er ".$field" "$path" 2>/dev/null
}

# ---- supervisor control HTTP -----------------------------------------------

control_request() {
  local method=${1:?method required}
  local path=${2:?path required}
  local body=${3:-}
  local token port
  token=$(read_bridge_state_field control_token) || return 1
  port=$(read_bridge_state_field control_port) || return 1
  local args=(-sS -m 5 -X "$method" -H "X-W2A-Token: $token")
  if [ -n "$body" ]; then
    args+=(-H 'content-type: application/json' --data "$body")
  fi
  curl "${args[@]}" "http://127.0.0.1:$port$path"
}

# Probe /_w2a/health. Returns 0 if alive, 1 otherwise.
supervisor_alive() {
  control_request GET /_w2a/health 2>/dev/null \
    | jq -e '.ok == true' >/dev/null 2>&1
}

# ---- random helpers --------------------------------------------------------

random_hex() {
  local bytes=${1:-16}
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    head -c "$bytes" /dev/urandom | od -An -tx1 -v | tr -d ' \n'
  fi
}

# ---- bridge-state bootstrap ------------------------------------------------
# Idempotent. Creates ~/.world2agent/.openclaw-bridge-state.json if missing
# and fills in any missing fields. No hmac_secret here (OpenClaw uses Bearer
# tokens read from ~/.openclaw/openclaw.json, not bridge-issued HMAC).

ensure_bridge_state() {
  local path
  path=$(bridge_state_path)
  mkdir -p "$(dirname "$path")" || return 1

  local existing='{}'
  if [ -f "$path" ]; then
    existing=$(jq -c '.' "$path" 2>/dev/null) || existing='{}'
  fi

  local ctok port
  ctok=$(jq -r '.control_token // ""' <<<"$existing")
  port=$(jq -r '.control_port // 0' <<<"$existing")
  [ -z "$ctok" ] && ctok=$(random_hex 32)
  [ "$port" = "0" ] && port=8646

  local merged
  merged=$(jq -nc \
    --arg ctok "$ctok" \
    --argjson port "$port" \
    --argjson existing "$existing" \
    '$existing + {version: 1, control_token: $ctok, control_port: $port}')
  printf '%s\n' "$merged" >"$path"
  chmod 600 "$path" 2>/dev/null || true
}

# ---- OpenClaw gateway config probe -----------------------------------------
# Read-only — never mutates ~/.openclaw/openclaw.json. The bridge's design
# is to fail with a clear message rather than silently flip security flags
# in the user's gateway config.

# Args: <field-path> (jq dot-path, e.g. "hooks.enabled")
# Stdout: raw value or empty string. Return: 0.
read_openclaw_field() {
  local field=${1:?field required}
  local path
  path=$(openclaw_config_path)
  [ -f "$path" ] || { printf '' ; return 0 ; }
  jq -er ".$field // empty" "$path" 2>/dev/null || printf ''
}

# Returns 0 if hooks.enabled is true, hooks.token is non-empty, AND
# hooks.allowRequestSessionKey is true (so we can specify per-sensor lanes).
# Stderr: human-readable reason on failure. Return: 0 ok, 1 not ready.
openclaw_hooks_ready() {
  local cfg
  cfg=$(openclaw_config_path)
  if [ ! -f "$cfg" ]; then
    printf '%s does not exist; install OpenClaw first\n' "$cfg" >&2
    return 1
  fi
  local enabled token allow
  enabled=$(jq -r '.hooks.enabled // false' "$cfg" 2>/dev/null)
  token=$(jq -r '.hooks.token // ""' "$cfg" 2>/dev/null)
  allow=$(jq -r '.hooks.allowRequestSessionKey // false' "$cfg" 2>/dev/null)
  if [ "$enabled" != "true" ]; then
    printf 'hooks.enabled is not true in %s\n' "$cfg" >&2
    return 1
  fi
  if [ -z "$token" ]; then
    printf 'hooks.token is empty in %s\n' "$cfg" >&2
    return 1
  fi
  if [ "$allow" != "true" ]; then
    printf 'hooks.allowRequestSessionKey is not true in %s — required for per-sensor session lanes\n' "$cfg" >&2
    return 1
  fi
  return 0
}

# Picks the first viable sessionKey prefix from
# hooks.allowedSessionKeyPrefixes, preferring `w2a:` then `hook:`.
# Falls back to `w2a:` if the array is missing.
# Stdout: prefix string. Return: 0.
default_session_key_prefix() {
  local cfg
  cfg=$(openclaw_config_path)
  local prefixes='[]'
  if [ -f "$cfg" ]; then
    prefixes=$(jq -c '.hooks.allowedSessionKeyPrefixes // []' "$cfg" 2>/dev/null) || prefixes='[]'
  fi
  jq -r --argjson p "$prefixes" '
    if ($p | type) != "array" or ($p | length) == 0 then "w2a:"
    elif ($p | contains(["w2a:"]))  then "w2a:"
    elif ($p | contains(["hook:"])) then "hook:"
    else $p[0]
    end
  ' <<<'{}'
}

# ---- handler-skill frontmatter validation ---------------------------------
# install-sensor.sh refuses to drop a SKILL.md whose frontmatter `name`
# doesn't match the expected skill_id. Without this, a typo in the rendered
# handler silently breaks signal routing (the agent loads a different skill
# or none at all).

assert_skill_frontmatter() {
  local path=${1:?skill_md path required}
  local expected=${2:?expected name required}
  [ -f "$path" ] || { echo "skill_md not found at $path" >&2; return 1; }
  python3 - "$path" "$expected" <<'PY'
import re, sys
path, expected = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as fh:
    text = fh.read()
text_l = text.lstrip()
if not text_l.startswith("---"):
    print("skill_md missing YAML frontmatter (must start with '---')", file=sys.stderr)
    sys.exit(1)
body = text_l[3:]
m = re.search(r'(?m)^---\s*$', body)
if not m:
    print("skill_md frontmatter is not closed with '---'", file=sys.stderr)
    sys.exit(1)
fm = body[:m.start()]
got = None
for line in fm.splitlines():
    nm = re.match(r'^\s*name\s*:\s*(?P<v>.+?)\s*$', line)
    if not nm:
        continue
    v = nm.group("v")
    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
        v = v[1:-1]
    got = v
    break
if got != expected:
    print(f"skill_md frontmatter `name` must equal {expected!r}; got {got!r}", file=sys.stderr)
    sys.exit(1)
PY
}
