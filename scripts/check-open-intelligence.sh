#!/usr/bin/env bash
# Read-only checks of a live origin: the agent manifest, /llms.txt as text,
# an unpaid 402 with an X-Cashu header, and a gitleaks scan of this repo.
# Never pays a 402. Never prints a token, proof, or secret.
#
# Usage:
#   scripts/check-open-intelligence.sh [--base URL] [--manifest PATH]
#       [--paid-path PATH] [--paid-method METHOD] [--repo DIR]
#       [--gitleaks-cmd CMD]
#   scripts/check-open-intelligence.sh --self-check
#
# Default --base is the product's live origin. Prints PASS/FAIL per check
# and exits nonzero if any check FAILs. --self-check starts a local fixture
# origin and proves each check can FAIL.

set -euo pipefail
# A gitleaks we install lands here; keep any caller-chosen binary first.
export PATH="${PATH}:${HOME}/.local/bin"

# --- product defaults (this checkout) ---
DEFAULT_BASE="https://lessspam.dev"
DEFAULT_MANIFEST="/.well-known/toll.json"
DEFAULT_PAID_PATH="/demo/contact"
DEFAULT_PAID_METHOD="POST"
# Extra curl arguments for the unpaid 402 probe. JSON body only; no payment.
paid_curl_args() {
  CURL_PAID_ARGS=( -H "accept: application/json" -H "content-type: application/json" -H "toll-client: agent" --data '{}' )
}
# --- end product defaults ---

USER_AGENT="open-intelligence-check/1.0"
GITLEAKS_VER="8.30.1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \?//'
  echo "Defaults: --base ${DEFAULT_BASE} --manifest ${DEFAULT_MANIFEST} --paid-path ${DEFAULT_PAID_PATH}"
}

BASE=""
MANIFEST=""
PAID_PATH=""
PAID_METHOD=""
REPO=""
GITLEAKS_CMD=""
SELF_CHECK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --base) BASE="${2:?}"; shift 2 ;;
    --manifest) MANIFEST="${2:?}"; shift 2 ;;
    --paid-path) PAID_PATH="${2:?}"; shift 2 ;;
    --paid-method) PAID_METHOD="${2:?}"; shift 2 ;;
    --repo) REPO="${2:?}"; shift 2 ;;
    --gitleaks-cmd) GITLEAKS_CMD="${2:?}"; shift 2 ;;
    --self-check) SELF_CHECK=1; shift ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

BASE="${BASE:-$DEFAULT_BASE}"
MANIFEST="${MANIFEST:-$DEFAULT_MANIFEST}"
PAID_PATH="${PAID_PATH:-$DEFAULT_PAID_PATH}"
PAID_METHOD="${PAID_METHOD:-$DEFAULT_PAID_METHOD}"
REPO="${REPO:-$ROOT}"
BASE="${BASE%/}"
case "$MANIFEST" in /*) ;; *) MANIFEST="/$MANIFEST" ;; esac
case "$PAID_PATH" in /*) ;; *) PAID_PATH="/$PAID_PATH" ;; esac

FAILED=0
WORKDIR=""
cleanup() { [[ -n "$WORKDIR" && -d "$WORKDIR" ]] && rm -rf "$WORKDIR"; }
trap cleanup EXIT INT TERM
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/oi-check.XXXXXX")"

note() {
  local name="$1" status="$2" detail="${3:-}"
  if [[ -n "$detail" ]]; then
    printf '%s: %s  %s\n' "$name" "$status" "$detail"
  else
    printf '%s: %s\n' "$name" "$status"
  fi
  if [[ "$status" != PASS ]]; then
    FAILED=1
  fi
}

header_value() {
  local file="$1" name="$2"
  awk -v n="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" '
    BEGIN { FS=": " }
    {
      line=$0
      sub(/\r$/, "", line)
      split(line, parts, ":")
      key=parts[1]
      gsub(/^ +| +$/, "", key)
      if (tolower(key) == n) {
        sub(/^[^:]+:[[:space:]]*/, "", line)
        print line
      }
    }
  ' "$file" | tail -n 1
}

scheme_of() {
  local value="$1"
  case "$value" in
    creqA*) echo "creqA" ;;
    cashuB*) echo "cashuB" ;;
    cashuA*) echo "cashuA" ;;
    "") echo "missing" ;;
    *) echo "other" ;;
  esac
}

# Valid JSON? Prefer python3, then node. No body is printed.
json_ok() {
  local file="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$file" 2>/dev/null
  elif command -v node >/dev/null 2>&1; then
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$file" 2>/dev/null
  else
    return 2
  fi
}

looks_like_html() {
  local file="$1" ctype="$2"
  case "$ctype" in
    text/html|application/xhtml+xml) return 0 ;;
  esac
  # A text/plain or missing type that is actually an HTML document still fails.
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$file" <<'PY'
import sys
text = open(sys.argv[1], "rb").read(512).lstrip().lower()
sys.exit(0 if text.startswith(b"<!doctype html") or text.startswith(b"<html") else 1)
PY
  elif command -v node >/dev/null 2>&1; then
    node -e 'const fs=require("fs"); const t=fs.readFileSync(process.argv[1],"utf8").trimStart().slice(0,256).toLowerCase(); process.exit(t.startsWith("<!doctype html")||t.startsWith("<html")?0:1)' "$file"
  else
    return 1
  fi
}

fetch() {
  # fetch <out-prefix> <method> <url> [curl args...]
  local prefix="$1" method="$2" url="$3"
  shift 3
  local body="$prefix.body" hdr="$prefix.hdr" code_file="$prefix.code"
  local code curl_ok
  set +e
  code=$(curl -sS --max-time 20 -A "$USER_AGENT" -o "$body" -D "$hdr" -w '%{http_code}' -X "$method" "$@" "$url" 2>"$prefix.curlerr")
  curl_ok=$?
  set -e
  if [[ "$curl_ok" -ne 0 ]]; then
    printf '000' >"$code_file"
    printf 'curl-exit-%s' "$curl_ok" >"$prefix.err"
    return 0
  fi
  printf '%s' "$code" >"$code_file"
}

content_type_of() {
  local raw
  raw="$(header_value "$1" "content-type")"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  raw="${raw%%;*}"
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  printf '%s' "$raw"
}

install_gitleaks() {
  if command -v gitleaks >/dev/null 2>&1; then
    return 0
  fi
  local arch
  case "$(uname -m)" in
    x86_64) arch="linux_x64" ;;
    aarch64|arm64) arch="linux_arm64" ;;
    *) echo "unsupported architecture $(uname -m) for gitleaks" >&2; return 1 ;;
  esac
  local tmp ver="$GITLEAKS_VER"
  tmp="$(mktemp -d)"
  curl -fsSL --max-time 60 -o "$tmp/gitleaks.tar.gz" "https://github.com/gitleaks/gitleaks/releases/download/v${ver}/gitleaks_${ver}_${arch}.tar.gz"
  curl -fsSL --max-time 60 -o "$tmp/checksums.txt" "https://github.com/gitleaks/gitleaks/releases/download/v${ver}/gitleaks_${ver}_checksums.txt"
  local want
  want="$(awk -v n="gitleaks_${ver}_${arch}.tar.gz" '$2==n{print $1; exit}' "$tmp/checksums.txt")"
  if [[ -z "$want" ]]; then
    echo "gitleaks checksum not found for ${arch}" >&2
    rm -rf "$tmp"
    return 1
  fi
  echo "${want}  $tmp/gitleaks.tar.gz" | sha256sum -c - >/dev/null
  tar -xzf "$tmp/gitleaks.tar.gz" -C "$tmp" gitleaks
  mkdir -p "${HOME}/.local/bin"
  install -m 0755 "$tmp/gitleaks" "${HOME}/.local/bin/gitleaks"
  rm -rf "$tmp"
  command -v gitleaks >/dev/null 2>&1
}

run_manifest() {
  local prefix="$WORKDIR/manifest" url="${BASE}${MANIFEST}"
  fetch "$prefix" GET "$url"
  local code ctype
  code="$(cat "$prefix.code")"
  if [[ "$code" == 000 ]]; then
    note "manifest" FAIL "GET ${url} $(cat "$prefix.err")"
    return
  fi
  ctype="$(content_type_of "$prefix.hdr")"
  if [[ "$code" != 200 ]]; then
    note "manifest" FAIL "GET ${url} HTTP ${code}"
    return
  fi
  if looks_like_html "$prefix.body" "$ctype"; then
    note "manifest" FAIL "GET ${url} 200 was HTML"
    return
  fi
  if ! json_ok "$prefix.body"; then
    local j=$?
    if [[ "$j" -eq 2 ]]; then
      note "manifest" FAIL "GET ${url} 200, need python3 or node to parse JSON"
    else
      note "manifest" FAIL "GET ${url} 200 was not valid JSON"
    fi
    return
  fi
  note "manifest" PASS "GET ${url} 200 valid JSON"
}

run_llms() {
  local prefix="$WORKDIR/llms" url="${BASE}/llms.txt"
  fetch "$prefix" GET "$url"
  local code ctype
  code="$(cat "$prefix.code")"
  if [[ "$code" == 000 ]]; then
    note "llms.txt" FAIL "GET ${url} $(cat "$prefix.err")"
    return
  fi
  ctype="$(content_type_of "$prefix.hdr")"
  if [[ "$code" != 200 ]]; then
    note "llms.txt" FAIL "GET ${url} HTTP ${code}"
    return
  fi
  if [[ "$ctype" != text/plain ]]; then
    note "llms.txt" FAIL "GET ${url} 200 content-type ${ctype:-missing} (want text/plain)"
    return
  fi
  if looks_like_html "$prefix.body" "$ctype"; then
    note "llms.txt" FAIL "GET ${url} 200 text/plain body looks like HTML"
    return
  fi
  note "llms.txt" PASS "GET ${url} 200 text/plain"
}

run_paid() {
  local prefix="$WORKDIR/paid" url="${BASE}${PAID_PATH}"
  local args=()
  paid_curl_args
  fetch "$prefix" "$PAID_METHOD" "$url" "${CURL_PAID_ARGS[@]}"
  local code xc scheme
  code="$(cat "$prefix.code")"
  if [[ "$code" == 000 ]]; then
    note "paid-402" FAIL "${PAID_METHOD} ${url} $(cat "$prefix.err")"
    return
  fi
  xc="$(header_value "$prefix.hdr" "x-cashu")"
  scheme="$(scheme_of "$xc")"
  if [[ "$code" != 402 ]]; then
    note "paid-402" FAIL "${PAID_METHOD} ${url} HTTP ${code} (want 402, X-Cashu not paid)"
    return
  fi
  if [[ -z "$xc" ]]; then
    note "paid-402" FAIL "${PAID_METHOD} ${url} 402 missing X-Cashu header"
    return
  fi
  # Print only the scheme prefix, never the header value.
  note "paid-402" PASS "${PAID_METHOD} ${url} 402 X-Cashu=${scheme}"
}

run_gitleaks() {
  local bin=""
  if [[ -n "$GITLEAKS_CMD" ]]; then
    bin="$GITLEAKS_CMD"
    if [[ ! -x "$bin" ]]; then
      # Allow a command on PATH, or a relative path.
      if command -v "$bin" >/dev/null 2>&1; then
        bin="$(command -v "$bin")"
      elif [[ -x "$bin" ]]; then
        :
      else
        note "gitleaks" FAIL "gitleaks command not found: ${GITLEAKS_CMD}"
        return
      fi
    fi
  else
    if ! install_gitleaks; then
      note "gitleaks" FAIL "gitleaks is not installed and could not be installed"
      return
    fi
    bin="$(command -v gitleaks)"
  fi
  local report="$WORKDIR/gitleaks.json" log="$WORKDIR/gitleaks.log"
  local cfg=()
  if [[ -f "$REPO/.gitleaks.toml" ]]; then
    cfg=(--config "$REPO/.gitleaks.toml")
  fi
  local status=0
  set +e
  # Working tree only, not full history. Historical test fixtures can still
  # flag a history scan even when the allowlist covers current files.
  "$bin" detect --source "$REPO" --no-git --redact --no-banner \
    --report-format json --report-path "$report" "${cfg[@]}" >"$log" 2>&1
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    note "gitleaks" PASS "no leaks in ${REPO}"
    return
  fi
  if [[ "$status" -eq 1 ]]; then
    local count="?"
    if [[ -f "$report" ]]; then
      count=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$report" 2>/dev/null || echo "?")
    fi
    note "gitleaks" FAIL "findings=${count} (redacted; see gitleaks report, not printed)"
    return
  fi
  note "gitleaks" FAIL "gitleaks exited ${status}"
}

run_all() {
  FAILED=0
  run_manifest
  run_llms
  run_paid
  run_gitleaks
  if [[ "$FAILED" -eq 0 ]]; then
    echo "OVERALL: PASS"
    return 0
  fi
  echo "OVERALL: FAIL"
  return 1
}

start_fixture() {
  # start_fixture <mode>  -> sets FIXTURE_URL and FIXTURE_PID
  local mode="$1"
  local portfile py="$WORKDIR/fixture.py"
  portfile="$(mktemp "$WORKDIR/fixture.XXXXXX.port")"
  rm -f "$portfile"
  cat >"$py" <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
import os, sys

mode = os.environ.get("OI_MODE", "none")
manifest = os.environ["OI_MANIFEST"]
paid = os.environ["OI_PAID"]
portfile = sys.argv[1]

class H(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def respond(self, status, ctype, body):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == manifest:
            if mode == "manifest":
                self.respond(200, "text/html", b"<html>not json</html>")
            else:
                self.respond(200, "application/json", b'{"ok":true}')
            return
        if path == "/llms.txt":
            if mode == "llms":
                self.respond(200, "text/html; charset=utf-8", b"<!DOCTYPE html><html>no</html>")
            else:
                self.respond(200, "text/plain; charset=utf-8", b"Hello agents\n")
            return
        self.respond(404, "text/plain", b"not found")

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        if path == paid:
            if mode == "paid":
                self.respond(200, "application/json", b'{"ok":true}')
            else:
                body = b'{"error":"payment_required"}'
                self.send_response(402)
                self.send_header("Content-Type", "application/json")
                self.send_header("X-Cashu", "creqAfixture")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            return
        self.respond(404, "text/plain", b"not found")

httpd = HTTPServer(("127.0.0.1", 0), H)
with open(portfile, "w", encoding="utf-8") as handle:
    handle.write(str(httpd.server_address[1]))
httpd.serve_forever()
PY
  OI_MODE="$mode" OI_MANIFEST="$MANIFEST" OI_PAID="$PAID_PATH" python3 "$py" "$portfile" &
  FIXTURE_PID=$!
  local i
  for i in $(seq 1 50); do
    if [[ -s "$portfile" ]]; then
      break
    fi
    if ! kill -0 "$FIXTURE_PID" 2>/dev/null; then
      echo "fixture server exited" >&2
      return 1
    fi
    sleep 0.05
  done
  local port
  port="$(cat "$portfile")"
  FIXTURE_URL="http://127.0.0.1:${port}"
}

stop_fixture() {
  if [[ -n "${FIXTURE_PID:-}" ]]; then
    kill "$FIXTURE_PID" 2>/dev/null || true
    wait "$FIXTURE_PID" 2>/dev/null || true
    FIXTURE_PID=""
  fi
}

expect_line() {
  local output="$1" name="$2" status="$3"
  printf '%s' "$output" | grep -q "^${name}: ${status}"
}

run_self_check() {
  local stubs="$WORKDIR/stubs"
  mkdir -p "$stubs"
  cat >"$stubs/gitleaks-pass" <<'SH'
#!/bin/sh
# Stand-in that reports a clean scan (gitleaks detect exit 0).
exit 0
SH
  cat >"$stubs/gitleaks-fail" <<'SH'
#!/bin/sh
# Stand-in that reports findings (gitleaks detect exit 1).
echo "leaks found (redacted fixture)" >&2
exit 1
SH
  chmod +x "$stubs/gitleaks-pass" "$stubs/gitleaks-fail"

  local fail=0
  local out rc

  echo "self-check: proving each check can FAIL"

  start_fixture none
  set +e
  out=$(BASE="$FIXTURE_URL" GITLEAKS_CMD="$stubs/gitleaks-pass" run_one_capture)
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]] || ! expect_line "$out" manifest PASS || ! expect_line "$out" llms.txt PASS || ! expect_line "$out" paid-402 PASS || ! expect_line "$out" gitleaks PASS; then
    echo "self-check: baseline should PASS, got:" >&2
    printf '%s\n' "$out" >&2
    fail=1
  else
    echo "self-check: baseline PASS"
  fi
  stop_fixture

  prove_fail() {
    local mode="$1" name="$2"
    start_fixture "$mode"
    set +e
    out=$(BASE="$FIXTURE_URL" GITLEAKS_CMD="$stubs/gitleaks-pass" run_one_capture)
    rc=$?
    set -e
    stop_fixture
    if [[ "$rc" -eq 0 ]] || ! expect_line "$out" "$name" FAIL; then
      echo "self-check: expected ${name} FAIL, got:" >&2
      printf '%s\n' "$out" >&2
      fail=1
    else
      echo "self-check: ${name} FAIL as expected"
    fi
  }

  prove_fail manifest manifest
  prove_fail llms llms.txt
  prove_fail paid paid-402

  start_fixture none
  set +e
  out=$(BASE="$FIXTURE_URL" GITLEAKS_CMD="$stubs/gitleaks-fail" run_one_capture)
  rc=$?
  set -e
  stop_fixture
  if [[ "$rc" -eq 0 ]] || ! expect_line "$out" gitleaks FAIL; then
    echo "self-check: expected gitleaks FAIL, got:" >&2
    printf '%s\n' "$out" >&2
    fail=1
  else
    echo "self-check: gitleaks FAIL as expected"
  fi

  start_fixture none
  set +e
  out=$(BASE="$FIXTURE_URL" GITLEAKS_CMD="$stubs/no-such-gitleaks" run_one_capture)
  rc=$?
  set -e
  stop_fixture
  if [[ "$rc" -eq 0 ]] || ! expect_line "$out" gitleaks FAIL || ! printf '%s' "$out" | grep -q 'gitleaks command not found'; then
    echo "self-check: expected gitleaks missing FAIL, got:" >&2
    printf '%s\n' "$out" >&2
    fail=1
  else
    echo "self-check: gitleaks missing FAIL as expected"
  fi

  # If a real gitleaks is available, also prove it flags a leak file and
  # accepts a clean tree. The fixture token is a well-known pattern, not a secret.
  if command -v gitleaks >/dev/null 2>&1; then
    local leak="$WORKDIR/leak-tree" clean="$WORKDIR/clean-tree"
    mkdir -p "$leak" "$clean"
    # Assemble a Slack bot-token pattern at runtime so this file does not contain one.
    ident="xoxb"
    idnum="123456789012"
    suffix="abcdefghijklmnopqrstuvwx"
    printf "slack_token = %s-%s-%s-%s\n" "$ident" "$idnum" "$idnum" "$suffix" >"$leak/secrets.env"
    printf 'hello\n' >"$clean/readme.txt"
    start_fixture none
    set +e
    out=$(BASE="$FIXTURE_URL" GITLEAKS_CMD="$(command -v gitleaks)" REPO="$leak" run_one_capture)
    rc=$?
    set -e
    if [[ "$rc" -eq 0 ]] || ! expect_line "$out" gitleaks FAIL; then
      echo "self-check: expected real gitleaks FAIL on a leak file, got:" >&2
      printf '%s\n' "$out" >&2
      fail=1
    else
      echo "self-check: real gitleaks FAIL on a leak file as expected"
    fi
    set +e
    out=$(BASE="$FIXTURE_URL" GITLEAKS_CMD="$(command -v gitleaks)" REPO="$clean" run_one_capture)
    rc=$?
    set -e
    stop_fixture
    if [[ "$rc" -ne 0 ]] || ! expect_line "$out" gitleaks PASS; then
      echo "self-check: expected real gitleaks PASS on a clean tree, got:" >&2
      printf '%s\n' "$out" >&2
      fail=1
    else
      echo "self-check: real gitleaks PASS on a clean tree"
    fi
  else
    echo "self-check: real gitleaks not on PATH, skipped leak-file proof"
  fi

  if [[ "$fail" -ne 0 ]]; then
    echo "self-check: FAIL"
    return 1
  fi
  echo "self-check: ok"
  return 0
}

# Run the four checks with current BASE/REPO/GITLEAKS_CMD, capture stdout+exit.
# Used by --self-check so we can reuse the same functions in-process.
run_one_capture() {
  local saved_failed="$FAILED"
  FAILED=0
  local rc=0
  run_manifest
  run_llms
  run_paid
  run_gitleaks
  if [[ "$FAILED" -eq 0 ]]; then
    echo "OVERALL: PASS"
    rc=0
  else
    echo "OVERALL: FAIL"
    rc=1
  fi
  FAILED="$saved_failed"
  return "$rc"
}

if [[ "$SELF_CHECK" -eq 1 ]]; then
  run_self_check
  exit $?
fi

run_all
exit $?
