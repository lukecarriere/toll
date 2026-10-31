#!/bin/sh
# One quote payment against an issuer that already has L402_ENABLED=1.
# Usage: scripts/l402-live-check.sh <sat-cap>
#   sat-cap is an integer from 1 to 10. An offer above the cap is not paid.
# Env (neither is printed):
#   L402_BASE    issuer origin, no trailing path
#   L402_WALLET  command that reads one invoice on stdin and writes a 64-hex preimage on stdout
#   L402_PATH    gated path (default /demo/contact)
# Each run pays once. A crash after the wallet runs may already have paid; run it again only on purpose.
set -eu
umask 077

cap="${1:-}"
case "$cap" in
  ''|*[!0-9]*) echo "usage: scripts/l402-live-check.sh <sat-cap>" >&2; exit 2 ;;
esac
if [ "$cap" -lt 1 ] || [ "$cap" -gt 10 ]; then
  echo "sat-cap must be an integer from 1 to 10" >&2
  exit 2
fi
if [ -z "${L402_BASE:-}" ] || [ -z "${L402_WALLET:-}" ]; then
  echo "L402_BASE and L402_WALLET are required" >&2
  exit 2
fi

base=$(printf '%s' "$L402_BASE" | tr -d '\n')
path="${L402_PATH:-/demo/contact}"
case "$path" in
  /*) ;;
  *) echo "L402_PATH must start with /" >&2; exit 2 ;;
esac

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT INT TERM

code=$(curl -sS -o "$dir/body" -D "$dir/hdr" -w '%{http_code}' -X POST \
  -H 'accept: application/json' -H 'content-type: application/json' -H 'toll-client: agent' \
  --data '{}' "$base$path" || true)
if [ "$code" != "402" ]; then
  echo "offer status $code" >&2
  exit 1
fi

# Writes invoice and macaroon into the private dir. Prints only the sat amount.
sats=$(node --input-type=module << EOF
import { readFileSync, writeFileSync } from "node:fs";
const hdr = readFileSync("$dir/hdr", "utf8");
const body = JSON.parse(readFileSync("$dir/body", "utf8"));
const www = (hdr.match(/^www-authenticate:\\s*(.*)\$/im) || [])[1] || "";
const m = /^L402 macaroon="([^"]+)", invoice="([^"]+)"/.exec(www.trim());
const offer = Array.isArray(body.offers) ? body.offers.find((o) => o && o.kind === "l402") : null;
if (!m || !offer || !Number.isSafeInteger(offer.amount_msat) || offer.amount_msat % 1000 !== 0) {
  console.error("quote offer is off");
  process.exit(1);
}
if (offer.invoice !== m[2]) {
  console.error("quote offer mismatch");
  process.exit(1);
}
const sats = offer.amount_msat / 1000;
writeFileSync("$dir/invoice", m[2], { mode: 0o600 });
writeFileSync("$dir/macaroon", m[1], { mode: 0o600 });
process.stdout.write(String(sats));
EOF
)
if [ "$sats" -gt "$cap" ]; then
  echo "offer is $sats sat, cap is $cap" >&2
  exit 3
fi

if ! preimage=$(sh -c "$L402_WALLET" < "$dir/invoice" 2>"$dir/wallet.err"); then
  echo "wallet failed" >&2
  exit 1
fi
preimage=$(printf '%s' "$preimage" | tr -d '[:space:]')
printf '%s' "$preimage" | grep -Eq '^[0-9a-f]{64}$' || { echo "wallet did not return a preimage" >&2; exit 1; }

mac=$(cat "$dir/macaroon")
printf 'header = "Authorization: L402 %s:%s"\n' "$mac" "$preimage" > "$dir/curl.cfg"
paid=$(curl -sS -o "$dir/paid" -w '%{http_code}' -K "$dir/curl.cfg" -X POST \
  -H 'accept: application/json' -H 'content-type: application/json' -H 'toll-client: agent' \
  --data '{}' "$base$path" || true)
rm -rf "$dir"
trap - EXIT INT TERM
if [ "$paid" != "200" ]; then
  echo "retry status $paid" >&2
  exit 1
fi
echo "ok $sats"
