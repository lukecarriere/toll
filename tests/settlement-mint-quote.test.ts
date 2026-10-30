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

test("an expired token and an action mismatch are refused", async () => {
  const stale = await quoteOffer("/contact");
  const preimage = await pay(stale.invoice);
  clock = stale.body.offers[1].exp + 1;
  const late = await post("/contact", auth(stale.macaroon, preimage));
  assert.equal(late.status, 401);
  assert.equal((await late.json()).error, "expired");
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
