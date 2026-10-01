// Generates docs/vectors.json: challenge JSON -> solution nonces -> pass, plus rejection cases.
// Deterministic: fixed secret, ids, salts and secret counters. Test-only secret, never used anywhere real.
import { writeFileSync } from "node:fs";
import {
  type Challenge, type PassClaims, challengeSigningBytes, fromUtf8, mintChallenge, signChallenge, signPass, solveWork, subSalt, deriveDk, toHex,
} from "../packages/protocol/src/index.ts";

const SECRET = "toll-test-vector-secret-do-not-use";
const NOW = 1790000000;

const specs = [
  { name: "default-shape write (n=4, bits=32, cost=2000)", action: "write" as const, path_prefix: "/contact", cost: 2000, n: 4, bits: 32, span: 64, counter_start: 3000000000, secret_counters: [3000000005, 3000000031, 3000000049, 3000000062], id: "8f3c0000000000000000000000000001", salt: "AAECAwQFBgcICQoLDA0ODw==" },
  { name: "single sub-puzzle search (n=1, bits=16, cost=1000)", action: "search" as const, path_prefix: "/search", cost: 1000, n: 1, bits: 16, span: 300, counter_start: 0, secret_counters: [217], id: "8f3c0000000000000000000000000002", salt: "8J+YgCB0b2xsIHNhbHQgIQ==" },
  { name: "counter above 2^32 account (n=2, bits=24, cost=1500)", action: "account" as const, path_prefix: "/wp-login.php", cost: 1500, n: 2, bits: 24, span: 40, counter_start: 1099511627776, secret_counters: [1099511627790, 1099511627801], id: "8f3c0000000000000000000000000003", salt: "c2FsdHNhbHRzYWx0c2FsdA==" },
];

const work = [];
const passes = [];
let firstChallenge: Challenge | null = null;
let firstNonces: string[] = [];
for (const [k, s] of specs.entries()) {
  const { challenge } = await mintChallenge({ secret: SECRET, site: "site_abc123", action: s.action, path_prefix: s.path_prefix, cost: s.cost, n: s.n, bits: s.bits, span: s.span, ttl_s: 120, now: NOW, fixed: { id: s.id, salt: s.salt, counter_start: s.counter_start, secret_counters: s.secret_counters } });
  const sol = await solveWork(challenge);
  const dk_hex: string[] = [];
  const sub_salt_hex: string[] = [];
  for (let i = 0; i < s.n; i++) {
    const salt_i = await subSalt(challenge.salt, i);
    sub_salt_hex.push(toHex(salt_i));
    dk_hex.push(toHex(await deriveDk(sol.nonces[i], salt_i, s.cost)));
  }
  const claims: PassClaims = { v: 1, site: "site_abc123", sub: "pass_00000000000000a" + k, cls: s.action, n: 20, iat: NOW + 1, exp: NOW + 1 + 900, jti: "0000000000000000000000000000000" + k };
  const token = await signPass(SECRET, claims);
  work.push({ name: s.name, challenge, signing_input: fromUtf8(challengeSigningBytes(challenge)), secret_counters: s.secret_counters, now: NOW + 1, sub_salt_hex, solution: { nonces: sol.nonces }, dk_hex, tries: sol.tries, pass: { claims, token } });
  passes.push({ name: "pass for " + s.name, claims, token });
  if (k === 0) { firstChallenge = challenge; firstNonces = sol.nonces; }
}

const c0 = firstChallenge!;
const resign = (c: Omit<Challenge, "sig">) => signChallenge(SECRET, c);
const { sig: _s, ...u0 } = c0;
const flipNonce = (n: string) => n.slice(0, 15) + (n[15] === "0" ? "1" : "0");
const work_invalid = [
  { name: "bad signature", challenge: { ...c0, sig: "AAAA" + c0.sig.slice(4) }, nonces: firstNonces, now: NOW + 1, expect: "bad_sig" },
  { name: "field changed after signing (cost)", challenge: { ...c0, cost: 1 }, nonces: firstNonces, now: NOW + 1, expect: "bad_sig" },
  { name: "field changed after signing (bound.action)", challenge: { ...c0, bound: { ...c0.bound, action: "search" } }, nonces: firstNonces, now: NOW + 1, expect: "bad_sig" },
  { name: "unsigned challenge", challenge: u0, nonces: firstNonces, now: NOW + 1, expect: "bad_sig" },
  { name: "signed with another secret", challenge: await signChallenge("some-other-secret-value-xyz", u0), nonces: firstNonces, now: NOW + 1, expect: "bad_sig" },
  { name: "expired", challenge: c0, nonces: firstNonces, now: c0.exp + 1, expect: "expired" },
  { name: "issued in the future", challenge: c0, nonces: firstNonces, now: c0.iat - 60, expect: "not_yet_valid" },
  { name: "wrong nonce", challenge: c0, nonces: [flipNonce(firstNonces[0]), ...firstNonces.slice(1)], now: NOW + 1, expect: "bad_solution" },
  { name: "nonce outside counter range", challenge: c0, nonces: [(c0.counter_end).toString(16).padStart(16, "0"), ...firstNonces.slice(1)], now: NOW + 1, expect: "bad_solution" },
  { name: "too few nonces", challenge: c0, nonces: firstNonces.slice(0, 3), now: NOW + 1, expect: "bad_solution" },
  { name: "nonce not 16 hex chars", challenge: c0, nonces: ["a1", ...firstNonces.slice(1)], now: NOW + 1, expect: "bad_solution" },
  { name: "ttl over 120s (re-signed)", challenge: await resign({ ...u0, exp: u0.iat + 121 }), nonces: firstNonces, now: NOW + 1, expect: "malformed" },
  { name: "unsupported algo (re-signed)", challenge: await resign({ ...u0, algo: "sha256-leading" as any }), nonces: firstNonces, now: NOW + 1, expect: "unsupported" },
];

const p0 = passes[0];
const pass_invalid = [
  { name: "expired pass", token: p0.token, now: p0.claims.exp, action: "write", expect: "expired" },
  { name: "class too high for pass (write pass, account action)", token: p0.token, now: NOW + 10, action: "account", expect: "class_too_low" },
  { name: "tampered payload", token: p0.token.split(".")[0] + "." + p0.token.split(".")[1].slice(0, -2) + "AA." + p0.token.split(".")[2], now: NOW + 10, action: "write", expect: "bad_sig" },
  { name: "tampered signature", token: p0.token.slice(0, -4) + (p0.token.endsWith("AAAA") ? "BBBB" : "AAAA"), now: NOW + 10, action: "write", expect: "bad_sig" },
];
const pass_valid_checks = [
  { name: "write pass covers search", token: p0.token, now: NOW + 10, action: "search" },
  { name: "write pass covers write", token: p0.token, now: NOW + 10, action: "write" },
];

const out = {
  version: 1,
  about: "Toll protocol v1 test vectors. See docs/protocol.md. Every implementation must pass all of them. The secret is for tests only.",
  secret: SECRET,
  site: "site_abc123",
  work,
  work_invalid,
  pass: passes,
  pass_invalid,
  pass_valid_checks,
};
writeFileSync(new URL("../docs/vectors.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`vectors: ${work.length} work, ${work_invalid.length} work_invalid, ${passes.length} pass, ${pass_invalid.length} pass_invalid, ${pass_valid_checks.length} pass_valid_checks`);
