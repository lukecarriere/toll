#!/usr/bin/env bash
# After a deploy. Confirms live pages return the expected status and, when
# asked, contain given phrases. Default is every loc in /sitemap.xml (HTTP 200
# with an HTML title), plus /robots.txt, /sitemap.xml, /llms.txt, and
# /.well-known/toll.json. Does not follow redirects. Does not pay. Does not
# print a token, proof, invoice, or secret.
#
# Usage:
#   scripts/check-live-pages.sh [--base URL] [--out DIR] [--path PATH]
#       [--contains TEXT] [--status N]
#   scripts/check-live-pages.sh --self-check
#
# --path PATH adds a page. Later --contains TEXT and --status N apply to that
# path. --status defaults to 200. Default --base is the product's live origin.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_BASE="https://lessspam.dev"
USER_AGENT="toll-check-live-pages/1.0"

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \?//'
  echo "Defaults: --base ${DEFAULT_BASE}"
}

BASE=""
OUT=""
SELF_CHECK=0
# Parallel arrays for extra (or only-extra-when-set-with-defaults) path checks.
PATHS=()
STATUSES=()
# CONTAINS_N[i] is a newline-joined list of phrases for PATHS[i].
CONTAINS_N=()

current_index() {
  if [[ ${#PATHS[@]} -eq 0 ]]; then
    echo "pass --path before --contains or --status" >&2
    exit 64
  fi
  echo $((${#PATHS[@]} - 1))
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --base) BASE="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    --path)
      PATHS+=("$2")
      STATUSES+=(200)
      CONTAINS_N+=("")
      shift 2
      ;;
    --contains)
      i="$(current_index)"
      if [[ -n "${CONTAINS_N[$i]}" ]]; then
        CONTAINS_N[$i]="${CONTAINS_N[$i]}"$'\n'"$2"
      else
        CONTAINS_N[$i]="$2"
      fi
      shift 2
      ;;
    --status)
      i="$(current_index)"
      STATUSES[$i]="$2"
      shift 2
      ;;
    --self-check) SELF_CHECK=1; shift ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

BASE="${BASE:-$DEFAULT_BASE}"
BASE="${BASE%/}"

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

html_decode_file() {
  # Decode common entities so phrase checks match what verifiers read in a browser.
  python3 - "$1" <<'PY'
import html, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
print(html.unescape(text), end="")
PY
}

has_html_title() {
  python3 - "$1" <<'PY'
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
sys.exit(0 if re.search(r"<title\b[^>]*>[^<].*?</title>", text, re.I | re.S) else 1)
PY
}

file_contains() {
  local file="$1" phrase="$2"
  python3 - "$file" "$phrase" <<'PY'
import html, sys
from pathlib import Path
text = html.unescape(Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace"))
needle = sys.argv[2]
sys.exit(0 if needle in text else 1)
PY
}

fetch() {
  # fetch <url> <bodyfile> <headerfile> -> prints HTTP status (or 000)
  local url="$1" body="$2" headers="$3"
  local code
  set +e
  code="$(curl -sS -D "$headers" -o "$body" --max-time 20 -A "$USER_AGENT" \
    --write-out '%{http_code}' --max-redirs 0 "$url" 2>"$headers.err")"
  local curl_status=$?
  set -e
  if [[ "$curl_status" -ne 0 && -z "$code" ]]; then
    code="000"
  fi
  printf '%s' "${code:-000}"
}

safe_name() {
  echo "$1" | sed 's#[^A-Za-z0-9._-]#_#g; s#^_##; s#^$#root#'
}

check_url() {
  local label="$1" url="$2" expect_status="$3" expect_title="$4"
  shift 4
  local phrases=("$@")
  local work body headers status
  work="$(mktemp -d "${TMPDIR:-/tmp}/live-page.XXXXXX")"
  body="$work/body"
  headers="$work/headers"
  status="$(fetch "$url" "$body" "$headers")"
  if [[ -n "${OUT:-}" ]]; then
    mkdir -p "$OUT"
    cp "$headers" "$OUT/${label}.headers"
    redact <"$body" >"$OUT/${label}.body"
    echo "$status" >"$OUT/${label}.status"
  fi

  if [[ "$status" != "$expect_status" ]]; then
    note "$label" FAIL "GET $url expected $expect_status got $status"
    rm -rf "$work"
    return 0
  fi

  if [[ "$expect_title" == "1" ]]; then
    if ! has_html_title "$body"; then
      note "$label" FAIL "GET $url $status, no HTML title"
      rm -rf "$work"
      return 0
    fi
  fi

  local phrase
  for phrase in "${phrases[@]}"; do
    [[ -z "$phrase" ]] && continue
    if ! file_contains "$body" "$phrase"; then
      note "$label" FAIL "GET $url $status, missing phrase"
      rm -rf "$work"
      return 0
    fi
  done

  note "$label" PASS "GET $url $status"
  rm -rf "$work"
}

sitemap_locs() {
  local file="$1"
  python3 - "$file" "$BASE" <<'PY'
import re, sys
from pathlib import Path
from xml.etree import ElementTree as ET
base = sys.argv[2].rstrip("/")
text = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
locs = []
try:
    root = ET.fromstring(text)
    # Local-name only so a default xmlns still matches.
    for el in root.iter():
        if el.tag.split("}", 1)[-1] == "loc" and el.text:
            locs.append(el.text.strip())
except ET.ParseError:
    locs = re.findall(r"<loc>\s*([^<]+?)\s*</loc>", text, re.I)
# Only same-origin locs, so a bad sitemap cannot send us elsewhere.
for loc in locs:
    if loc == base or loc.startswith(base + "/"):
        print(loc)
PY
}

run_checks() {
  FAILED=0
  local work sitemap_body sitemap_headers status loc name path expect phrases i

  work="$(mktemp -d "${TMPDIR:-/tmp}/live-pages.XXXXXX")"
  sitemap_body="$work/sitemap"
  sitemap_headers="$work/sitemap.headers"

  status="$(fetch "$BASE/sitemap.xml" "$sitemap_body" "$sitemap_headers")"
  if [[ "$status" != "200" ]]; then
    note "sitemap.xml" FAIL "GET $BASE/sitemap.xml expected 200 got $status"
  else
    note "sitemap.xml" PASS "GET $BASE/sitemap.xml 200"
    while IFS= read -r loc; do
      [[ -z "$loc" ]] && continue
      name="page-$(safe_name "${loc#"$BASE"}")"
      check_url "$name" "$loc" 200 1
    done < <(sitemap_locs "$sitemap_body")
  fi

  check_url "robots.txt" "$BASE/robots.txt" 200 0
  check_url "llms.txt" "$BASE/llms.txt" 200 0
  check_url "manifest" "$BASE/.well-known/toll.json" 200 0

  for i in "${!PATHS[@]}"; do
    path="${PATHS[$i]}"
    case "$path" in
      http://*|https://*) ;;
      /*) path="$BASE$path" ;;
      *) path="$BASE/$path" ;;
    esac
    expect="${STATUSES[$i]}"
    # Split phrases on newlines; keep empty array if none.
    phrases=()
    if [[ -n "${CONTAINS_N[$i]}" ]]; then
      while IFS= read -r line; do
        phrases+=("$line")
      done <<< "${CONTAINS_N[$i]}"
    fi
    name="expect-$(safe_name "${path#"$BASE"}")"
    check_url "$name" "$path" "$expect" 0 "${phrases[@]+"${phrases[@]}"}"
  done

  rm -rf "$work"
  if [[ "$FAILED" -eq 0 ]]; then
    echo "OVERALL: PASS"
    return 0
  fi
  echo "OVERALL: FAIL"
  return 1
}

start_fixture() {
  # start_fixture <mode> -> sets FIXTURE_URL and FIXTURE_PID
  local mode="$1"
  local portfile py
  portfile="$(mktemp "${TMPDIR:-/tmp}/live-pages.XXXXXX.port")"
  py="$(mktemp "${TMPDIR:-/tmp}/live-pages.XXXXXX.py")"
  cat >"$py" <<'PY'
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

mode = os.environ["LP_MODE"]
PAGES = {
    "/": ("text/html", "<!doctype html><title>Home · Toll</title><h1>Home</h1><p>Welcome.</p>"),
    "/docs": ("text/html", "<!doctype html><title>Docs · Toll</title><h1>Docs</h1><p>Guide.</p>"),
    "/docs/ask": ("text/html", "<!doctype html><title>Agent calls · Toll</title><h1>Agent calls</h1><p>Prices are in msat; USD isn't available.</p>"),
    "/robots.txt": ("text/plain", "User-agent: *\nAllow: /\n"),
    "/llms.txt": ("text/plain", "# Toll\n"),
    "/.well-known/toll.json": ("application/json", json.dumps({"name": "Toll"})),
}

class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/sitemap.xml":
            if mode == "no-sitemap":
                self.send_response(404)
                self.end_headers()
                return
            host = self.headers.get("Host", "127.0.0.1")
            body = (
                '<?xml version="1.0" encoding="UTF-8"?>\n'
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                f"  <url><loc>http://{host}/</loc></url>\n"
                f"  <url><loc>http://{host}/docs</loc></url>\n"
                f"  <url><loc>http://{host}/docs/ask</loc></url>\n"
                "</urlset>\n"
            ).encode()
            self.send_response(200)
            self.send_header("content-type", "application/xml")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        page = dict(PAGES)
        if mode == "missing-page":
            page.pop("/docs", None)
        if mode == "missing-phrase":
            page["/docs/ask"] = ("text/html", "<!doctype html><title>Agent calls · Toll</title><h1>Agent calls</h1><p>No prices here.</p>")
        if mode == "token-body":
            # A static fixture token, not a secret. The check must not print it.
            page["/docs"] = ("text/html", "<!doctype html><title>Docs · Toll</title><p>cashuA0123456789abcdefsecret</p>")
        if path not in page:
            self.send_response(404)
            self.end_headers()
            return
        ctype, text = page[path]
        body = text.encode()
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

server = HTTPServer(("127.0.0.1", 0), H)
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    fh.write(f"http://127.0.0.1:{server.server_address[1]}\n")
    fh.flush()
server.serve_forever()
PY
  LP_MODE="$mode" python3 "$py" "$portfile" &
  FIXTURE_PID=$!
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if [[ -s "$portfile" ]]; then
      FIXTURE_URL="$(tr -d '[:space:]' <"$portfile")"
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

run_self_check() {
  local output status
  echo "self-check: proving default pages can PASS and each check can FAIL"

  start_fixture ok
  set +e
  output="$(BASE="$FIXTURE_URL" OUT="" run_checks)"
  status=$?
  set -e
  stop_fixture
  if [[ "$status" -ne 0 ]]; then
    echo "self-check: baseline should PASS, got:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  echo "self-check: baseline PASS"

  start_fixture no-sitemap
  set +e
  output="$(BASE="$FIXTURE_URL" OUT="" run_checks)"
  status=$?
  set -e
  stop_fixture
  if [[ "$status" -eq 0 ]] || ! printf '%s\n' "$output" | grep -q '^sitemap.xml: FAIL'; then
    echo "self-check: expected sitemap.xml FAIL, got:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  echo "self-check: sitemap.xml FAIL as expected"

  start_fixture missing-page
  set +e
  output="$(BASE="$FIXTURE_URL" OUT="" run_checks)"
  status=$?
  set -e
  stop_fixture
  if [[ "$status" -eq 0 ]] || ! printf '%s\n' "$output" | grep -q 'page-docs: FAIL'; then
    echo "self-check: expected page-docs FAIL, got:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  echo "self-check: page 200 FAIL as expected"

  start_fixture missing-phrase
  set +e
  output="$(
    PATHS=("/docs/ask")
    STATUSES=(200)
    CONTAINS_N=("Prices are in msat; USD isn't available")
    BASE="$FIXTURE_URL"
    OUT=""
    run_checks
  )"
  status=$?
  set -e
  stop_fixture
  if [[ "$status" -eq 0 ]] || ! printf '%s\n' "$output" | grep -q 'missing phrase'; then
    echo "self-check: expected phrase FAIL, got:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  echo "self-check: phrase FAIL as expected"

  start_fixture token-body
  set +e
  output="$(BASE="$FIXTURE_URL" OUT="" run_checks)"
  status=$?
  set -e
  stop_fixture
  if printf '%s\n' "$output" | grep -q 'cashuA0123456789abcdefsecret'; then
    echo "self-check: printed a token" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  if [[ "$status" -ne 0 ]]; then
    echo "self-check: token-body should PASS (token must only be redacted), got:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  echo "self-check: token not printed"

  echo "self-check: ok"
}

if [[ "$SELF_CHECK" -eq 1 ]]; then
  run_self_check
  exit 0
fi

run_checks
