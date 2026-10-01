// Settlement draft (spec §22 item 4): stub settler, paid-redeem check and ledger. Not wired into
// the issuer in phase 1 (offers stay []). §19.9/§19.10 proper are phase 2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { StubSettler, mintOffer, verifyPaidRedeem, MemoryLedger, splitFee, usdDisplay, priceMsat } from "../packages/settlement-ln/src/index.ts";

const SECRET = "settlement-test-secret-000000000000";
const now = 1790000000;

function guard() {
  const seen = new Set<string>();
  return async (k: string) => (seen.has(k) ? false : (seen.add(k), true));
}

test("stub: invoice + preimage verifies; wrong preimage rejected; replayed preimage rejected", async () => {
  const settler = new StubSettler();
  const offer = await mintOffer({ secret: SECRET, site: "site_test", cls: "write", amount_msat: priceMsat("write"), settler, now });
  assert.equal(offer.kind, "ln402");
  assert.equal(offer.amount_msat, 10000);
  assert.ok(offer.exp - now <= 120);
  const firstUse = guard();
  const preimage = settler.pay(offer.invoice);
  const ok = await verifyPaidRedeem({ secret: SECRET, site: "site_test", offer_id: offer.id, preimage, macaroon: offer.macaroon, now: now + 1, firstUse });
  assert.equal(ok.cls, "write");
  assert.equal(ok.amount_msat, 10000);
  await assert.rejects(verifyPaidRedeem({ secret: SECRET, site: "site_test", offer_id: offer.id, preimage, macaroon: offer.macaroon, now: now + 2, firstUse }), (e: any) => e.code === "replay");
  const other = await mintOffer({ secret: SECRET, site: "site_test", cls: "write", amount_msat: 10000, settler, now });
  await assert.rejects(verifyPaidRedeem({ secret: SECRET, site: "site_test", offer_id: other.id, preimage: "11".repeat(32), macaroon: other.macaroon, now: now + 1, firstUse }), (e: any) => e.code === "bad_solution");
});

test("stub: invoice substitution and expiry are rejected", async () => {
  const settler = new StubSettler();
  const a = await mintOffer({ secret: SECRET, site: "site_test", cls: "search", amount_msat: 2000, settler, now });
  const b = await mintOffer({ secret: SECRET, site: "site_test", cls: "admin", amount_msat: 100000, settler, now });
  // Pay the cheap invoice, present it against the expensive offer's id.
  await assert.rejects(verifyPaidRedeem({ secret: SECRET, site: "site_test", offer_id: b.id, preimage: settler.pay(a.invoice), macaroon: a.macaroon, now: now + 1, firstUse: guard() }), (e: any) => e.code === "bad_sig");
  await assert.rejects(verifyPaidRedeem({ secret: SECRET, site: "site_test", offer_id: a.id, preimage: settler.pay(a.invoice), macaroon: a.macaroon, now: a.exp + 1, firstUse: guard() }), (e: any) => e.code === "expired");
  await assert.rejects(verifyPaidRedeem({ secret: "another-secret-entirely-000000000", site: "site_test", offer_id: a.id, preimage: settler.pay(a.invoice), macaroon: a.macaroon, now: now + 1, firstUse: guard() }), (e: any) => e.code === "bad_sig");
});

test("stub: shared test preimage mode and outage", async () => {
  const shared = "ab".repeat(32);
  const settler = new StubSettler({ sharedPreimage: shared });
  const o = await mintOffer({ secret: SECRET, site: "s", cls: "write", amount_msat: 10000, settler, now });
  await verifyPaidRedeem({ secret: SECRET, site: "s", offer_id: o.id, preimage: shared, macaroon: o.macaroon, now, firstUse: guard() });
  settler.setDown(true);
  assert.equal(await settler.healthy(), false);
  await assert.rejects(mintOffer({ secret: SECRET, site: "s", cls: "write", amount_msat: 10000, settler, now }));
});

test("ledger records gross, fee and net per payment in integer msat; fee is held, not moved", () => {
  assert.deepEqual(splitFee(10000, 1000), { fee_msat: 1000, net_msat: 9000 });
  assert.deepEqual(splitFee(15, 1000), { fee_msat: 1, net_msat: 14 }, "fee rounds down");
  const L = new MemoryLedger();
  for (let i = 0; i < 20; i++) L.credit({ site: "s", ref: "off_" + i, gross_msat: 10000, fee_bps: 1000, at: now });
  assert.throws(() => L.credit({ site: "s", ref: "off_0", gross_msat: 10000, fee_bps: 1000, at: now }), /duplicate/);
  const e = L.list("s")[0];
  assert.deepEqual([e.gross_msat, e.fee_msat, e.net_msat, e.fee_bps], [10000, 1000, 9000, 1000]);
  assert.deepEqual(L.balance("s"), { gross_msat: 200000, fee_held_msat: 20000, net_credited_msat: 180000, withdrawn_msat: 0, available_msat: 180000 });
  assert.throws(() => L.withdraw({ site: "s", ref: "w1", amount_msat: 180001, at: now }));
  L.withdraw({ site: "s", ref: "w1", amount_msat: 80000, at: now });
  assert.equal(L.balance("s").available_msat, 100000);
});

test("USD display follows docs/copy.md money rules and hides when FX is stale", () => {
  const fx = { usd_per_btc: 100000, fetched_at: now }; // illustrative rate for the unit test only
  assert.equal(usdDisplay(180000, fx, now), "$0.18");
  assert.equal(usdDisplay(1_000_000_000, fx, now), "$1000.00");
  assert.equal(usdDisplay(100, fx, now), "less than $0.01");
  assert.equal(usdDisplay(0, fx, now), "$0.00");
  assert.equal(usdDisplay(1000, fx, now + 16 * 60), null);
  assert.equal(usdDisplay(1000, null, now), null);
});
