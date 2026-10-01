// §19.9 settlement vectors on Node (docs/settlement-vectors.json). PHP runs the applicable subset in
// tests/php/run-settlement-vectors.php (price, fee, USD, preimage check, settle pass).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TollError, signPass, verifyPassToken } from "../packages/protocol/src/index.ts";
import { StubSettler, mintOffer, verifyPaidRedeem, offerAmountMsat, priceMsat, splitFee, usdDisplay, offerUsd, stubEngineSecret, feePercent, fillFee } from "../packages/settlement-ln/src/index.ts";

const V = JSON.parse(readFileSync(new URL("../docs/settlement-vectors.json", import.meta.url), "utf8"));

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return "ok"; } catch (e) { return e instanceof TollError ? e.code : "error:" + (e as Error).message; }
}

test("settlement vectors: engine secret derivation", async () => {
  assert.equal(await stubEngineSecret(V.secret), V.engine_secret);
});

test("settlement vectors: Q3 prices round up to whole 1,000 msat", () => {
  assert.ok(V.price_cases.length >= 8);
  for (const c of V.price_cases) {
    assert.equal(priceMsat(c.cls, c.velocity_mult, c.suspicion_mult), c.price_msat, JSON.stringify(c));
    assert.equal(offerAmountMsat(c.cls, c.velocity_mult, c.suspicion_mult), c.amount_msat, JSON.stringify(c));
    assert.equal(c.amount_msat % 1000, 0);
    assert.ok(c.amount_msat >= c.price_msat);
  }
});

test("settlement vectors: Q5 fee rounds down", () => {
  for (const c of V.fee_cases) assert.deepEqual(splitFee(c.gross_msat, c.fee_bps), { fee_msat: c.fee_msat, net_msat: c.net_msat }, JSON.stringify(c));
});

test("{fee} placeholder: fee_bps / 100 with trailing zeros dropped (docs/copy.md Money): 1000 -> 10, 750 -> 7.5, 25 -> 0.25", () => {
  assert.equal(feePercent(1000), "10");
  assert.equal(feePercent(750), "7.5");
  assert.equal(feePercent(25), "0.25");
  for (const c of V.fee_display_cases) assert.equal(feePercent(c.fee_bps), c.fee, JSON.stringify(c));
  assert.equal(fillFee("after the {fee}% platform fee", 750), "after the 7.5% platform fee");
  assert.throws(() => feePercent(10001));
  assert.throws(() => feePercent(1.5));
});

test("settlement vectors: Q4 USD strings, hidden when the rate is stale or missing", () => {
  assert.ok(V.usd_cases.some((c: any) => c.owner === null) && V.usd_cases.some((c: any) => c.owner === "less than $0.01"));
  for (const c of V.usd_cases) {
    const fx = c.usd_per_btc === null ? null : { usd_per_btc: c.usd_per_btc, fetched_at: c.fetched_at, source: "test" };
    assert.equal(usdDisplay(c.msat, fx, c.now), c.owner, JSON.stringify(c));
    assert.equal(offerUsd(c.msat, fx, c.now) ?? null, c.offer, JSON.stringify(c));
  }
});

test("settlement vectors: offers reproduce; paid redeem verifies; settle pass n=1, 60 s, token reproduces", async () => {
  const settler = new StubSettler({ sharedPreimage: V.paid[0].preimage, deterministic: true });
  for (const p of V.paid) {
    const o = p.offer;
    const again = await mintOffer({ secret: V.engine_secret, site: V.site, cls: p.expect.cls, amount_msat: o.amount_msat, settler, now: o.exp - 120, ttl_s: 120, fixed: { id: o.id } });
    assert.deepEqual(again, o, p.name);
    const r = await verifyPaidRedeem({ secret: V.engine_secret, site: V.site, offer_id: o.id, preimage: p.preimage, macaroon: o.macaroon, now: p.now, firstUse: async () => true });
    assert.deepEqual({ cls: r.cls, amount_msat: r.amount_msat }, p.expect);
    assert.equal(r.payment_hash, p.payment_hash);
    assert.deepEqual(splitFee(r.amount_msat, p.ledger.fee_bps), { fee_msat: p.ledger.fee_msat, net_msat: p.ledger.net_msat });
    const c = p.settle_pass.claims;
    assert.equal(c.n, 1);
    assert.equal(c.exp - c.iat, 60);
    assert.equal(await signPass(V.secret, c), p.settle_pass.token);
    await verifyPassToken(V.secret, p.settle_pass.token, { now: p.settle_pass.valid_at, site: V.site, action: c.cls });
    assert.equal(await code(verifyPassToken(V.secret, p.settle_pass.token, { now: p.settle_pass.expired_at, site: V.site })), "expired");
  }
});

test("settlement vectors: rejection cases and replay", async () => {
  for (const c of V.paid_invalid) {
    assert.equal(await code(verifyPaidRedeem({ secret: V.engine_secret, site: V.site, offer_id: c.offer_id, preimage: c.preimage, macaroon: c.macaroon, now: c.now, firstUse: async () => true })), c.expect, c.name);
  }
  const used = new Set<string>();
  const firstUse = async (k: string) => (used.has(k) ? false : (used.add(k), true));
  const r = V.paid_replay;
  const got = [];
  for (let i = 0; i < 2; i++) got.push(await code(verifyPaidRedeem({ secret: V.engine_secret, site: V.site, offer_id: r.offer_id, preimage: r.preimage, macaroon: r.macaroon, now: r.now, firstUse })));
  assert.deepEqual(got, r.expect);
});
