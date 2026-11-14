#!/usr/bin/env bash
# Live check that www.<apex> returns 308 to the apex and keeps the path and
# query. Does not follow the redirect. Does not pay. Does not print a token,
# proof, or secret.
#
# Usage:
#   scripts/check-www-redirect.sh [--apex URL] [--path PATH] [--method METHOD] [--out DIR]
#   scripts/check-www-redirect.sh --self-check
#
# Each --path is checked (default: / and /docs/ask?q=1). METHOD defaults to
# GET; pass --method once to use it for every path. Default --apex is the
# product's live origin.

set -euo pipefail

DEFAULT_APEX="https://lessspam.dev"
USER_AGENT="toll-check-www-redirect/1.0"

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \?//'
  echo "Defaults: --apex ${DEFAULT_APEX} --path / --path /docs/ask?q=1 --method GET"
}

APEX=""
OUT=""
SELF_CHECK=0
METHOD="GET"
PATHS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --apex) APEX="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    --path) PATHS+=("$2"); shift 2 ;;
    --method) METHOD="${2:?}"; shift 2 ;;
    --self-check) SELF_CHECK=1; shift ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

APEX="${APEX:-$DEFAULT_APEX}"
APEX="${APEX%/}"
if [[ ${#PATHS[@]} -eq 0 ]]; then
  PATHS=("/" "/docs/ask?q=1")
fi

redact() {
  python3 -c 'import re,sys; pat=re.compile(r"(cashu[AB]|creqA|lnbc)[A-Za-z0-9_+/=.-]{8,}|((?:Toll|Bearer|L402)\s+)[A-Za-z0-9_+/=.:-]{8,}|nostr\+walletconnect://[^\s\"]+"); sys.stdout.write(pat.sub("<redacted>", sys.stdin.read()))'
}
note() {
  local name="$1" status="$2" detail="${3:-}"
  if [[ -n "$detail" ]]; then
    printf '%s: %s  %s\n' "$name" "$status" "$detail"
  else
    printf '%s: %s\n' "$name" "$status"
  fi
  if [[ "$status" == FAIL ]]; then
    FAILED=1
  fi
  if [[ -n "${OUT:-}" ]]; then
    mkdir -p "$OUT"
    {
      echo "check=$name"
      echo "status=$status"
      echo "detail=$detail"
    } | redact >"$OUT/${name}.txt"
  fi
}

safe_name() {
  echo "$1" | sed 's#[^A-Za-z0-9._-]#_#g; s#^_##; s#^$#root#'
}

www_url() {
  python3 - "$APEX" "$1" <<'PY'
import sys
from urllib.parse import urlparse, urlunparse
apex = urlparse(sys.argv[1])
path = sys.argv[2]
if not path.startswith("/"):
    path = "/" + path
# Split query if the caller passed it on the path.
query = ""
if "?" in path:
    path, query = path.split("?", 1)
host = apex.hostname
if not host:
    raise SystemExit("apex has no host")
www = "www." + host
# Keep an explicit port on a local fixture (http://127.0.0.1:PORT).
if apex.port:
    www = f"{www}:{apex.port}"
print(urlunparse((apex.scheme, www, path, "", query, "")))
PY
}

expected_location() {
  python3 - "$APEX" "$1" <<'PY'
import sys
from urllib.parse import urlparse, urlunparse
apex = urlparse(sys.argv[1])
path = sys.argv[2]
if not path.startswith("/"):
    path = "/" + path
query = ""
if "?" in path:
    path, query = path.split("?", 1)
# Apex host includes an explicit port when the fixture has one.
print(urlunparse((apex.scheme, apex.netloc, path, "", query, "")))
PY
}

location_of() {
  python3 - "$1" <<'PY'
import sys
from pathlib import Path
location = ""
for raw in Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace").splitlines():
    if raw.lower().startswith("location:"):
        location = raw.split(":", 1)[1].strip()
print(location)
PY
}

locations_match() {
  python3 - "$1" "$2" <<'PY'
import sys
from urllib.parse import urlparse
got, expected = sys.argv[1], sys.argv[2]
g, e = urlparse(got), urlparse(expected)
if g.scheme.lower() != e.scheme.lower():
    raise SystemExit(1)
if (g.hostname or "").lower() != (e.hostname or "").lower():
    raise SystemExit(1)
if g.port != e.port:
    raise SystemExit(1)
if g.path != e.path or g.query != e.query:
    raise SystemExit(1)
raise SystemExit(0)
PY
}

check_path() {
  local path="$1"
  local url expect headers body status location name
  url="$(www_url "$path")"
  expect="$(expected_location "$path")"
  name="www-$(safe_name "$path")"
  headers="$(mktemp "${TMPDIR:-/tmp}/www.XXXXXX.headers")"
  body="$(mktemp "${TMPDIR:-/tmp}/www.XXXXXX.body")"
  set +e
  status="$(curl -sS -D "$headers" -o "$body" --max-time 20 -A "$USER_AGENT" \
    -X "$METHOD" --write-out '%{http_code}' --max-redirs 0 "$url" 2>"$headers.err")"
  local curl_status=$?
  set -e
  if [[ "$curl_status" -ne 0 && -z "$status" ]]; then
    status="000"
  fi
  status="${status:-000}"
  location="$(location_of "$headers")"
  if [[ -n "${OUT:-}" ]]; then
    mkdir -p "$OUT"
    cp "$headers" "$OUT/${name}.headers"
    redact <"$body" >"$OUT/${name}.body"
    echo "$status" >"$OUT/${name}.status"
    printf '%s\n' "$location" | redact >"$OUT/${name}.location"
  fi
  if [[ "$status" != "308" ]]; then
    note "$name" FAIL "$METHOD $url expected 308 got $status"
    rm -f "$headers" "$headers.err" "$body"
    return 0
  fi
  if [[ -z "$location" ]]; then
    note "$name" FAIL "$METHOD $url 308, no Location"
    rm -f "$headers" "$headers.err" "$body"
    return 0
  fi
  if ! locations_match "$location" "$expect"; then
    note "$name" FAIL "$METHOD $url 308 Location did not keep the apex, path, and query"
    rm -f "$headers" "$headers.err" "$body"
    return 0
  fi
  note "$name" PASS "$METHOD $url 308 -> $expect"
  rm -f "$headers" "$headers.err" "$body"
}

run_checks() {
  FAILED=0
  local path
  for path in "${PATHS[@]}"; do
    check_path "$path"
  done
  if [[ "$FAILED" -eq 0 ]]; then
    echo "OVERALL: PASS"
    return 0
  fi
  echo "OVERALL: FAIL"
  return 1
}

start_fixture() {
  local mode="$1"
  local portfile py
  portfile="$(mktemp "${TMPDIR:-/tmp}/www.XXXXXX.port")"
  py="$(mktemp "${TMPDIR:-/tmp}/www.XXXXXX.py")"
  cat >"$py" <<'PY'
import os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, urlunparse

mode = os.environ["WWW_MODE"]
apex_host = os.environ["WWW_APEX_HOST"]  # 127.0.0.1:PORT, filled after bind

class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def answer(self):
        host = (self.headers.get("Host") or "").split("@")[-1]
        parsed = urlparse(self.path)
        path = parsed.path or "/"
        query = parsed.query
        target = urlunparse(("http", apex_host, path, "", query, ""))
        if mode == "wrong-status":
            self.send_response(301)
            self.send_header("location", target)
            self.end_headers()
            return
        if mode == "drop-query":
            target = urlunparse(("http", apex_host, path, "", "", ""))
            self.send_response(308)
            self.send_header("location", target)
            self.end_headers()
            return
        if mode == "wrong-host":
            self.send_response(308)
            self.send_header("location", urlunparse(("http", "www." + apex_host, path, "", query, "")))
            self.end_headers()
            return
        # ok: 308 to apex, same path and query
        self.send_response(308)
        self.send_header("location", target)
        self.end_headers()

    def do_GET(self):
        self.answer()

    def do_HEAD(self):
        self.answer()

server = HTTPServer(("127.0.0.1", 0), H)
port = server.server_address[1]
apex_host = f"127.0.0.1:{port}"
os.environ["WWW_APEX_HOST"] = apex_host
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    fh.write(str(port) + "\n")
    fh.flush()
server.serve_forever()
PY
  WWW_MODE="$mode" WWW_APEX_HOST="127.0.0.1:0" python3 "$py" "$portfile" &
  FIXTURE_PID=$!
  local i
  for i in $(seq 1 40); do
    if [[ -s "$portfile" ]]; then
      FIXTURE_PORT="$(tr -d '[:space:]' <"$portfile")"
      FIXTURE_APEX="http://127.0.0.1:${FIXTURE_PORT}"
      rm -f "$portfile" "$py"
      return 0
    fi
    if ! kill -0 "$FIXTURE_PID" 2>/dev/null; then
      echo "fixture server exited" >&2
      rm -f "$portfile" "$py"
      return 1
    fi
    sleep 0.05
  done
  echo "fixture server did not start" >&2
  return 1
}

stop_fixture() {
  if [[ -n "${FIXTURE_PID:-}" ]]; then
    kill "$FIXTURE_PID" 2>/dev/null || true
    wait "$FIXTURE_PID" 2>/dev/null || true
    FIXTURE_PID=""
  fi
}

# www.127.0.0.1 does not resolve. For the self-check, curl --resolve maps
# www.127.0.0.1:PORT to 127.0.0.1 so the Host header is the www form.
curl() {
  if [[ -n "${FIXTURE_PORT:-}" ]]; then
    command curl --resolve "www.127.0.0.1:${FIXTURE_PORT}:127.0.0.1" "$@"
  else
    command curl "$@"
  fi
}

run_self_check() {
  local output status
  echo "self-check: proving a correct 308 can PASS and each failure can FAIL"

  start_fixture ok
  set +e
  output="$(
    APEX="$FIXTURE_APEX"
    OUT=""
    PATHS=("/" "/docs/ask?q=1")
    METHOD="GET"
    run_checks
  )"
  status=$?
  set -e
  stop_fixture
  if [[ "$status" -ne 0 ]]; then
    echo "self-check: baseline should PASS, got:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  echo "self-check: baseline PASS"

  start_fixture wrong-status
  set +e
  output="$(
    APEX="$FIXTURE_APEX"
    OUT=""
    PATHS=("/")
    METHOD="GET"
    run_checks
  )"
  status=$?
  set -e
  stop_fixture
  if [[ "$status" -eq 0 ]] || ! printf '%s\n' "$output" | grep -q 'expected 308 got 301'; then
    echo "self-check: expected 308-status FAIL, got:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  echo "self-check: wrong status FAIL as expected"

  start_fixture drop-query
  set +e
  output="$(
    APEX="$FIXTURE_APEX"
    OUT=""
    PATHS=("/docs/ask?q=1")
    METHOD="GET"
    run_checks
  )"
  status=$?
  set -e
  stop_fixture
  if [[ "$status" -eq 0 ]] || ! printf '%s\n' "$output" | grep -q 'did not keep the apex, path, and query'; then
    echo "self-check: expected drop-query FAIL, got:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  echo "self-check: dropped query FAIL as expected"

  start_fixture wrong-host
  set +e
  output="$(
    APEX="$FIXTURE_APEX"
    OUT=""
    PATHS=("/")
    METHOD="GET"
    run_checks
  )"
  status=$?
  set -e
  stop_fixture
  if [[ "$status" -eq 0 ]] || ! printf '%s\n' "$output" | grep -q 'did not keep the apex, path, and query'; then
    echo "self-check: expected wrong-host FAIL, got:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  echo "self-check: wrong host FAIL as expected"

  echo "self-check: ok"
}

if [[ "$SELF_CHECK" -eq 1 ]]; then
  run_self_check
  exit 0
fi

run_checks
