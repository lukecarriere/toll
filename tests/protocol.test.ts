// §19.1 (Node half), §19.6, plus canonical JSON, engine adapter and pass rules.
// Work vectors are engine fixtures (made and solved by the pinned engine library) inside Toll's envelope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import {
  canonicalJson, checkChallenge, challengeSigningBytes, fromUtf8, signPass, verifyPassToken, signChallenge,
  workParams, coarseKey, uaClass, velocityMult, mintChallenge, TollError, classCovers,
} from "../packages/protocol/src/index.ts";
import { createWorkAdapter, solveWork } from "../packages/work-adapter/src/index.ts";
import { DEFAULT_WORK } from "../packages/server-node/src/index.ts";

const V = JSON.parse(readFileSync(new URL("../docs/vectors.json", import.meta.url), "utf8"));
const engine = createWorkAdapter(V.secret);

/** The redeem order every implementation follows: envelope checks, then the engine verify. */
async function redeemCode(secret: string, c: unknown, solution: any, now: number): Promise<string> {
  try {
    const ch = await checkChallenge(secret, c, { now, site: V.site });
    const v = await createWorkAdapter(secret).verify(ch.work, solution?.work, { tid: ch.id });
    return v.ok ? "ok" : v.code === "expired" || v.code === "malformed" ? v.code : "bad_solution";
  } catch (e) {
    return e instanceof TollError ? e.code : "error";
  }
}

test("19.1 work vectors pass on Node: canonical input, Toll sig, engine verify, pass", async () => {
  for (const w of V.work) {
    assert.equal(fromUtf8(challengeSigningBytes(w.challenge)), w.signing_input, w.name);
    const { sig, ...unsigned } = w.challenge;
    assert.equal((await signChallenge(V.secret, unsigned)).sig, sig, w.name);
    assert.equal(w.challenge.work.parameters.data.tid, w.challenge.id, "engine payload is bound to the Toll id");
    assert.equal(await redeemCode(V.secret, w.challenge, w.solution, w.now), "ok", w.name);
    assert.equal(await signPass(V.secret, w.pass.claims), w.pass.token, w.name);
  }
});

test("engine secrets are derived from the Toll secret as documented", () => {
  const sub = (l: string) => createHmac("sha256", V.secret).update("toll/work-adapter/v1/" + l).digest("hex");
  assert.deepEqual([V.engine_secrets.challenge, V.engine_secrets.key], [sub("challenge"), sub("key")]);
});

test("19.1 / 19.5 invalid work vectors are rejected with the expected code on Node", async () => {
  for (const w of V.work_invalid) assert.equal(await redeemCode(V.secret, w.challenge, w.solution, w.now), w.expect, w.name);
});

test("engine solver (Node) finds the vector counters", async () => {
  for (const w of V.work) {
    const r = await solveWork(w.challenge.work);
    assert.equal(r?.counter, w.secret_counter, w.name);
    assert.equal(r?.derivedKey, w.solution.work.derivedKey, w.name);
  }
});

test("work adapter: issue binds the Toll id; a fresh solve verifies once per payload; bad shapes are rejected", async () => {
  const p = await engine.issue({ tid: "t1", spec: { alg: "pbkdf2-sha256", cost: 500, counter_max: 20 } });
  const s = (await solveWork(p))!;
  assert.equal((await engine.verify(p, s, { tid: "t1" })).ok, true);
  assert.equal((await engine.verify(p, s, { tid: "t2" })).ok, false, "tid binding");
  assert.equal((await engine.verify(p, { counter: -1, derivedKey: s.derivedKey }, { tid: "t1" })).code, "bad_solution");
  assert.equal((await engine.verify(p, { counter: s.counter, derivedKey: "zz" }, { tid: "t1" })).code, "bad_solution");
  assert.equal((await engine.verify({ parameters: { algorithm: "SHA-1" } }, s, { tid: "t1" })).code, "malformed");
  assert.equal((await createWorkAdapter("another-secret-0123456789").verify(p, s, { tid: "t1" })).ok, false, "other issuer");
  await assert.rejects(engine.issue({ tid: "t", spec: { alg: "pbkdf2-sha256", cost: 500, counter_max: 0 } }));
});

test("pass vectors: invalid rejected, valid accepted, class rules (§8.3)", async () => {
  for (const p of V.pass_invalid) {
    await assert.rejects(verifyPassToken(V.secret, p.token, { now: p.now, site: V.site, action: p.action }), (e: any) => e.code === p.expect, p.name);
  }
  for (const p of V.pass_valid_checks) await verifyPassToken(V.secret, p.token, { now: p.now, site: V.site, action: p.action });
  assert.equal(classCovers("search", "account"), false);
  assert.equal(classCovers("admin", "write"), true);
});

test("canonical JSON: sorted keys, no whitespace, JSON.stringify escaping, integers only", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x/y"], c: { z: "é", y: "\"" } }), '{"a":[true,null,"x/y"],"b":1,"c":{"y":"\\"","z":"é"}}');
  assert.throws(() => canonicalJson({ a: 1.5 }));
});

test("19.6 adaptive work cost is non-decreasing under burst (velocity on), in both modes; escalation never lowers it", () => {
  for (const mode of ["standard", "hardened"] as const) {
    const pol = { ...DEFAULT_WORK, mode };
    let prev = 0;
    let prevAlg = "";
    for (let count = 0; count <= 400; count += 5) {
      const p = workParams(pol, "write", { ua_class: "desktop", recent_redeems: count, velocity_enabled: true });
      // Units are comparable across engines; an escalation also makes each try far heavier (Argon2id).
      assert.ok(p.units >= prev, `${mode} count ${count}: ${p.units} units < ${prev}`);
      if (prevAlg === "argon2id") assert.equal(p.alg, "argon2id", "never de-escalates as the burst grows");
      const eng = p.alg === "argon2id" ? pol.hardened : pol.standard;
      assert.ok(p.counter_max <= pol.max_units * eng.unit_tries, "cap respected");
      prev = p.units;
      prevAlg = p.alg;
    }
    assert.ok(prev > workParams(pol, "write", { ua_class: "desktop", recent_redeems: 0, velocity_enabled: true }).units);
  }
  assert.deepEqual([0, 19, 20, 40, 80, 160, 1000].map((c) => velocityMult(DEFAULT_WORK, c)), [1, 1, 2, 4, 8, 16, 16]);
});

test("policy: class multipliers, mobile discount, mode picks the engine algorithm, velocity off leaves cost flat", () => {
  const p = (a: any, ua: any = "desktop", mode: "standard" | "hardened" = "standard") => workParams({ ...DEFAULT_WORK, mode }, a, { ua_class: ua, recent_redeems: 500, velocity_enabled: false });
  assert.ok(p("search").expected_tries < p("write").expected_tries);
  assert.ok(p("write").expected_tries < p("account").expected_tries);
  assert.ok(p("write", "mobile").expected_tries < p("write").expected_tries);
  assert.equal(p("write").mults.velocity, 1);
  assert.equal(p("write").alg, "pbkdf2-sha256");
  assert.equal(p("write", "desktop", "hardened").alg, "argon2id");
  assert.equal(p("write", "desktop", "hardened").memory_kib, 19456);
  assert.throws(() => p("read"));
});

test("coarse key uses /24 and /48, never the full address", () => {
  assert.equal(coarseKey("s", "203.0.113.77", "write"), "s|203.0.113.0/24|write");
  assert.equal(coarseKey("s", "::ffff:203.0.113.77", "write"), "s|203.0.113.0/24|write");
  assert.equal(coarseKey("s", "2001:db8:abcd:12::1", "write"), "s|2001:0db8:abcd::/48|write");
  assert.equal(uaClass("Mozilla/5.0 (Linux; Android 11; moto g power (2022)) Mobile Safari/537.36"), "mobile");
});

test("mint rejects TTL over 120s, read challenges and unknown algorithms", async () => {
  const base = { secret: "x".repeat(20), site: "s", action: "write" as const, path_prefix: "/", alg: "pbkdf2-sha256" as const, now: 1, makeWork: async () => ({}) };
  await assert.rejects(mintChallenge({ ...base, ttl_s: 121 }));
  await assert.rejects(mintChallenge({ ...base, ttl_s: 60, action: "read" as any }));
  await assert.rejects(mintChallenge({ ...base, ttl_s: 60, alg: "sha1" as any }));
});
