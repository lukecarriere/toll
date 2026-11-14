#!/usr/bin/env bash
# Locate a Node binary for major version 22 or 24. Used by verify-toll.sh and
# deploy.sh so both majors are found when the first `node` on PATH is the other
# one, or when Node 24 lives at ~/.local/node24 (not only node-v24*).
#
# Usage:
#   scripts/node-path.sh <major>     # print the binary path (exit 1 if missing)
#   scripts/node-path.sh --export    # emit export NODE_22=... NODE_24=... for eval
#   scripts/node-path.sh --self-check
#   source scripts/node-path.sh      # defines find_node
#
# Nothing here prints a secret.

# find_node <major>
# Prints the path to a Node binary of that major version and returns 0, or
# returns 1 if none is found. Honors NODE_<major> when it is set and executable.
find_node() {
  local major="$1"
  local envvar="NODE_${major}"
  if [[ -n "${!envvar:-}" && -x "${!envvar}" ]]; then
    echo "${!envvar}"
    return 0
  fi

  local dir candidate version path_rest="$PATH"
  local -a dirs=()
  while [[ -n "$path_rest" ]]; do
    dir="${path_rest%%:*}"
    if [[ "$path_rest" == *:* ]]; then
      path_rest="${path_rest#*:}"
    else
      path_rest=""
    fi
    dirs+=("$dir")
  done

  # Prefer a node<major> binary, then the first `node` of that major, walking
  # every PATH entry so a later /usr/local/bin/node is not hidden by an earlier
  # copy of a different major.
  for dir in "${dirs[@]}"; do
    [[ -n "$dir" ]] || continue
    candidate="${dir}/node${major}"
    if [[ -x "$candidate" ]]; then
      version="$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
      if [[ "$version" == "$major" ]]; then
        echo "$candidate"
        return 0
      fi
    fi
  done
  for dir in "${dirs[@]}"; do
    [[ -n "$dir" ]] || continue
    candidate="${dir}/node"
    if [[ -x "$candidate" ]]; then
      version="$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
      if [[ "$version" == "$major" ]]; then
        echo "$candidate"
        return 0
      fi
    fi
  done

  local path best="" best_version="" base
  consider_versioned() {
    local bin="$1" ver="$2"
    [[ -x "$bin" ]] || return 0
    if [[ -z "$best_version" ]] || [[ "$(printf '%s\n%s\n' "$best_version" "$ver" | sort -V | tail -n 1)" == "$ver" ]]; then
      best_version="$ver"
      best="$bin"
    fi
  }

  shopt -s nullglob
  for path in \
    "${HOME}/.local/node-v${major}"*/bin/node \
    "${HOME}/.local/node/node-v${major}"*/bin/node \
    /usr/local/node-v"${major}"*/bin/node
  do
    base="$(basename "$(dirname "$(dirname "$path")")")"
    if [[ "$base" =~ node-v([0-9]+\.[0-9]+\.[0-9]+) ]]; then
      consider_versioned "$path" "v${BASH_REMATCH[1]}"
    fi
  done

  # Unversioned layouts such as ~/.local/node24/bin/node.
  for path in "${HOME}/.local/node${major}/bin/node" "/usr/local/node${major}/bin/node"; do
    if [[ -x "$path" ]]; then
      version="$("$path" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
      if [[ "$version" == "$major" ]]; then
        consider_versioned "$path" "v${major}.0.0"
      fi
    fi
  done

  # nvm keeps one directory per version. Take the highest v<major>.* that has a node binary.
  # The directory name is enough; do not run the binary (tests use stub binaries).
  local nvm_root="${NVM_DIR:-${HOME}/.nvm}"
  local match
  for dir in "${nvm_root}/versions/node/v${major}."*; do
    match="${dir}/bin/node"
    if [[ -x "$match" ]]; then
      consider_versioned "$match" "$(basename "$dir")"
    fi
  done
  shopt -u nullglob

  if [[ -n "$best" ]]; then
    echo "$best"
    return 0
  fi
  return 1
}

if [[ "${BASH_SOURCE[0]:-}" != "$0" ]]; then
  return 0
fi

set -euo pipefail

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \?//'
}

self_check() {
  local home path22 path24 later safe bin empty status out
  echo "self-check: proving Node 24 can be found off the first PATH entry and under ~/.local/node24"

  home="$(mktemp -d "${TMPDIR:-/tmp}/node-path-home.XXXXXX")"
  path22="$(mktemp -d "${TMPDIR:-/tmp}/node-path-22.XXXXXX")"
  later="$(mktemp -d "${TMPDIR:-/tmp}/node-path-later.XXXXXX")"
  path24="$(mktemp -d "${TMPDIR:-/tmp}/node-path-24.XXXXXX")"
  safe="$(mktemp -d "${TMPDIR:-/tmp}/node-path-safe.XXXXXX")"
  empty="$(mktemp -d "${TMPDIR:-/tmp}/node-path-empty.XXXXXX")"

  # Coreutils without a node binary, so a system Node 24 is not found on PATH.
  local src name base
  for src in /usr/bin /bin /usr/local/bin; do
    [[ -d "$src" ]] || continue
    for name in "$src"/*; do
      base="$(basename "$name")"
      case "$base" in node|nodejs|node[0-9]*) continue ;; esac
      [[ -e "$safe/$base" ]] && continue
      ln -s "$name" "$safe/$base" 2>/dev/null || true
    done
  done

  fake_node() {
    local dest="$1" major="$2"
    cat >"$dest" <<EOF
#!/bin/bash
if [[ "\$1" == "-p" ]]; then
  echo ${major}
  exit 0
fi
echo "fake-node-${major}"
exit 0
EOF
    chmod 755 "$dest"
  }

  fake_node "${path22}/node" 22
  fake_node "${later}/node" 24
  mkdir -p "${home}/.local/node24/bin"
  fake_node "${home}/.local/node24/bin/node" 24
  fake_node "${path24}/node" 24

  # 1. PATH has Node 22 first and Node 24 later: find 24 on PATH.
  bin="$(HOME="$home" PATH="${path22}:${later}:${safe}" NODE_22= NODE_24= NVM_DIR=/nonexistent \
    bash "$0" 24)"
  if [[ "$bin" != "${later}/node" ]]; then
    echo "self-check: expected PATH walk to ${later}/node, got ${bin:-missing}" >&2
    exit 1
  fi
  echo "self-check: PATH walk PASS"

  # 2. PATH has only Node 22; Node 24 is at ~/.local/node24.
  bin="$(HOME="$home" PATH="${path22}:${safe}" NODE_22= NODE_24= NVM_DIR=/nonexistent \
    bash "$0" 24)"
  if [[ "$bin" != "${home}/.local/node24/bin/node" ]]; then
    echo "self-check: expected ~/.local/node24, got ${bin:-missing}" >&2
    exit 1
  fi
  echo "self-check: ~/.local/node24 PASS"

  # 3. NODE_24 override wins.
  bin="$(HOME="$home" PATH="${path22}:${safe}" NODE_22= NODE_24="${path24}/node" NVM_DIR=/nonexistent \
    bash "$0" 24)"
  if [[ "$bin" != "${path24}/node" ]]; then
    echo "self-check: expected NODE_24 override, got ${bin:-missing}" >&2
    exit 1
  fi
  echo "self-check: NODE_24 override PASS"

  # 4. Missing major fails.
  set +e
  out="$(HOME="$empty" PATH="${path22}:${safe}" NODE_22= NODE_24= NVM_DIR=/nonexistent \
    bash "$0" 24 2>/dev/null)"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    echo "self-check: expected missing Node 24 to fail, got $out" >&2
    exit 1
  fi
  echo "self-check: missing major FAIL as expected"

  rm -rf "$home" "$path22" "$path24" "$later" "$safe" "$empty"
  echo "self-check: ok"
}

case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  --export)
    for major in 22 24; do
      if bin="$(find_node "$major")"; then
        printf 'export NODE_%s=%q\n' "$major" "$bin"
      fi
    done
    exit 0
    ;;
  --self-check)
    self_check
    exit 0
    ;;
  22|24)
    find_node "$1"
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac
