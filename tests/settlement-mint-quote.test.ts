// Loopback mint quote beside Cashu. No public mint, no funds.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestMint } from "../packages/settlement-ln/src/index.ts";
import { fromB64url, fromUtf8 } from "../packages/protocol/src/bytes.ts";
import { startDemo, drain } from "./helpers.ts";

const mint = await startTestMint();
let clock = Math.floor(Date.now() / 1000);
let demo: Awaited<ReturnType<typeof startDemo>>;

before(async () => {
  demo = await startDemo({
    work: { standard: { cost: 500 } },
    settlement: { enabled: true, backend: "stub", fee_bps: 1000, fx: { source: "fixed", usd_per_btc: 100000 }, cashu: { enabled: true, mint: mint.url } },
  }, { now: () => clock });
});
after(async () => { await demo.close(); await mint.close(); });

function post(path: string, headers: Record<string, string> = {}) {
  return fetch(demo.url + path, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", ...headers },
    body: "{}",
  });
}

async function quoteOffer(path: string) {
  const denied = await post(path);
  const body = await denied.json();
  assert.equal(denied.status, 402);
  const www = denied.headers.get("www-authenticate") ?? "";
  const m = /^L402 macaroon="([^"]+)", invoice="([^"]+)"$/.exec(www);
  assert.ok(m, www);
  assert.ok(String(denied.headers.get("x-cashu")).startsWith("creqA"));
  assert.equal(body.offers[0].kind, "cashu");
  assert.equal(body.offers[1].kind, "l402");
  assert.equal(body.offers[1].invoice, m[2]);
  return { body, macaroon: m[1], invoice: m[2] };
}

async function pay(invoice: string): Promise<string> {
  const r = await fetch(mint.url + "/test/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: invoice }) });
  const body = await r.json();
  assert.equal(r.status, 200);
  return body.preimage as string;
}

const auth = (macaroon: string, preimage: string) => ({ authorization: `L402 ${macaroon}:${preimage}` });

test("a 402 carries both headers, a paid quote grants a pass, and a replay is refused", async () => {
  const beforeSats = mint.issuedSats();
  const { macaroon, invoice } = await quoteOffer("/contact");
  const caveats = JSON.parse(fromUtf8(fromB64url(macaroon.split(".")[0])));
  const quote = await fetch(mint.url + "/v1/mint/quote/bolt11/" + caveats.quote);
  const quoteBody = await quote.json();
  assert.equal(quote.status, 200);
  assert.equal(quoteBody.state, "UNPAID");
  assert.equal("preimage" in quoteBody || "payment_preimage" in quoteBody, false);
  const preimage = await pay(invoice);
  const paid = await post("/contact", auth(macaroon, preimage));
  const passBody = await paid.json();
  assert.equal(paid.status, 200, JSON.stringify(passBody));
  assert.equal(passBody.rail, "settle");
  assert.equal(passBody.cls, "write");
  const claims = JSON.parse(fromUtf8(fromB64url(passBody.pass.split(".")[1])));
  assert.equal(claims.n, 1);
  assert.equal(claims.exp - claims.iat, 60);
  assert.equal(mint.issuedSats(), beforeSats + 10);
  const again = await post("/contact", auth(macaroon, preimage));
  assert.equal(again.status, 401);
  assert.equal((await again.json()).error, "replay");
  assert.equal(mint.issuedSats(), beforeSats + 10);
  for (const line of demo.lines) {
    assert.equal(line.includes(preimage), false);
    assert.equal(line.includes(macaroon), false);
  }
});

test("mint-quote guard: a wrong preimage is refused", async () => {
  const { macaroon, invoice } = await quoteOffer("/contact");
  await pay(invoice);
  const wrong = await post("/contact", auth(macaroon, "0".repeat(64)));
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, "bad_solution");
  const still = await post("/contact", auth(macaroon, await pay(invoice)));
  assert.equal(still.status, 200);
  await drain(still);
});

function caveatsOf(macaroon: string): { quote: string; exp: number } {
  return JSON.parse(fromUtf8(fromB64url(macaroon.split(".")[0])));
}

async function mintForeign(quote: string) {
  const r = await fetch(mint.url + "/v1/mint/bolt11", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quote }),
  });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  return body.proofs as { amount: number; secret: string; id: string; C: string }[];
}

test("a foreign mint of the quote does not grant a pass", async () => {
  const { macaroon, invoice } = await quoteOffer("/contact");
  const quote = caveatsOf(macaroon).quote;
  await pay(invoice);
  const proofs = await mintForeign(quote);
  assert.equal(proofs.reduce((n, p) => n + p.amount, 0), 10);
  const retry = await post("/contact", auth(macaroon, await pay(invoice)));
  const body = await retry.json();
  assert.equal(retry.status, 401, JSON.stringify(body));
  assert.equal(body.error, "bad_solution");
});

test("eight concurrent retries of one paid quote yield one pass and seven replays", async () => {
  const { macaroon, invoice } = await quoteOffer("/contact");
  const preimage = await pay(invoice);
  const results = await Promise.all(Array.from({ length: 8 }, () => post("/contact", auth(macaroon, preimage))));
  const rows = [];
  for (const r of results) rows.push({ status: r.status, body: await r.json() });
  const passed = rows.filter((r) => r.status === 200);
  const replays = rows.filter((r) => r.status === 401 && r.body.error === "replay");
  const internals = rows.filter((r) => r.status === 500);
  assert.equal(passed.length, 1, JSON.stringify(rows));
  assert.equal(passed[0].body.rail, "settle");
  assert.equal(replays.length, 7, JSON.stringify(rows));
  assert.equal(internals.length, 0, JSON.stringify(rows));
});

test("spending those proofs before the retry does not grant a pass", async () => {
  const { macaroon, invoice } = await quoteOffer("/contact");
  await pay(invoice);
  const proofs = await mintForeign(caveatsOf(macaroon).quote);
  const spent = await fetch(mint.url + "/v1/swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: proofs.map((p) => ({ amount: p.amount, id: p.id, secret: p.secret, C: p.C })), outputs: [] }),
  });
  assert.equal(spent.status, 200);
  await spent.arrayBuffer();
  const retry = await post("/contact", auth(macaroon, await pay(invoice)));
  const body = await retry.json();
  assert.notEqual(retry.status, 200, JSON.stringify(body));
});

test("a new store refuses a macaroon whose quote is already minted", async () => {
  const { macaroon, invoice } = await quoteOffer("/contact");
  const preimage = await pay(invoice);
  const first = await post("/contact", auth(macaroon, preimage));
  assert.equal(first.status, 200);
  await drain(first);
  const other = await startDemo({
    work: { standard: { cost: 500 } },
    settlement: { enabled: true, backend: "stub", fee_bps: 1000, fx: { source: "fixed", usd_per_btc: 100000 }, cashu: { enabled: true, mint: mint.url } },
  }, { now: () => clock });
  try {
    const retry = await fetch(other.url + "/contact", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", authorization: `L402 ${macaroon}:${preimage}` },
      body: "{}",
    });
    const body = await retry.json();
    assert.notEqual(retry.status, 200, JSON.stringify(body));
  } finally {
    await other.close();
  }
});

test("a down mint is a 403 and the manifest does not advertise pay methods", async () => {
  mint.setDown(true);
  try {
    const res = await fetch(demo.url + "/.well-known/toll.json");
    const doc = await res.json();
    assert.equal(res.status, 200);
    assert.equal(doc.tools.length, 3);
    for (const t of doc.tools) assert.equal(t.payment.protocol, "none", t.name);
    const denied = await post("/contact");
    const body = await denied.json();
    assert.equal(denied.status, 403);
    assert.equal(body.offers, undefined);
  } finally {
    mint.setDown(false);
  }
});

test("an expired token and an action mismatch are refused", async () => {
  const stale = await quoteOffer("/contact");
  const preimage = await pay(stale.invoice);
  clock = stale.body.offers[1].exp + 1;
  const late = await post("/contact", auth(stale.macaroon, preimage));
  assert.equal(late.status, 401);
  assert.equal((await late.json()).error, "expired");
  const losses = demo.store.mintQuoteLosses?.() ?? [];
  assert.equal(losses.length, 1);
  assert.deepEqual(losses[0], { quote: caveatsOf(stale.macaroon).quote, action: "write", amount: 10 });
  assert.ok(demo.lines.some((l) => l.includes("mint_quote_loss") && l.includes(losses[0].quote) && !l.includes(preimage)));
  clock = Math.floor(Date.now() / 1000) + 10_000;
  const search = await quoteOffer("/search");
  assert.equal(search.body.offers[1].amount_msat, 2000);
  const searchPreimage = await pay(search.invoice);
  const mismatch = await post("/contact", auth(search.macaroon, searchPreimage));
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error, "wrong_action");
  const matched = await post("/search", auth(search.macaroon, searchPreimage));
  assert.equal(matched.status, 200);
  await drain(matched);
});
