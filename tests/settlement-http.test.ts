// Phase 2 paid requests through the issuer (docs/settlement.md Q2-Q6, spec §8.5-8.6, §19.10).
// Local test backend only: no network, no real money.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createToll, MemoryStore, Metrics, normalizeConfig } from "../packages/server-node/src/index.ts";
import { FixedTestRate, MemoryLedger, StubSettler } from "../packages/settlement-ln/src/index.ts";
import { createAgent, testBackendPayer } from "../packages/agent/src/index.ts";
import { agentPay } from "../packages/agent/src/agent-pay.ts";
import { startDemo, testConfig, PAID_ON, type Running } from "./helpers.ts";

let S: Running;
const settler = new StubSettler();
const fx = new FixedTestRate(100000);
before(async () => {
  S = await startDemo({ work: { standard: { cost: 500 } }, ...PAID_ON }, { settlement: { settler, fx } });
});
after(async () => { await S.close(); });

const json = { "content-type": "application/json", accept: "application/json" };
const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
const postContact = (headers: Record<string, string>, q = "") => fetch(`${S.url}/contact${q}`, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify({ message: "hi" }) });
async function agentOffer(action = "write") {
  const j: any = await (await fetch(`${S.url}/v1/challenge?action=${action}&client=agent`)).json();
  return j.offers[0];
}
async function pay(offer: any) {
  return (await (await fetch(`${S.url}/demo/stub-pay`, { method: "POST", headers: json, body: JSON.stringify({ invoice: offer.invoice }) })).json()).preimage as string;
}
const redeem = (body: unknown) => fetch(`${S.url}/v1/redeem`, { method: "POST", headers: json, body: JSON.stringify(body) });

test("Q2: offers[] only for agent requests (query or Toll-Client header); widget requests get offers: []", async () => {
  const w: any = await (await fetch(`${S.url}/v1/challenge?action=write`)).json();
  assert.deepEqual(w.offers, []);
  assert.ok(w.challenge?.id);
  const q: any = await (await fetch(`${S.url}/v1/challenge?action=write&client=agent`)).json();
  const h: any = await (await fetch(`${S.url}/v1/challenge?action=write`, { headers: { "toll-client": "agent" } })).json();
  for (const r of [q, h]) {
    assert.equal(r.offers.length, 1);
    const o = r.offers[0];
    assert.equal(o.kind, "ln402");
    assert.equal(o.amount_msat, 10000);
    assert.deepEqual(o.display, { usd: "0.0100", label: "per request" }); // fixed test rate 100000
    assert.match(o.invoice, /^lnstub1/, "test-only invoice from the stub backend");
    assert.ok(o.exp <= Math.floor(Date.now() / 1000) + 120);
    assert.ok(r.challenge?.id, "the work option is always offered too");
  }
});

test("Q2: protected route -> 402 + WWW-Authenticate for agents; 403 toll_required with no offers for everyone else", async () => {
  for (const [headers, q] of [[{ "toll-client": "agent" }, ""], [{}, "?client=agent"]] as const) {
    const r = await postContact(headers, q);
    assert.equal(r.status, 402);
    const www = r.headers.get("www-authenticate") ?? "";
    const j: any = await r.json();
    assert.equal(j.error, "payment_required");
    assert.ok(j.challenge?.id);
    assert.equal(j.offers.length, 1);
    assert.equal(www, `L402 macaroon="${j.offers[0].macaroon}", invoice="${j.offers[0].invoice}"`);
  }
  const plain = await postContact({});
  assert.equal(plain.status, 403);
  assert.equal(plain.headers.get("www-authenticate"), null);
  const pj: any = await plain.json();
  assert.equal(pj.error, "toll_required");
  assert.ok(pj.challenge?.id);
  assert.ok(!("offers" in pj));
  // Browser without JS: unchanged HTML 403.
  const html = await fetch(`${S.url}/contact`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" }, body: "message=hi" });
  assert.equal(html.status, 403);
  assert.match(await html.text(), /This form needs JavaScript\./);
});

test("Q3: every offer amount is a whole multiple of 1,000 msat (base table per class)", async () => {
  const want: Record<string, number> = { search: 2000, write: 10000, account: 25000, admin: 100000 };
  for (const [cls, msat] of Object.entries(want)) {
    const o = await agentOffer(cls);
    assert.equal(o.amount_msat, msat, cls);
    assert.equal(o.amount_msat % 1000, 0);
  }
});

test("Q6: paying mints a settle pass with n=1 and exp = now+60; second use refused; replayed preimage 401 replay", async () => {
  const offer = await agentOffer();
  const preimage = await pay(offer);
  const r = await redeem({ offer_id: offer.id, kind: "ln402", preimage, macaroon: offer.macaroon });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("set-cookie"), null, "agents carry the pass; no cookie");
  const j: any = await r.json();
  assert.equal(j.rail, "settle");
  assert.equal(j.cls, "write");
  const claims = b64json(j.pass.split(".")[1]);
  assert.equal(claims.n, 1);
  assert.equal(claims.exp - claims.iat, 60);
  assert.equal((await postContact({ authorization: `Toll ${j.pass}` })).status, 200);
  assert.equal((await postContact({ authorization: `Toll ${j.pass}` })).status, 403, "spent pass, non-agent: 403");
  assert.equal((await postContact({ authorization: `Toll ${j.pass}`, "toll-client": "agent" })).status, 402, "spent pass, agent: a fresh offer");
  const again = await redeem({ offer_id: offer.id, kind: "ln402", preimage, macaroon: offer.macaroon });
  assert.equal(again.status, 401);
  assert.equal(((await again.json()) as any).error, "replay");
});

test("paid redeem failures: wrong preimage, substituted offer, tampered credential, malformed -> rejected, nothing booked", async () => {
  const before: any = await (await fetch(`${S.url}/demo/stats`)).json();
  const a = await agentOffer();
  const b = await agentOffer("search");
  const pa = await pay(a);
  const pb = await pay(b);
  const cases: [unknown, number, string][] = [
    [{ offer_id: a.id, kind: "ln402", preimage: pb, macaroon: a.macaroon }, 401, "bad_solution"],
    [{ offer_id: a.id, kind: "ln402", preimage: pb, macaroon: b.macaroon }, 401, "bad_sig"],
    [{ offer_id: a.id, kind: "ln402", preimage: pa, macaroon: a.macaroon.slice(0, -2) + (a.macaroon.endsWith("AA") ? "BB" : "AA") }, 401, "bad_sig"],
    [{ offer_id: a.id, kind: "ln402", preimage: "zz", macaroon: a.macaroon }, 400, "malformed"],
    [{ offer_id: a.id, kind: "other", preimage: pa, macaroon: a.macaroon }, 400, "malformed"],
  ];
  for (const [body, status, error] of cases) {
    const r = await redeem(body);
    assert.equal(r.status, status, error);
    assert.equal(((await r.json()) as any).error, error);
  }
  const after: any = await (await fetch(`${S.url}/demo/stats`)).json();
  assert.deepEqual(after.paid.ledger, before.paid.ledger);
  // The genuine payment still redeems once.
  assert.equal((await redeem({ offer_id: a.id, kind: "ln402", preimage: pa, macaroon: a.macaroon })).status, 200);
});

test("paid redeem fails closed when the replay store is down (503), and nothing is booked", async () => {
  const offer = await agentOffer();
  const preimage = await pay(offer);
  const before: any = await (await fetch(`${S.url}/demo/stats`)).json();
  S.store.setDown(true);
  try {
    assert.equal((await redeem({ offer_id: offer.id, kind: "ln402", preimage, macaroon: offer.macaroon })).status, 503);
  } finally {
    S.store.setDown(false);
  }
  const after: any = await (await fetch(`${S.url}/demo/stats`)).json();
  assert.deepEqual(after.paid.ledger, before.paid.ledger);
});

test("§19.10: the agent client pays 5 writes end to end; ledger gross/fee/net in msat, USD on the stats", async () => {
  const r = await agentPay({ base: S.url, writes: 5 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.accepted, 5);
  for (const w of r.writes) {
    assert.equal(w.status, 200);
    assert.equal(w.via, "paid");
    assert.equal(w.amount_msat, 10000);
    assert.equal(w.usd, "0.0100");
    assert.equal(w.pass_exp_in_s, 60);
  }
  assert.equal(r.replay?.rejected, true);
  assert.equal(r.pass_reuse?.rejected, true);
  assert.deepEqual(r.ledger_delta, { gross_msat: 50000, fee_held_msat: 5000, net_credited_msat: 45000, withdrawn_msat: 0, available_msat: 45000 });
  assert.match(r.usd_after!.collected!, /^\$\d+\.\d\d$/);
  const ev = S.events;
  assert.ok(ev.filter((e) => e.event === "redeem_ok" && e.rail === "settle").length >= 5);
  assert.ok(ev.some((e) => e.event === "pass_accept" && e.rail === "settle"));
  // Never logged: preimages, credentials, invoices.
  const log = S.lines.join("\n");
  assert.doesNotMatch(log, /lnstub1|preimage|macaroon/);
  assert.ok(S.demo.toll.metrics.snapshot().settled_msat >= 50000);
});

test("Q4: USD hidden when the rate is unavailable; amounts still offered in msat; health and page say so", async () => {
  fx.setDown(true);
  try {
    const o = await agentOffer();
    assert.equal(o.amount_msat, 10000);
    assert.ok(!("display" in o));
    const h: any = await (await fetch(`${S.url}/v1/health`)).json();
    assert.equal(h.usd_rate, "unavailable");
    const st: any = await (await fetch(`${S.url}/demo/stats`)).json();
    assert.equal(st.paid.collected, null);
    assert.equal(st.paid.available, null);
    assert.ok(st.paid.ledger.gross_msat > 0, "the ledger itself is unaffected");
    const page = await (await fetch(`${S.url}/`)).text();
    assert.match(page, /id="bal-amt">—</);
    assert.match(page, /id="bal-rate">Rate unavailable</);
  } finally {
    fx.setDown(false);
  }
  const h: any = await (await fetch(`${S.url}/v1/health`)).json();
  assert.deepEqual(h, { ok: true, v: "1.0.0", settlement: "stub", settlement_degraded: false, usd_rate: "ok" });
});

test("degraded backend: offers [], 403 not 402, settlement_degraded logged, writes still pass with work, no 500; recovers", async () => {
  settler.setDown(true);
  try {
    const q: any = await (await fetch(`${S.url}/v1/challenge?action=write&client=agent`)).json();
    assert.deepEqual(q.offers, []);
    const r = await postContact({ "toll-client": "agent" });
    assert.equal(r.status, 403);
    assert.ok(!("offers" in ((await r.json()) as any)));
    assert.ok(S.events.some((e) => e.event === "settlement_degraded"));
    const h: any = await (await fetch(`${S.url}/v1/health`)).json();
    assert.equal(h.settlement_degraded, true);
    const st: any = await (await fetch(`${S.url}/demo/stats`)).json();
    assert.equal(st.mode, "test payments paused");
    // The same agent falls back to the work rail.
    const agent = createAgent({ base: S.url, pay: testBackendPayer(S.url) });
    const w = await agent.fetch("/contact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "work" }) });
    assert.equal(w.via, "work");
    assert.equal(w.response.status, 200);
  } finally {
    settler.setDown(false);
  }
  assert.equal((await agentOffer()).amount_msat, 10000);
  const st: any = await (await fetch(`${S.url}/demo/stats`)).json();
  assert.equal(st.mode, "test payments on");
});

test("Q5 + Q6 at the SDK level: fee rounds down (1234 bps), settle pass expires after 60 s, offer expiry enforced", async () => {
  let t = 1_790_000_000;
  const ledger = new MemoryLedger();
  const s2 = new StubSettler();
  const config = testConfig({ settlement: { enabled: true, fee_bps: 1234, fx: { source: "fixed", usd_per_btc: 100000 } } });
  const toll = createToll(config, { now: () => t, store: new MemoryStore(() => t), metrics: new Metrics(() => {}), settlement: { settler: s2, ledger } });
  const { offers } = await toll.issueWithOffers({ action: "search", client: "agent" });
  assert.equal(offers[0].amount_msat, 2000);
  const r = await toll.redeemPaid({ offer_id: offers[0].id, kind: "ln402", preimage: s2.pay(offers[0].invoice), macaroon: offers[0].macaroon });
  assert.equal(r.fee_msat, 246); // floor(2000 * 1234 / 10000) = floor(246.8)
  assert.equal(r.net_msat, 1754);
  assert.deepEqual(toll.paid!.balance().msat, { gross_msat: 2000, fee_held_msat: 246, net_credited_msat: 1754, withdrawn_msat: 0, available_msat: 1754 });
  assert.equal(r.exp, t + 60);
  t += 59;
  await toll.verifyPass(r.pass, { action: "search", consume: false });
  t += 1;
  await assert.rejects(toll.verifyPass(r.pass, { action: "search" }), /expired/);
  // An offer redeemed after its exp is refused, even with the right preimage.
  const late = (await toll.issueWithOffers({ action: "write", client: "agent" })).offers[0];
  t = late.exp + 1;
  await assert.rejects(toll.redeemPaid({ offer_id: late.id, kind: "ln402", preimage: s2.pay(late.invoice), macaroon: late.macaroon }), /expired/);
  // Widget clients never get offers, even from the SDK.
  assert.deepEqual((await toll.issueWithOffers({ action: "write" })).offers, []);
});

test("config: settlement accepts only the local test backend and Q6-bounded passes; off by default", () => {
  assert.equal(testConfig().settlement.enabled, false);
  const base = { site_id: "s", secret: "x".repeat(32) };
  const ok = normalizeConfig({ ...base, settlement: { enabled: true } });
  assert.deepEqual(ok.settlement, { enabled: true, backend: "stub", fee_bps: 1000, pass_uses: 1, pass_ttl_s: 60, offer_ttl_s: 120, fx: { source: "none", usd_per_btc: undefined } });
  for (const bad of [{ backend: "regtest" }, { backend: "nwc" }, { pass_ttl_s: 61 }, { fee_bps: 10001 }, { fee_bps: 1.5 }, { offer_ttl_s: 121 }, { fx: { source: "fixed" } }, { fx: { source: "somewhere" } }]) {
    assert.throws(() => normalizeConfig({ ...base, settlement: { enabled: true, ...bad } }), /settlement/, JSON.stringify(bad));
  }
  // No rate configured: offers carry no USD and owner amounts are hidden.
  const toll = createToll(normalizeConfig({ ...base, settlement: { enabled: true } }), { metrics: new Metrics(() => {}) });
  assert.equal(toll.paid!.balance().usd, null);
});
