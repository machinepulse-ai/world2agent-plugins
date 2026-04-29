# Shared helpers for world2agent-manage skill scripts.
#
# Source this from each script:  . "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
#
# Every script emits exactly one JSON object on stdout (success or error) and
# uses stderr for human-readable diagnostics. Helpers below enforce that.
#
# Hard deps:
#   - bash 4+
#   - jq      (JSON read/write, atomic upserts, output shaping)
#   - curl    (talk to the supervisor's 127.0.0.1 control HTTP)
#   - npm     (install/uninstall sensor packages — install-sensor / read-setup only)
#   - hermes  (subscribe / remove webhook routes — install-sensor / remove-sensor only)

w2a_home() {
  printf '%s' "${WORLD2AGENT_HOME:-$HOME/.world2agent}"
}

hermes_home() {
  printf '%s' "${HERMES_HOME:-$HOME/.hermes}"
}

w2a_npm_root() {
  printf '%s/_npm' "$(w2a_home)"
}

bridge_state_path() {
  printf '%s/.bridge-state.json' "$(w2a_home)"
}

config_json_path() {
  printf '%s/config.json' "$(w2a_home)"
}

supervisor_log_path() {
  printf '%s/supervisor.log' "$(w2a_home)"
}

# ---- JSON output ------------------------------------------------------------
# Stdout discipline: every script ends with exactly one of these.

# out_ok [extra-json-object]
#   With no arg → {"ok":true}
#   With arg    → {"ok":true} merged with the supplied JSON object string
out_ok() {
  if [ $# -eq 0 ] || [ -z "${1:-}" ]; then
    printf '{"ok":true}\n'
  else
    jq -nc --argjson extra "$1" '{ok:true} + $extra'
  fi
  exit 0
}

# out_err <message>
#   Always prints {"ok":false,"error":"<message>"} and exits non-zero.
out_err() {
  jq -nc --arg msg "${1:-unknown error}" '{ok:false,error:$msg}'
  exit 1
}

# ---- npm package name validation -------------------------------------------
# Same gate as the deleted Python plugin's PACKAGE_NAME_RE + extra rejects.

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

# ---- bridge-state.json access ----------------------------------------------
#
# These return values via stdout, so they MUST NOT call out_err / out_ok (those
# exit the subshell when wrapped in $(...), eating the JSON). Instead they log
# to stderr and `return 1`; callers chain `|| out_err "..."`.

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
# Args: method path [body-json]
# Prints raw response body on stdout. Caller decides how to parse / error-handle.
# Stderr carries diagnostics; non-zero return on any setup or transport error.

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

# Probe /_w2a/health. Stdout: nothing. Returns 0 if alive, 1 otherwise.
supervisor_alive() {
  control_request GET /_w2a/health 2>/dev/null \
    | jq -e '.ok == true' >/dev/null 2>&1
}

# ---- random helpers --------------------------------------------------------
# 32 hex chars (16 random bytes). Falls back to /dev/urandom + xxd if openssl
# is missing or limited.

random_hex() {
  local bytes=${1:-16}
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    head -c "$bytes" /dev/urandom | od -An -tx1 -v | tr -d ' \n'
  fi
}

# ---- bridge-state bootstrap ------------------------------------------------
# Idempotent: preserves hmac_secret/control_token if file exists with valid
# fields; fills in any missing fields with fresh values. Same algorithm as the
# supervisor's loadOrCreateBridgeState in src/supervisor/state.ts so either
# side can bootstrap and the other accepts the file.
#
# Stdout: nothing. Stderr: progress. Return: 0 ok, 1 on filesystem error.

ensure_bridge_state() {
  local path
  path=$(bridge_state_path)
  mkdir -p "$(dirname "$path")" || return 1

  local existing='{}'
  if [ -f "$path" ]; then
    existing=$(jq -c '.' "$path" 2>/dev/null) || existing='{}'
  fi

  local hmac ctok port
  hmac=$(jq -r '.hmac_secret // ""' <<<"$existing")
  ctok=$(jq -r '.control_token // ""' <<<"$existing")
  port=$(jq -r '.control_port // 0' <<<"$existing")
  [ -z "$hmac" ] && hmac=$(random_hex 16)
  [ -z "$ctok" ] && ctok=$(random_hex 32)
  [ "$port" = "0" ] && port=8645

  local merged
  merged=$(jq -nc \
    --arg hmac "$hmac" \
    --arg ctok "$ctok" \
    --argjson port "$port" \
    --argjson existing "$existing" \
    '$existing + {version: 1, hmac_secret: $hmac, control_token: $ctok, control_port: $port}')
  printf '%s\n' "$merged" >"$path"
  chmod 600 "$path" 2>/dev/null || true
}

# ---- managed-block constants + file mutators ------------------------------

MANAGED_BLOCK_BEGIN='# >>> world2agent-hermes-bridge (managed) >>>'
MANAGED_BLOCK_END='# <<< world2agent-hermes-bridge (managed) <<<'

has_managed_block() {
  local file=$1
  [ -f "$file" ] && grep -qF "$MANAGED_BLOCK_BEGIN" "$file"
}

# Returns 0 (true) if file has a top-level `platforms:` block that is NOT
# inside a managed marker. Used to refuse merging into hand-written config.
has_unmanaged_top_level_platforms() {
  local file=$1
  [ -f "$file" ] || return 1
  awk -v begin="$MANAGED_BLOCK_BEGIN" -v end="$MANAGED_BLOCK_END" '
    BEGIN { inside=0 }
    index($0, begin) { inside=1; next }
    index($0, end)   { inside=0; next }
    !inside && /^platforms:/ { found=1; exit }
    END { exit (found ? 0 : 1) }
  ' "$file"
}

# Append the managed block to ~/.hermes/config.yaml. Must be called only when
# has_managed_block is false and has_unmanaged_top_level_platforms is false.
write_managed_yaml_block() {
  local file=$1 port=$2 secret=$3
  mkdir -p "$(dirname "$file")"
  {
    [ -s "$file" ] && printf '\n'
    printf '%s\n' "$MANAGED_BLOCK_BEGIN"
    printf '%s\n' '# Enables Hermes webhook platform so world2agent can deliver signals.'
    printf '%s\n' 'platforms:'
    printf '%s\n' '  webhook:'
    printf '%s\n' '    enabled: true'
    printf '%s\n' '    extra:'
    printf '%s\n' '      host: "127.0.0.1"'
    printf '      port: %s\n' "$port"
    printf '      secret: "%s"\n' "$secret"
    printf '%s\n' "$MANAGED_BLOCK_END"
  } >>"$file"
}

write_managed_env_block() {
  local file=$1 port=$2 secret=$3
  mkdir -p "$(dirname "$file")"
  {
    [ -s "$file" ] && printf '\n'
    printf '%s\n' "$MANAGED_BLOCK_BEGIN"
    printf '%s\n' '# Mirrors webhook platform settings for the gateway runtime.'
    printf '%s\n' 'WEBHOOK_ENABLED=true'
    printf 'WEBHOOK_PORT=%s\n' "$port"
    printf 'WEBHOOK_SECRET=%s\n' "$secret"
    printf '%s\n' "$MANAGED_BLOCK_END"
  } >>"$file"
}

# Strip the managed block from a file. Returns 0 if file was modified, 1 if
# no block was present.
remove_managed_block() {
  local file=$1
  [ -f "$file" ] || return 1
  has_managed_block "$file" || return 1
  local tmp
  tmp=$(mktemp)
  awk -v begin="$MANAGED_BLOCK_BEGIN" -v end="$MANAGED_BLOCK_END" '
    BEGIN { inside=0 }
    index($0, begin) { inside=1; next }
    index($0, end)   { inside=0; next }
    !inside { print }
  ' "$file" >"$tmp"
  # squash multiple consecutive blank lines into one
  awk 'BEGIN{blank=0} /^$/{if(blank)next; blank=1; print; next} {blank=0; print}' "$tmp" >"$file"
  rm -f "$tmp"
}

# Detect whether webhook platform is enabled in config.yaml without owning the
# managed block. Used so bootstrap.sh can no-op when the user has hand-written
# config that already enables the platform. Returns 0 if enabled, 1 otherwise.
#
# Implementation: stdlib-only Python that walks lines, tracking the
# `platforms:` → `webhook:` → `enabled: true` indentation chain. Avoids a
# PyYAML dependency since this script ships with the bridge and we don't want
# to mandate pip installs on the host.
detect_webhook_enabled_in_yaml() {
  local file=$1
  [ -f "$file" ] || return 1
  python3 - "$file" <<'PY' 2>/dev/null
import re, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    lines = fh.read().splitlines()

state = "outside"
platforms_indent = -1
webhook_indent = -1

def indent_of(line):
    return len(line) - len(line.lstrip())

for raw in lines:
    if not raw.strip() or raw.lstrip().startswith("#"):
        continue
    ind = indent_of(raw)
    stripped = raw.strip()
    if state == "outside":
        if ind == 0 and stripped.startswith("platforms:"):
            state = "platforms"; platforms_indent = ind
        continue
    if state == "platforms":
        if ind <= platforms_indent:
            state = "outside"
            if ind == 0 and stripped.startswith("platforms:"):
                state = "platforms"; platforms_indent = ind
            continue
        if stripped.startswith("webhook:"):
            state = "webhook"; webhook_indent = ind
        continue
    if state == "webhook":
        if ind <= webhook_indent:
            state = "platforms"
            if stripped.startswith("webhook:"):
                state = "webhook"; webhook_indent = ind
            continue
        if re.match(r"enabled\s*:\s*true(\s|$)", stripped):
            sys.exit(0)
sys.exit(1)
PY
}

# ---- handler-skill frontmatter validation ---------------------------------
# Used by install-sensor.sh. Refuses to write the SKILL.md if the frontmatter
# `name` field doesn't match the expected skill_id (otherwise webhook routing
# silently breaks: the Hermes webhook subscription's --skills flag references
# skill_id but the file's name is something else).
#
# Args: <skill-md-path> <expected-name>
# Stdout: nothing on success. Stderr: reason on failure. Return: 0 ok, 1 fail.

assert_skill_frontmatter() {
  local path=${1:?skill_md path required}
  local expected=${2:?expected name required}
  [ -f "$path" ] || { echo "skill_md not found at $path" >&2; return 1; }
  # stdlib-only: locate the frontmatter delimiters, scan for `name: <value>`.
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
# Look for a line that is exactly '---' (end-of-frontmatter marker).
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

# ---- hermes webhook subscribe stdout parsing ------------------------------
# `hermes webhook subscribe` may emit JSON or human-friendly text depending on
# version. We try JSON first, then fall back to a tolerant line scanner that
# pulls "name: <foo>" / "URL: <https://...>" out.
#
# Args: <stdout-text>
# Stdout: {"name":"...","url":"..."} (either field may be empty if not parsed)
# Return: 0 always. Caller is responsible for treating empty `url` as failure.

parse_subscribe_output() {
  local text=${1:-}
  W2A_SUB_OUT="$text" python3 - <<'PY'
import json, os, re, sys
text = os.environ.get("W2A_SUB_OUT", "")
out = {"name": "", "url": ""}
try:
    parsed = json.loads(text.strip())
    if isinstance(parsed, dict):
        url = parsed.get("url") or parsed.get("webhook_url") or ""
        name = parsed.get("name") or parsed.get("subscription_name") or ""
        if url:
            print(json.dumps({"name": str(name) if name else "", "url": str(url)}))
            sys.exit(0)
except json.JSONDecodeError:
    pass
url_re  = re.compile(r"^\s*(?:URL|url|Webhook URL)\s*[:=]\s*(?P<url>https?://\S+)", re.IGNORECASE)
name_re = re.compile(r"\b(?:name|subscription)\b\s*[:=]\s*(\S+)", re.IGNORECASE)
for line in text.splitlines():
    if not out["url"]:
        m = url_re.search(line)
        if m:
            out["url"] = m.group("url")
            continue
    if not out["name"]:
        m = name_re.search(line)
        if m:
            out["name"] = m.group(1)
print(json.dumps(out))
PY
}
