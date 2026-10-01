// Generates docs/vectors.json: Toll envelope (with the work engine's payload) -> engine solution -> pass,
// plus rejection cases. The engine payloads are made and solved with the pinned engine library itself
// (docs/adapters.md), so these are vendor fixtures wrapped in Toll's envelope; Toll adds no KDF of its own.
// Engine payload nonces and salts are random per run; the file is generated once and committed.
// Test-only secret, never used anywhere real.
import { writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { type Challenge, type PassClaims, type WorkAlg, challengeSigningBytes, fromUtf8, mintChallenge, signChallenge, signPass } from "../packages/protocol/src/index.ts";
import { createWorkAdapter, solveWork } from "../packages/work-adapter/src/index.ts";

const SECRET = "toll-test-vector-secret-do-not-use";
const NOW = 1790000000;
const engine = createWorkAdapter(SECRET);
const sub = (label: string) => createHmac("sha256", SECRET).update("toll/work-adapter/v1/" + label).digest("hex");

const specs: { name: string; action: "search" | "write" | "account"; path_prefix: string; alg: WorkAlg; cost: number; memory_kib?: number; counter: number; id: string }[] = [
  { name: "standard write (PBKDF2/SHA-256, cost 5000, counter 41)", action: "write", path_prefix: "/contact", alg: "pbkdf2-sha256", cost: 5000, counter: 41, id: "8f3c0000000000000000000000000001" },
  { name: "standard search (PBKDF2/SHA-256, cost 1000, counter 0)", action: "search", path_prefix: "/search", alg: "pbkdf2-sha256", cost: 1000, counter: 0, id: "8f3c0000000000000000000000000002" },
  { name: "hardened account (Argon2id t=2 m=8192 p=1, counter 3)", action: "account", path_prefix: "/wp-login.php", alg: "argon2id", cost: 2, memory_kib: 8192, counter: 3, id: "8f3c0000000000000000000000000003" },
];

const work = [];
const passes = [];
const made: { challenge: Challenge; solution: any }[] = [];
for (const [k, s] of specs.entries()) {
  const challenge = await mintChallenge({
    secret: SECRET, site: "site_abc123", action: s.action, path_prefix: s.path_prefix, alg: s.alg, ttl_s: 120, now: NOW, fixed: { id: s.id },
    makeWork: async (tid) => (await engine.issue({ tid, spec: { alg: s.alg, cost: s.cost, memory_kib: s.memory_kib, parallelism: 1, counter_max: s.counter + 1 }, counter: s.counter })) as any,
  });
  const sol = await solveWork(challenge.work);
  if (!sol || sol.counter !== s.counter) throw new Error("vector solve mismatch for " + s.name);
  const solution = { work: { counter: sol.counter, derivedKey: sol.derivedKey } };
  const claims: PassClaims = { v: 1, site: "site_abc123", sub: "pass_00000000000000a" + k, cls: s.action, n: 20, iat: NOW + 1, exp: NOW + 1 + 900, jti: "0000000000000000000000000000000" + k };
  const token = await signPass(SECRET, claims);
  work.push({ name: s.name, challenge, signing_input: fromUtf8(challengeSigningBytes(challenge)), secret_counter: s.counter, now: NOW + 1, solution, pass: { claims, token } });
  passes.push({ name: "pass for " + s.name, claims, token });
  made.push({ challenge, solution });
}

const c0 = made[0].challenge;
const s0 = made[0].solution;
const resign = (c: Omit<Challenge, "sig">) => signChallenge(SECRET, c);
const { sig: _s, ...u0 } = c0;
const w0 = c0.work as any;
const flipHex = (h: string) => h.slice(0, -1) + (h.endsWith("0") ? "1" : "0");
// An engine payload issued for another Toll id, re-wrapped (by someone with the Toll secret) into c0's envelope.
const otherWork = await engine.issue({ tid: "8f3c00000000000000000000000000ff", spec: { alg: "pbkdf2-sha256", cost: 5000, counter_max: 1 }, counter: 0 });
const otherSol = await solveWork(otherWork);
const work_invalid = [
  { name: "bad Toll signature", challenge: { ...c0, sig: "AAAA" + c0.sig.slice(4) }, solution: s0, now: NOW + 1, expect: "bad_sig" },
  { name: "engine payload changed after signing (cost)", challenge: { ...c0, work: { ...w0, parameters: { ...w0.parameters, cost: 1 } } }, solution: s0, now: NOW + 1, expect: "bad_sig" },
  { name: "field changed after signing (bound.action)", challenge: { ...c0, bound: { ...c0.bound, action: "search" } }, solution: s0, now: NOW + 1, expect: "bad_sig" },
  { name: "unsigned challenge", challenge: u0, solution: s0, now: NOW + 1, expect: "bad_sig" },
  { name: "signed with another secret", challenge: await signChallenge("some-other-secret-value-xyz", u0), solution: s0, now: NOW + 1, expect: "bad_sig" },
  { name: "expired", challenge: c0, solution: s0, now: c0.exp + 1, expect: "expired" },
  { name: "issued in the future", challenge: c0, solution: s0, now: c0.iat - 60, expect: "not_yet_valid" },
  { name: "wrong derived key", challenge: c0, solution: { work: { ...s0.work, derivedKey: flipHex(s0.work.derivedKey) } }, now: NOW + 1, expect: "bad_solution" },
  { name: "wrong counter with a guessed key", challenge: c0, solution: { work: { counter: s0.work.counter + 1, derivedKey: "00".repeat(32) } }, now: NOW + 1, expect: "bad_solution" },
  { name: "solution for another challenge", challenge: c0, solution: { work: { counter: otherSol!.counter, derivedKey: otherSol!.derivedKey } }, now: NOW + 1, expect: "bad_solution" },
  { name: "engine payload signed by the engine but its tid points at another challenge (re-signed envelope)", challenge: await resign({ ...u0, work: otherWork as any }), solution: { work: { counter: otherSol!.counter, derivedKey: otherSol!.derivedKey } }, now: NOW + 1, expect: "bad_solution" },
  { name: "engine payload signature broken (re-signed envelope)", challenge: await resign({ ...u0, work: { ...w0, signature: flipHex(w0.signature) } }), solution: s0, now: NOW + 1, expect: "bad_solution" },
  { name: "missing solution", challenge: c0, solution: {}, now: NOW + 1, expect: "bad_solution" },
  { name: "ttl over 120s (re-signed)", challenge: await resign({ ...u0, exp: u0.iat + 121 }), solution: s0, now: NOW + 1, expect: "malformed" },
  { name: "unsupported alg (re-signed)", challenge: await resign({ ...u0, alg: "sha256-leading" as any }), solution: s0, now: NOW + 1, expect: "unsupported" },
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
  about: "Toll protocol v1 test vectors. See docs/protocol.md and docs/adapters.md. Engine payloads and solutions come from the pinned engine library. Every implementation must pass all of them. The secret is for tests only.",
  secret: SECRET,
  engine_secrets: { challenge: sub("challenge"), key: sub("key"), derivation: "HMAC-SHA256(key = Toll secret, message = 'toll/work-adapter/v1/' + label), lowercase hex" },
  site: "site_abc123",
  work,
  work_invalid,
  pass: passes,
  pass_invalid,
  pass_valid_checks,
};
writeFileSync(new URL("../docs/vectors.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`vectors: ${work.length} work, ${work_invalid.length} work_invalid, ${passes.length} pass, ${pass_invalid.length} pass_invalid, ${pass_valid_checks.length} pass_valid_checks`);
