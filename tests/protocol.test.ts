// §19.1 (Node half), §19.2 (solver), §19.6, plus canonical JSON and pass rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canonicalJson, checkChallenge, challengeSigningBytes, fromUtf8, verifyWork, solveWork, signPass, verifyPassToken, signChallenge,
  subSalt, deriveDk, toHex, workParams, coarseKey, uaClass, velocityMult, mintChallenge, TollError, classCovers, nonceHex, parseNonce,
} from "../packages/protocol/src/index.ts";
import { DEFAULT_WORK } from "../packages/server-node/src/index.ts";

const V = JSON.parse(readFileSync(new URL("../docs/vectors.json", import.meta.url), "utf8"));

async function redeemCode(secret: string, c: unknown, nonces: unknown, now: number): Promise<string> {
  try {
    const ch = await checkChallenge(secret, c, { now, site: V.site });
    return (await verifyWork(ch, nonces)) ? "ok" : "bad_solution";
  } catch (e) {
    return e instanceof TollError ? e.code : "error";
  }
}

test("19.1 work vectors pass on Node: canonical input, sig, sub-salts, DKs, solution, pass", async () => {
  for (const w of V.work) {
    assert.equal(fromUtf8(challengeSigningBytes(w.challenge)), w.signing_input, w.name);
    const { sig, ...unsigned } = w.challenge;
    assert.equal((await signChallenge(V.secret, unsigned)).sig, sig, w.name);
    for (let i = 0; i < w.challenge.n; i++) {
      const salt_i = await subSalt(w.challenge.salt, i);
      assert.equal(toHex(salt_i), w.sub_salt_hex[i]);
      assert.equal(toHex(await deriveDk(w.solution.nonces[i], salt_i, w.challenge.cost)), w.dk_hex[i]);
    }
    assert.equal(await redeemCode(V.secret, w.challenge, w.solution.nonces, w.now), "ok", w.name);
    assert.equal(await signPass(V.secret, w.pass.claims), w.pass.token, w.name);
  }
});

test("19.1 / 19.5 invalid work vectors are rejected with the expected code on Node", async () => {
  for (const w of V.work_invalid) assert.equal(await redeemCode(V.secret, w.challenge, w.nonces, w.now), w.expect, w.name);
});

test("pass vectors: invalid rejected, valid accepted, class rules (§8.3)", async () => {
  for (const p of V.pass_invalid) {
    await assert.rejects(verifyPassToken(V.secret, p.token, { now: p.now, site: V.site, action: p.action }), (e: any) => e.code === p.expect, p.name);
  }
  for (const p of V.pass_valid_checks) await verifyPassToken(V.secret, p.token, { now: p.now, site: V.site, action: p.action });
  assert.equal(classCovers("search", "account"), false);
  assert.equal(classCovers("admin", "write"), true);
});

test("19.2 (solver) the widget's solver finds the vector solutions", async () => {
  for (const w of V.work) {
    const r = await solveWork(w.challenge, { parallel: true });
    assert.deepEqual(r.nonces, w.solution.nonces, w.name);
  }
});

test("canonical JSON: sorted keys, no whitespace, JSON.stringify escaping, integers only", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x/y"], c: { z: "é", y: "\"" } }), '{"a":[true,null,"x/y"],"b":1,"c":{"y":"\\"","z":"é"}}');
  assert.throws(() => canonicalJson({ a: 1.5 }));
});

test("nonce encoding is 16 lowercase hex chars of a uint64", () => {
  assert.equal(nonceHex(255), "00000000000000ff");
  assert.equal(parseNonce("00000100000000ff"), 0x100000000ff);
  assert.equal(parseNonce("ABC"), null);
});

test("19.6 adaptive work cost is non-decreasing under burst (velocity on)", () => {
  let prev = 0;
  for (let count = 0; count <= 400; count += 5) {
    const p = workParams(DEFAULT_WORK, "write", { ua_class: "desktop", recent_redeems: count, velocity_enabled: true });
    assert.ok(p.expected_iterations >= prev, `count ${count}: ${p.expected_iterations} < ${prev}`);
    assert.ok(p.max_iterations <= DEFAULT_WORK.max_iterations, "cap respected");
    prev = p.expected_iterations;
  }
  assert.deepEqual([0, 19, 20, 40, 80, 160, 1000].map((c) => velocityMult(DEFAULT_WORK, c)), [1, 1, 2, 4, 8, 16, 16]);
  assert.ok(prev > workParams(DEFAULT_WORK, "write", { ua_class: "desktop", recent_redeems: 0, velocity_enabled: true }).expected_iterations);
});

test("policy: class multipliers, mobile discount, velocity off by default leaves cost flat", () => {
  const p = (a: any, ua: any = "desktop") => workParams(DEFAULT_WORK, a, { ua_class: ua, recent_redeems: 500, velocity_enabled: false });
  assert.ok(p("search").expected_iterations < p("write").expected_iterations);
  assert.ok(p("write").expected_iterations < p("account").expected_iterations);
  assert.ok(p("write", "mobile").expected_iterations < p("write").expected_iterations);
  assert.equal(p("write").mults.velocity, 1);
  assert.throws(() => p("read"));
});

test("coarse key uses /24 and /48, never the full address", () => {
  assert.equal(coarseKey("s", "203.0.113.77", "write"), "s|203.0.113.0/24|write");
  assert.equal(coarseKey("s", "::ffff:203.0.113.77", "write"), "s|203.0.113.0/24|write");
  assert.equal(coarseKey("s", "2001:db8:abcd:12::1", "write"), "s|2001:0db8:abcd::/48|write");
  assert.equal(uaClass("Mozilla/5.0 (Linux; Android 11; moto g power (2022)) Mobile Safari/537.36"), "mobile");
});

test("mint rejects TTL over 120s and read challenges", async () => {
  const base = { secret: "x".repeat(20), site: "s", action: "write" as const, path_prefix: "/", cost: 10, n: 1, bits: 8, span: 4, now: 1 };
  await assert.rejects(mintChallenge({ ...base, ttl_s: 121 }));
  await assert.rejects(mintChallenge({ ...base, ttl_s: 60, action: "read" as any }));
});
