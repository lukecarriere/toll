#!/usr/bin/env bash
# Re-run each finding's test on a fresh worktree of its target commit.
# Exit 0 only when every test fails there by assertion, and the seed finding is present.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SPIKE="$ROOT/loupe-spike"
MANIFEST="$SPIKE/findings/manifest.json"
BUNDLE="$SPIKE/seed-c8a7a8f.bundle"
SEED_COMMIT="c8a7a8fa605fb7409005062eaf375de091edec17"
SEED_FINDING="$SPIKE/findings/forged-quote-pass.md"

cd "$ROOT"

if [[ ! -d "$ROOT/node_modules" ]]; then
  echo "node_modules is missing. Run npm ci at the repo root, then rerun this script."
  exit 1
fi
if [[ ! -f "$MANIFEST" || ! -f "$SEED_FINDING" || ! -f "$BUNDLE" ]]; then
  echo "loupe-spike findings, seed bundle, or manifest is missing."
  exit 1
fi
if ! grep -q "$SEED_COMMIT" "$SEED_FINDING"; then
  echo "seed finding does not name $SEED_COMMIT"
  exit 1
fi
if ! grep -q 'forged-quote-pass' "$MANIFEST"; then
  echo "manifest has no forged-quote-pass entry"
  exit 1
fi

if ! git cat-file -e "$SEED_COMMIT^{commit}" 2>/dev/null; then
  git fetch --no-tags "$BUNDLE" "refs/spike/seed:refs/spike/seed"
fi
if ! git cat-file -e "$SEED_COMMIT^{commit}" 2>/dev/null; then
  echo "seed commit $SEED_COMMIT is not available. The bundle needs its parent 6fc116a."
  exit 1
fi

rows=$(node --input-type=module -e '
import { readFileSync } from "node:fs";
const rows = JSON.parse(readFileSync(process.argv[1], "utf8"));
if (!Array.isArray(rows) || rows.length === 0) process.exit(2);
let seed = 0;
for (const r of rows) {
  if (!r.commit || !r.test || !r.id) process.exit(2);
  if (r.seed) seed++;
  process.stdout.write([r.commit, r.test, r.id, r.seed ? "seed" : "other"].join(" ") + "\n");
}
if (seed !== 1) process.exit(3);
' "$MANIFEST")

link_modules() {
  local wt=$1
  ln -sfn "$ROOT/node_modules" "$wt/node_modules"
  local src rel
  for src in "$ROOT"/packages/*/node_modules "$ROOT"/demo/node_modules; do
    [[ -d "$src" ]] || continue
    rel=${src#"$ROOT/"}
    if [[ -d "$wt/$(dirname "$rel")" ]]; then
      ln -sfn "$src" "$wt/$rel"
    fi
  done
}

fail=0
while read -r commit test id kind; do
  [[ -n "$commit" ]] || continue
  if [[ ! -f "$SPIKE/tests/$test" ]]; then
    echo "MISSING $id test $test"
    fail=1
    continue
  fi
  if ! git cat-file -e "$commit^{commit}" 2>/dev/null; then
    echo "MISSING $id commit $commit"
    fail=1
    continue
  fi
  wt=$(mktemp -d "${TMPDIR:-/tmp}/loupe-spike.XXXXXX")
  if ! git worktree add --detach "$wt" "$commit" >/dev/null 2>&1; then
    echo "WORKTREE $id failed"
    rm -rf "$wt"
    fail=1
    continue
  fi
  mkdir -p "$wt/loupe-spike/tests"
  cp "$SPIKE/tests/$test" "$wt/loupe-spike/tests/$test"
  link_modules "$wt"
  log=$(mktemp)
  set +e
  (cd "$wt" && node --test --test-concurrency=1 "loupe-spike/tests/$test") >"$log" 2>&1
  status=$?
  set -e
  git worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"
  if [[ "$status" -eq 0 ]]; then
    echo "BAD $id ($kind) passed on $commit"
    cat "$log"
    fail=1
    continue
  fi
  if ! grep -q 'AssertionError' "$log"; then
    echo "BAD $id ($kind) did not fail an assertion on $commit"
    cat "$log"
    fail=1
    continue
  fi
  if ! grep -E -q '^# fail [1-9]' "$log"; then
    echo "BAD $id ($kind) reported no failed test on $commit"
    cat "$log"
    fail=1
    continue
  fi
  echo "OK $id ($kind) failed on ${commit:0:12}"
  rm -f "$log"
done <<<"$rows"

if [[ "$fail" -ne 0 ]]; then
  echo "check.sh: failed"
  exit 1
fi
echo "check.sh: all findings failed on their target commits, including the seed"
exit 0
