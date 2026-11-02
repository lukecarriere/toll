#!/usr/bin/env bash
# Deploy the toll-site Worker from a clean tree at a pinned commit.
#
# Usage:
#   scripts/deploy.sh --sha <commit> [--dry-run] [--allow-branch] [--base URL] [--out dir]
#
# Refuses a missing --sha, a dirty tree, a HEAD that is not --sha, and a commit that is not
# origin/main (unless --allow-branch). Then: npm ci, build, composer install, npm test, print the
# live Worker version as the rollback target, wrangler deploy, release-check.sh (free live checks).
# --dry-run does all of it except the real deploy: it runs `wrangler deploy --dry-run` and the free
# live checks, and skips release-check (nothing new is live). Any failure exits non-zero and prints
# the rollback command. Nothing here spends or prints secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHA_ARG=""
DRY_RUN=0
ALLOW_BRANCH=0
BASE="https://lessspam.dev"
OUT=""
WORKER="toll-site"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) sed -n '2,12p' "$0"; exit 0 ;;
    --sha) SHA_ARG="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --allow-branch) ALLOW_BRANCH=1; shift ;;
    --base) BASE="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

refuse() { echo "REFUSED: $*" >&2; exit 65; }

# --- guards (begin) ---
[[ -n "$SHA_ARG" ]] || refuse "--sha <commit> is required (deploys are pinned to one commit)"
SHA="$(git -C "$ROOT" rev-parse --verify -q "${SHA_ARG}^{commit}")" || refuse "--sha $SHA_ARG is not a commit here"
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  git -C "$ROOT" status --short >&2
  refuse "the worktree is dirty; deploy from a clean checkout"
fi
HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)"
[[ "$HEAD_SHA" == "$SHA" ]] || refuse "HEAD is $HEAD_SHA, not the pinned $SHA (git checkout --detach $SHA)"
if [[ "$ALLOW_BRANCH" -eq 0 ]]; then
  MAIN_SHA="$(git -C "$ROOT" rev-parse --verify -q refs/remotes/origin/main || true)"
  [[ "$SHA" == "$MAIN_SHA" ]] || refuse "$SHA is not origin/main (${MAIN_SHA:-unknown}); fetch, or pass --allow-branch"
fi
# --- guards (end) ---
SHA="${SHA:-$(git -C "$ROOT" rev-parse HEAD)}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${OUT:-$ROOT/.verify-toll/deploy-${STAMP}}"
mkdir -p "$OUT"
ROLLBACK="npx wrangler rollback --name $WORKER"
STEP="start"
on_exit() {
  local code=$?
  if [[ "$code" -ne 0 ]]; then
    echo "FAILED at step: $STEP (exit $code). Logs: $OUT" >&2
    echo "Rollback (not run): $ROLLBACK" >&2
  fi
}
trap on_exit EXIT

run() { # run <step> <cmd...>; output goes to $OUT/<step>.log
  STEP="$1"; shift
  echo "== $STEP"
  "$@" >"$OUT/$STEP.log" 2>&1 || { tail -n 40 "$OUT/$STEP.log" >&2; return 1; }
}

cd "$ROOT"
echo "deploy $WORKER at $SHA (dry-run: $DRY_RUN)"
run install npm ci
run build npm run build
run composer bash -c "cd packages/server-php && composer install --no-interaction"
run test npm test

STEP="rollback-target"
npx wrangler deployments status --json --name "$WORKER" --config "$ROOT/wrangler.toml" >"$OUT/deployment-before.json" 2>"$OUT/deployment-before.err" || {
  echo "could not read the live Worker version (wrangler login?)" >&2; exit 1; }
PREVIOUS="$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=(d.versions||[]).slice().sort((a,b)=>b.percentage-a.percentage)[0];if(!v)process.exit(1);console.log(v.version_id)' "$OUT/deployment-before.json")" || {
  echo "no live version in deployment-before.json" >&2; exit 1; }
ROLLBACK="npx wrangler rollback $PREVIOUS --name $WORKER"
echo "rollback target (live now): $PREVIOUS"
echo "rollback command: $ROLLBACK"

if [[ "$DRY_RUN" -eq 1 ]]; then
  run deploy-dry-run npx wrangler deploy --dry-run --outdir "$OUT/bundle" --config "$ROOT/wrangler.toml"
  run live-checks bash "$ROOT/scripts/live-checks.sh" --base "$BASE" --out "$OUT/live"
  echo "release-check skipped (dry run; nothing new is live)"
  echo "DRY RUN OK: $SHA would deploy; rollback target $PREVIOUS. Evidence: $OUT"
  exit 0
fi

run deploy npx wrangler deploy --tag "${SHA:0:7}" --message "deploy $SHA" --config "$ROOT/wrangler.toml"
NEW_VERSION="$(sed -nE 's/.*Current Version ID: ([0-9a-f-]{36}).*/\1/p' "$OUT/deploy.log" | tail -n 1)"
[[ -n "$NEW_VERSION" ]] || { STEP="deploy"; echo "deployed, but no version id in deploy.log" >&2; exit 1; }
echo "deployed version: $NEW_VERSION"
run release-check bash "$ROOT/scripts/release-check.sh" --commit "$SHA" --version "$NEW_VERSION" --previous "$PREVIOUS" --base "$BASE" --out "$OUT/release"
echo "DEPLOY OK: $SHA is $NEW_VERSION. Rollback: $ROLLBACK. Evidence: $OUT"
