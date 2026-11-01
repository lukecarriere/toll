#!/usr/bin/env bash
# After a deploy. Confirms the live Worker version and the deploy message, runs the free
# live checks, and prints the rollback command. Does not deploy and does not spend.
#
# Usage:
#   scripts/release-check.sh --commit <sha> --version <worker-version-id> [--previous <version-id>] [--base URL] [--out dir]
#
# The deploy message (wrangler deploy --message <sha>) has to contain the commit.
# Reading the version needs the same Cloudflare login wrangler uses. The rollback line is printed and not run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT=""
VERSION=""
PREVIOUS=""
BASE="https://lessspam.dev"
OUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    --commit) COMMIT="${2:?}"; shift 2 ;;
    --version) VERSION="${2:?}"; shift 2 ;;
    --previous) PREVIOUS="${2:?}"; shift 2 ;;
    --base) BASE="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

if [[ -z "$COMMIT" || -z "$VERSION" ]]; then
  echo "usage: scripts/release-check.sh --commit <sha> --version <worker-version-id> [--previous <id>] [--base URL]" >&2
  exit 64
fi

SHA="$(git -C "$ROOT" rev-parse --verify "${COMMIT}^{commit}")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${OUT:-$ROOT/.verify-toll/release-${STAMP}}"
mkdir -p "$OUT"

set +e
bash "$ROOT/scripts/live-checks.sh" --base "$BASE" --out "$OUT/live" >"$OUT/live.log" 2>&1
live_status=$?
set -e
if [[ "$live_status" -eq 0 ]]; then LIVE=PASS; else LIVE=FAIL; fi

WRANGLER="$ROOT/node_modules/.bin/wrangler"
MATCH=FAIL
MATCH_REASON="wrangler did not return a deployment"
ACTIVE=""
FOUND_PREVIOUS=""
if [[ -x "$WRANGLER" ]]; then
  set +e
  "$WRANGLER" deployments status --json --name toll-site --config "$ROOT/wrangler.toml" >"$OUT/deployment.json" 2>"$OUT/deployment.err"
  dep_status=$?
  "$WRANGLER" versions list --json --name toll-site --config "$ROOT/wrangler.toml" >"$OUT/versions.json" 2>"$OUT/versions.err"
  ver_status=$?
  set -e
  if [[ "$dep_status" -eq 0 && "$ver_status" -eq 0 ]]; then
    set +e
    classified="$(cd "$ROOT" && node --input-type=module <<EOF
import { readFileSync } from "node:fs";
import { judgeRelease } from "./scripts/release-match.mjs";
const deployment = JSON.parse(readFileSync("$OUT/deployment.json", "utf8"));
const versions = JSON.parse(readFileSync("$OUT/versions.json", "utf8"));
const result = judgeRelease({ commit: "$SHA", version: "$VERSION", deployment, versions });
console.log(result.status);
console.log(result.reason);
console.log(result.previous ?? "");
console.log(result.active ?? "");
EOF
)"
    node_status=$?
    set -e
    if [[ "$node_status" -ne 0 ]]; then
      MATCH=FAIL
      MATCH_REASON="could not parse the wrangler json"
    else
      MATCH="$(printf '%s\n' "$classified" | sed -n '1p')"
      MATCH_REASON="$(printf '%s\n' "$classified" | sed -n '2p')"
      FOUND_PREVIOUS="$(printf '%s\n' "$classified" | sed -n '3p')"
      ACTIVE="$(printf '%s\n' "$classified" | sed -n '4p')"
    fi
  else
    MATCH_REASON="wrangler could not read the Worker (see deployment.err). Log in, then rerun."
  fi
else
  MATCH_REASON="wrangler is not installed (npm ci)"
fi

ROLLBACK_ID="${PREVIOUS:-$FOUND_PREVIOUS}"
if [[ -n "$ROLLBACK_ID" ]]; then
  ROLLBACK="npx wrangler rollback ${ROLLBACK_ID}"
else
  ROLLBACK="npx wrangler rollback"
fi

if [[ "$LIVE" == PASS && "$MATCH" == PASS ]]; then OVERALL=PASS; else OVERALL=FAIL; fi

{
  echo "# Toll release check"
  echo
  echo "- commit: \`$SHA\`"
  echo "- expected version: \`$VERSION\`"
  echo "- live version: \`${ACTIVE:-unknown}\`"
  echo "- free live checks: ${LIVE}"
  echo "- version match: ${MATCH} (${MATCH_REASON})"
  echo "- overall: ${OVERALL}"
  echo
  echo "Rollback (not run):"
  echo
  echo "\`\`\`"
  echo "$ROLLBACK"
  echo "\`\`\`"
} >"$OUT/SUMMARY.md"

echo "free live checks: ${LIVE}"
echo "version match: ${MATCH}"
echo "$MATCH_REASON"
echo "Rollback (not run): $ROLLBACK"
echo "OVERALL: ${OVERALL}"
echo "evidence: ${OUT}"
[[ "$OVERALL" == PASS ]]
