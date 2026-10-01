// Phase 3 adaptive (spec §18, §9.2-9.5, §8.6.4): velocity raises both work cost and amount_msat,
// standard-mode challenges escalate to Argon2id under a burst or for admin, human pass 900 s / 20
// uses, settle pass single-use (n = 1, 60 s). All local: stub settler, in-memory store, fixed clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { workParams } from "../packages/protocol/src/index.ts";
import { createToll, DEFAULT_WORK, MemoryStore, Metrics, normalizeConfig } from "../packages/server-node/src/index.ts";
import { MemoryLedger, StubSettler } from "../packages/settlement-ln/src/index.ts";
import { solveWork } from "../packages/work-adapter/src/index.ts";
import { testConfig } from "./helpers.ts";

const desk = (count: number, on = true, action: any = "write", mode: "standard" | "hardened" = "standard") =>
  workParams({ ...DEFAULT_WORK, mode }, action, { ua_class: "desktop", recent_redeems: count, velocity_enabled: on });

test("policy: velocity steps raise work; standard escalates to Argon2id at x4 and for admin; adaptive off never escalates", () => {
  const rows = [0, 19, 20, 39, 40, 80, 160].map((c) => desk(c));
  assert.deepEqual(rows.map((r) => r.mults.velocity), [1, 1, 2, 2, 4, 8, 16]);
  assert.deepEqual(rows.map((r) => r.alg), ["pbkdf2-sha256", "pbkdf2-sha256", "pbkdf2-sha256", "pbkdf2-sha256", "argon2id", "argon2id", "argon2id"]);
  assert.deepEqual(rows.map((r) => r.escalated), [false, false, false, false, true, true, true]);
  assert.ok(rows[2].units > rows[0].units, "x2 doubles the work");
  assert.ok(rows[4].units >= rows[3].units);
  const esc = rows[4];
  assert.deepEqual([esc.mode, esc.cost, esc.memory_kib], ["hardened", DEFAULT_WORK.hardened.cost, DEFAULT_WORK.hardened.memory_kib]);
  // Admin with no burst: Argon2id (spec §9.3 "admin class, no pass").
  assert.equal(desk(0, true, "admin").alg, "argon2id");
  assert.equal(desk(0, true, "account").alg, "pbkdf2-sha256");
  // Adaptive off (the default): flat cost, no escalation, even for admin or a huge count.
  for (const a of ["write", "admin"]) assert.deepEqual([desk(500, false, a).alg, desk(500, false, a).mults.velocity], ["pbkdf2-sha256", 1]);
  // Hardened mode is already Argon2id; escalation only adds velocity there.
  assert.equal(desk(40, true, "write", "hardened").escalated, false);
  assert.equal(desk(40, true, "write", "hardened").alg, "argon2id");
});

test("issuer: one coarse key's paid redeems raise the next challenge's work AND the offer's amount_msat; Argon2id at x4", async () => {
  let t = 1_790_000_000;
  const settler = new StubSettler();
  const lines: any[] = [];
  const config = testConfig({ adaptive: { velocity: true }, settlement: { enabled: true, fx: { source: "fixed", usd_per_btc: 100000 } } });
  const toll = createToll(config, { now: () => t, store: new MemoryStore(() => t), metrics: new Metrics((l) => lines.push(JSON.parse(l))), settlement: { settler, ledger: new MemoryLedger() } });
  const ip = "203.0.113.7";
  const look = async () => {
    const { challenge, offers } = await toll.issueWithOffers({ action: "write", client: "agent", ip: "203.0.113.200" }); // same /24
    const ev = lines.filter((e) => e.event === "challenge_minted").pop();
    return { alg: challenge.alg, amount: offers[0].amount_msat, counter_max: ev.counter_max, velocity: ev.velocity_mult, escalated: ev.escalated };
  };
  const pay = async (n: number) => {
    for (let i = 0; i < n; i++) {
      const o = (await toll.issueWithOffers({ action: "write", client: "agent", ip })).offers[0];
      await toll.redeemPaid({ offer_id: o.id, kind: "ln402", preimage: settler.pay(o.invoice), macaroon: o.macaroon }, { ip });
    }
  };
  const seen: Record<number, Awaited<ReturnType<typeof look>>> = {};
  seen[0] = await look();
  await pay(20); seen[20] = await look();
  await pay(20); seen[40] = await look();
  await pay(40); seen[80] = await look();
  assert.deepEqual([seen[0].velocity, seen[20].velocity, seen[40].velocity, seen[80].velocity], [1, 2, 4, 8]);
  assert.deepEqual([seen[0].amount, seen[20].amount, seen[40].amount, seen[80].amount], [10000, 20000, 40000, 80000], "amount_msat = base x velocity");
  assert.ok(seen[20].counter_max > seen[0].counter_max, "work rises with the price");
  assert.deepEqual([seen[0].alg, seen[20].alg, seen[40].alg, seen[80].alg], ["pbkdf2-sha256", "pbkdf2-sha256", "argon2id", "argon2id"]);
  assert.equal(seen[40].escalated, true);
  // Another /24 is untouched (cost only, never a block; never shared across networks).
  const other = await toll.issueWithOffers({ action: "write", client: "agent", ip: "198.51.100.1" });
  assert.deepEqual([other.challenge.alg, other.offers[0].amount_msat], ["pbkdf2-sha256", 10000]);
  // The window slides: 61 s later the price and work are back to base.
  t += 61;
  const later = await look();
  assert.deepEqual([later.velocity, later.amount, later.alg], [1, 10000, "pbkdf2-sha256"]);
});

test("escalated Argon2id challenge still solves and redeems to a normal human pass (900 s, 20 uses)", async () => {
  let t = 1_790_000_000;
  const config = testConfig({ adaptive: { velocity: true }, work: { hardened: { unit_tries: 1 } } });
  const toll = createToll(config, { now: () => t, store: new MemoryStore(() => t), metrics: new Metrics(() => {}), pickCounter: () => 0 });
  const c = await toll.issueChallenge({ action: "admin", ip: "192.0.2.1" });
  assert.equal(c.alg, "argon2id");
  assert.equal((c.work as any).parameters.algorithm, "ARGON2ID"); // engine payload, opaque to Toll
  const s = await solveWork(c.work);
  const r = await toll.verifySolution(c, { work: { counter: s!.counter, derivedKey: s!.derivedKey }, took_ms: 1 }, { ip: "192.0.2.1" });
  assert.equal(r.rail, "work");
  assert.deepEqual([r.claims.exp - r.claims.iat, r.claims.n], [900, 20], "human pass: 900 s, 20 uses");
  t += 899;
  await toll.verifyPass(r.pass, { action: "admin", consume: false });
  t += 1;
  await assert.rejects(toll.verifyPass(r.pass, { action: "admin" }), /expired/);
});

test("settle pass is single-use (n = 1) and lives at most 60 s; config refuses anything else", async () => {
  let t = 1_790_000_000;
  const settler = new StubSettler();
  const config = testConfig({ settlement: { enabled: true } });
  const toll = createToll(config, { now: () => t, store: new MemoryStore(() => t), metrics: new Metrics(() => {}), settlement: { settler, ledger: new MemoryLedger() } });
  const o = (await toll.issueWithOffers({ action: "write", client: "agent" })).offers[0];
  const r = await toll.redeemPaid({ offer_id: o.id, kind: "ln402", preimage: settler.pay(o.invoice), macaroon: o.macaroon });
  assert.deepEqual([r.claims.n, r.claims.exp - r.claims.iat], [1, 60]);
  await toll.verifyPass(r.pass, { action: "write" });
  await assert.rejects(toll.verifyPass(r.pass, { action: "write" }), /exhausted/, "second use refused");
  const base = { site_id: "s", secret: "x".repeat(32) };
  for (const pass_uses of [0, 2, 20]) assert.throws(() => normalizeConfig({ ...base, settlement: { enabled: true, pass_uses } }), /single-use/);
  assert.throws(() => normalizeConfig({ ...base, settlement: { enabled: true, pass_ttl_s: 61 } }), /settlement/);
  // Human pass defaults stay 900 s / 20 uses.
  assert.deepEqual([testConfig().defaults.pass_ttl_s, testConfig().defaults.pass_uses], [900, 20]);
});
