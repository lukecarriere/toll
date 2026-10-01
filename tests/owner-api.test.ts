// Owner API for option A (docs/settlement.md §9): a WordPress site set to "Payment server" reads
// its balance and sends withdrawals to the Toll issuer. Local test backend only: no network, no money.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FixedTestRate, StubSettler } from "../packages/settlement-ln/src/index.ts";
import { startDemo, PAID_ON, type Running } from "./helpers.ts";

const KEY = "owner-test-key-0123456789abcdef";
let S: Running;
let OFF: Running;
const settler = new StubSettler();
before(async () => {
  S = await startDemo({ work: { standard: { cost: 500 } }, settlement: { ...PAID_ON.settlement, owner_key: KEY } }, { settlement: { settler, fx: new FixedTestRate(100000) } });
  OFF = await startDemo({ ...PAID_ON });
});
after(async () => { await S.close(); await OFF.close(); });

const json = { "content-type": "application/json", accept: "application/json" };
const owner = (path: string, init: RequestInit = {}, key = KEY) => fetch(`${S.url}/v1/owner/${path}`, { ...init, headers: { ...json, authorization: `Bearer ${key}`, ...(init.headers ?? {}) } });
const withdraw = (invoice: string) => owner("withdraw", { method: "POST", body: JSON.stringify({ invoice }) });

async function payOne() {
  const offer = (await (await fetch(`${S.url}/v1/challenge?action=write&client=agent`)).json() as any).offers[0];
  const { preimage } = await (await fetch(`${S.url}/demo/stub-pay`, { method: "POST", headers: json, body: JSON.stringify({ invoice: offer.invoice }) })).json() as any;
  const r = await fetch(`${S.url}/v1/redeem`, { method: "POST", headers: json, body: JSON.stringify({ offer_id: offer.id, kind: "ln402", preimage, macaroon: offer.macaroon }) });
  assert.equal(r.status, 200);
}

test("owner API is off without settlement.owner_key, and needs the key", async () => {
  assert.equal((await fetch(`${OFF.url}/v1/owner/balance`, { headers: { authorization: `Bearer ${KEY}` } })).status, 404);
  assert.equal((await fetch(`${S.url}/v1/owner/balance`)).status, 401);
  assert.equal((await owner("balance", {}, KEY + "x")).status, 401);
});

test("balance: integer msat after the fee plus the owner's USD string", async () => {
  const b0: any = await (await owner("balance")).json();
  assert.deepEqual(b0, { available_msat: 0, available_usd: "$0.00", fee_bps: 1000, paid_requests: 0, degraded: false, collecting: true });
  for (let i = 0; i < 3; i++) await payOne();
  const b: any = await (await owner("balance")).json();
  assert.equal(b.available_msat, 27000); // 3 x 10,000 gross, 10% fee held
  assert.equal(b.available_usd, "$0.02"); // fixed test rate, rounded down
  assert.equal(b.paid_requests, 3);
});

test("withdraw: checked against the balance before paying; bad invoices refused; one withdrawal row", async () => {
  const now = Math.floor(Date.now() / 1000);
  const big = await settler.mintInvoice({ amount_msat: 28000, memo: "payout", expiry_s: 600, now });
  let r = await withdraw(big.invoice);
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "too_much" });
  r = await withdraw("lnbc1notastubinvoice");
  assert.deepEqual([r.status, await r.json()], [400, { error: "bad_invoice" }]);
  const ok = await settler.mintInvoice({ amount_msat: 20000, memo: "payout", expiry_s: 600, now });
  r = await withdraw(ok.invoice);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, amount_msat: 20000, amount_usd: "$0.02" });
  const b: any = await (await owner("balance")).json();
  assert.equal(b.available_msat, 7000);
  assert.equal(b.available_usd, "less than $0.01");
  assert.equal((await withdraw(ok.invoice.replace(/.$/, "0"))).status, 400, "second withdrawal over the balance");
  assert.ok(S.events.some((e) => e.event === "owner_withdrawal" && e.amount_msat === 20000));
});

test("payment backend down: balance says degraded, withdraw is 503 and nothing is booked", async () => {
  const now = Math.floor(Date.now() / 1000);
  const inv = await settler.mintInvoice({ amount_msat: 1000, memo: "payout", expiry_s: 600, now });
  settler.setDown(true);
  try {
    const b: any = await (await owner("balance")).json();
    assert.equal(b.degraded, true);
    const r = await withdraw(inv.invoice);
    assert.equal(r.status, 503);
    assert.equal(((await (await owner("balance")).json()) as any).available_msat, 7000);
  } finally {
    settler.setDown(false);
  }
});
