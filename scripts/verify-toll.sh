#!/usr/bin/env bash
# Pre-merge gate for one commit. Writes one log per step and SUMMARY.md.
# Exits 0 only when every step is PASS, KNOWN, or SKIP. Does not call a live mint,
# does not spend, and does not run scripts/live-checks.sh or scripts/l402-live-check.sh.
#
# Usage:
#   scripts/verify-toll.sh [--ref <git-ref>] [--base <sha>] [--only install,build,typecheck,lint,test,php,mutants,gitleaks,base] [--out dir] [--skip-install]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${HOME}/.local/bin:${PATH}"

REF="HEAD"
BASE=""
ONLY=""
OUT=""
SKIP_INSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      sed -n '2,7p' "$0"
      exit 0
      ;;
    --ref) REF="${2:?}"; shift 2 ;;
    --base) BASE="${2:?}"; shift 2 ;;
    --only) ONLY="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

want() {
  [[ -z "$ONLY" ]] && return 0
  [[ ",${ONLY}," == *",$1,"* ]]
}

needs_tree() {
  want install || want build || want typecheck || want lint || want test || want php || want mutants || want base
}

SHA="$(git -C "$ROOT" rev-parse --verify "${REF}^{commit}")"
SUBJECT="$(git -C "$ROOT" log -1 --format=%s "$SHA")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${OUT:-$ROOT/.verify-toll/${STAMP}-${SHA:0:12}}"
mkdir -p "$OUT"

declare -A RESULT REASON
ORDER=()
record() {
  ORDER+=("$1")
  RESULT[$1]="$2"
  REASON[$1]="${3:-}"
  printf '%s %s %s\n' "$1" "$2" "${3:-}" | tee -a "$OUT/steps.log"
}

TREE="$ROOT"
WORKTREE_PARENT=""
cleanup() {
  if [[ -n "$WORKTREE_PARENT" ]]; then
    git -C "$ROOT" worktree remove --force "$TREE" >/dev/null 2>&1 || true
    rm -rf "$WORKTREE_PARENT"
  fi
}
trap cleanup EXIT

if needs_tree; then
  head_now="$(git -C "$ROOT" rev-parse HEAD)"
  dirty="$(git -C "$ROOT" status --porcelain --untracked-files=no)"
  if [[ "$SHA" != "$head_now" || -n "$dirty" ]]; then
    WORKTREE_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/toll-verify.XXXXXX")"
    TREE="$WORKTREE_PARENT/wt"
    git -C "$ROOT" worktree add --detach "$TREE" "$SHA" >>"$OUT/worktree.log" 2>&1
  fi
fi

run_logged() {
  local log="$1"
  shift
  set +e
  "$@" >"$log" 2>&1
  local status=$?
  set -e
  return "$status"
}

find_node() {
  local major="$1"
  local envvar="NODE_${major}"
  if [[ -n "${!envvar:-}" && -x "${!envvar}" ]]; then
    echo "${!envvar}"
    return 0
  fi
  local candidate version
  for candidate in "node${major}" node; do
    if command -v "$candidate" >/dev/null 2>&1; then
      version="$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
      if [[ "$version" == "$major" ]]; then
        command -v "$candidate"
        return 0
      fi
    fi
  done
  local path
  for path in "${HOME}/.local/node-v${major}"*/bin/node /usr/local/node-v"${major}"*/bin/node; do
    if [[ -x "$path" ]]; then
      echo "$path"
      return 0
    fi
  done
  return 1
}

install_gitleaks() {
  if command -v gitleaks >/dev/null 2>&1; then
    gitleaks version
    return 0
  fi
  local ver=8.30.1
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/gitleaks.tar.gz" "https://github.com/gitleaks/gitleaks/releases/download/v${ver}/gitleaks_${ver}_linux_x64.tar.gz"
  curl -fsSL -o "$tmp/checksums.txt" "https://github.com/gitleaks/gitleaks/releases/download/v${ver}/gitleaks_${ver}_checksums.txt"
  local want
  want="$(awk '/linux_x64.tar.gz/{print $1; exit}' "$tmp/checksums.txt")"
  echo "${want}  $tmp/gitleaks.tar.gz" | sha256sum -c -
  tar -xzf "$tmp/gitleaks.tar.gz" -C "$tmp" gitleaks
  mkdir -p "${HOME}/.local/bin"
  install -m 0755 "$tmp/gitleaks" "${HOME}/.local/bin/gitleaks"
  rm -rf "$tmp"
  gitleaks version
}

if want install; then
  if [[ "$SKIP_INSTALL" -eq 1 ]]; then
    record install SKIP "skip-install"
  else
    {
      echo "node $(node -v) php $(php -v | head -n 1)"
      (cd "$TREE" && npm ci)
      (cd "$TREE/packages/server-php" && composer install --no-interaction --no-progress)
      (cd "$TREE" && npx playwright install --with-deps chromium)
    } >"$OUT/install.log" 2>&1 && record install PASS || record install FAIL "see install.log"
  fi
fi

if want build; then
  run_logged "$OUT/build.log" npm --prefix "$TREE" run build && record build PASS || record build FAIL "see build.log"
fi

if want typecheck; then
  run_logged "$OUT/typecheck.log" npm --prefix "$TREE" run typecheck && record typecheck PASS || record typecheck FAIL "see typecheck.log"
fi

if want lint; then
  {
    (cd "$TREE" && node scripts/copy-lint.mjs)
    (cd "$TREE" && node scripts/cashu-guards.ts)
    (cd "$TREE" && node scripts/hidden-attr.ts)
    (cd "$TREE" && node scripts/fetch-body-lint.mjs)
    (cd "$TREE" && node scripts/check-dist.mjs)
  } >"$OUT/lint.log" 2>&1 && record lint PASS || record lint FAIL "see lint.log"
fi

if want test; then
  test_status=PASS
  test_reason=""
  for major in 22 24; do
    log="$OUT/test-node-${major}.log"
    if ! bin="$(find_node "$major")"; then
      echo "Node ${major} is not installed. Put it on PATH as node${major} or set NODE_${major}." >"$log"
      test_status=FAIL
      test_reason="${test_reason} node${major}=missing"
      continue
    fi
    set +e
    (cd "$TREE" && "$bin" --test --test-concurrency=1 --test-reporter=tap tests/*.test.ts) >"$log" 2>&1
    status=$?
    set -e
    if [[ "$status" -eq 0 ]]; then
      test_reason="${test_reason} node${major}=PASS"
    else
      test_status=FAIL
      test_reason="${test_reason} node${major}=FAIL"
    fi
  done
  record test "$test_status" "$test_reason"
fi

if want php; then
  sodium=0
  if php -r 'exit(function_exists("sodium_crypto_pwhash") ? 0 : 1);'; then sodium=1; fi
  php_status=PASS
  php_reason="sodium=${sodium}"
  runners=(
    tests/php/run-vectors.php
    tests/php/run-settlement-vectors.php
    tests/php/run-issuer.php
    tests/php/run-net-vectors.php
    tests/php/run-gate.php
    tests/php/run-cashu-relay.php
    tests/php/run-uninstall.php
    tests/php/run-server-url.php
  )
  for runner in "${runners[@]}"; do
    name="$(basename "$runner" .php)"
    log="$OUT/php-${name}.log"
    set +e
    (cd "$TREE" && php "$runner") >"$log" 2>&1
    status=$?
    set -e
    case "$name" in
      run-vectors) kind=vectors ;;
      run-issuer) kind=issuer ;;
      *) kind=other ;;
    esac
    if [[ "$kind" == other ]]; then
      if [[ "$status" -eq 0 ]]; then step=PASS; else step=FAIL; fi
      why=""
    else
      classified="$(node "$ROOT/scripts/php-known.mjs" "$kind" --exit "$status" --sodium "$sodium" --log "$log")"
      step="$(printf '%s\n' "$classified" | head -n 1)"
      why="$(printf '%s\n' "$classified" | sed -n '2p')"
    fi
    printf '%s %s %s\n' "$name" "$step" "$why" >>"$OUT/php.log"
    php_reason="${php_reason} ${name}=${step}"
    if [[ "$step" == FAIL ]]; then php_status=FAIL
    elif [[ "$step" == KNOWN && "$php_status" == PASS ]]; then php_status=KNOWN
    fi
  done
  record php "$php_status" "$php_reason"
fi

if want mutants; then
  mutant_status=PASS
  mutant_reason=""
  shopt -s nullglob
  mutants=("$TREE"/scripts/mutate-*.mjs)
  shopt -u nullglob
  if [[ ${#mutants[@]} -eq 0 ]]; then
    record mutants FAIL "no scripts/mutate-*.mjs"
  else
    for script in "${mutants[@]}"; do
      name="$(basename "$script")"
      log="$OUT/mutant-${name}.log"
      set +e
      (cd "$TREE" && node "scripts/${name}") >"$log" 2>&1
      status=$?
      set -e
      if [[ "$status" -eq 0 ]]; then
        mutant_reason="${mutant_reason} ${name}=PASS"
      else
        mutant_status=FAIL
        mutant_reason="${mutant_reason} ${name}=FAIL"
      fi
    done
    record mutants "$mutant_status" "$mutant_reason"
  fi
fi

if want gitleaks; then
  if install_gitleaks >"$OUT/gitleaks-install.log" 2>&1; then
    # New commits only. A full-history scan still reports fixtures the allowlist
    # does not name, so a main run with no base scans the one commit under test.
    range_base=""
    if [[ -n "$BASE" ]]; then
      range_base="$(git -C "$ROOT" rev-parse --verify "${BASE}^{commit}")"
    elif [[ -n "${GITHUB_BASE_SHA:-}" && "${GITHUB_BASE_SHA}" != 0000000* ]]; then
      range_base="${GITHUB_BASE_SHA}"
    fi
    if [[ -n "$range_base" ]]; then
      range_args=(--log-opts="${range_base}..${SHA}")
    else
      range_args=(--log-opts="-n 1 ${SHA}")
    fi
    set +e
    gitleaks detect --source "$ROOT" --config "$ROOT/.gitleaks.toml" --redact --no-banner \
      --report-format json --report-path "$OUT/gitleaks.json" "${range_args[@]}" >"$OUT/gitleaks.log" 2>&1
    status=$?
    set -e
    if [[ "$status" -eq 0 ]]; then
      record gitleaks PASS "${range_args[*]:-full history}"
    else
      record gitleaks FAIL "see gitleaks.log"
    fi
  else
    record gitleaks FAIL "gitleaks install failed"
  fi
fi

if want base; then
  if [[ -z "$BASE" ]]; then
    record base SKIP "pass --base <sha> to prove new tests fail on the base commit"
  else
    node22="$(find_node 22 || true)"
    set +e
    classified="$(node "$ROOT/scripts/base-proof.mjs" --root "$ROOT" --base "$BASE" --head "$SHA" --head-tree "$TREE" --out "$OUT/base" ${node22:+--node "$node22"} --php php)"
    status=$?
    set -e
    printf '%s\n' "$classified" >"$OUT/base.log"
    step="$(printf '%s\n' "$classified" | head -n 1)"
    why="$(printf '%s\n' "$classified" | sed -n '2p')"
    if [[ "$status" -ne 0 && "$step" != FAIL ]]; then step=FAIL; why="base proof exited ${status}"; fi
    record base "${step:-FAIL}" "$why"
  fi
fi

if [[ ${#ORDER[@]} -eq 0 ]]; then
  echo "no steps ran; --only takes install,build,typecheck,lint,test,php,mutants,gitleaks,base" >&2
  exit 64
fi

OVERALL=PASS
{
  echo "# Toll verify"
  echo
  echo "- sha: \`$SHA\`"
  echo "- subject: ${SUBJECT}"
  echo "- tree: \`$TREE\`"
  echo "- overall: PLACEHOLDER"
  echo
  echo "| Step | Result | Detail |"
  echo "| --- | --- | --- |"
} >"$OUT/SUMMARY.md"
for step in "${ORDER[@]}"; do
  if [[ "${RESULT[$step]}" == FAIL ]]; then OVERALL=FAIL; fi
  printf '| %s | %s | %s |\n' "$step" "${RESULT[$step]}" "${REASON[$step]//|/\\|}" >>"$OUT/SUMMARY.md"
done
# A step that was not selected is absent. KNOWN and SKIP do not fail the run.
sed -i "s/overall: PLACEHOLDER/overall: ${OVERALL}/" "$OUT/SUMMARY.md"
echo >>"$OUT/SUMMARY.md"
echo "Logs are in \`$OUT\`." >>"$OUT/SUMMARY.md"
echo "OVERALL: ${OVERALL}"
echo "evidence: ${OUT}"
echo "sha: ${SHA}"
[[ "$OVERALL" == PASS ]]
