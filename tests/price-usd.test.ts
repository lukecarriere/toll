// GET /v1/price must give agents a finite USD figure for a normal paid write.
// Live lessspam.dev was returning usd: null because no BTC/USD rate was configured.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startDemo } from "./helpers.ts";
import { PublicBtcUsdRate, parsePublicUsdPerBtc } from "../packages/settlement-ln/src/fx.ts";

const realFetch = globalThis.fetch;
const FX_HOSTS = ["api.coinbase.com", "mempool.space"];
const RATE = 100000; // same arithmetic as the documented fixed test rate: 10,000 msat -> $0.0100

function isFiniteUsd(usd: unknown): boolean {
  if (usd == null || usd === "") return false;
  if (typeof usd === "number") return Number.isFinite(usd);
  if (typeof usd === "string") return Number.isFinite(Number(usd));
  return false;
}

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "object" && input !== null && "url" in input ? (input as Request).url : input);
    if (FX_HOSTS.some((h) => url.includes(h))) {
      if (url.includes("api.coinbase.com")) {
        return new Response(JSON.stringify({ data: { amount: String(RATE), base: "BTC", currency: "USD" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ time: 0, USD: RATE }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input as any, init);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

test("GET /v1/price returns a finite usd for a normal paid write", async () => {
  // Settlement on, no fixed test rate: the same shape as the live edge (no usd_per_btc).
  const s = await startDemo({ settlement: { enabled: true, backend: "stub", fee_bps: 1000 } });
  try {
    const res = await fetch(s.url + "/v1/price?action=write");
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text) as { action: string; amount_msat: number; usd: unknown; status: string };
    assert.equal(body.action, "write");
    assert.ok(body.amount_msat > 0);
    assert.ok(isFiniteUsd(body.usd), `usd must be a finite number for a normal price response, got ${JSON.stringify(body.usd)}`);
  } finally {
    await s.close();
  }
});

test("parsePublicUsdPerBtc reads Coinbase and mempool shapes and rejects junk", () => {
  assert.equal(parsePublicUsdPerBtc({ data: { amount: "64516.3", base: "BTC", currency: "USD" } }), 64516.3);
  assert.equal(parsePublicUsdPerBtc({ time: 1, USD: 64654 }), 64654);
  assert.equal(parsePublicUsdPerBtc({ data: { amount: "0" } }), null);
  assert.equal(parsePublicUsdPerBtc({ USD: "nope" }), null);
  assert.equal(parsePublicUsdPerBtc(null), null);
});

test("PublicBtcUsdRate falls back to the second source when the first fails", async () => {
  const calls: string[] = [];
  const fx = new PublicBtcUsdRate(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("api.coinbase.com")) return new Response("down", { status: 503 });
    return new Response(JSON.stringify({ USD: 80000 }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const now = 1_700_000_000;
  const q = await fx.refresh(now);
  assert.equal(q?.usd_per_btc, 80000);
  assert.equal(fx.quote(now)?.usd_per_btc, 80000);
  assert.ok(calls[0]?.includes("api.coinbase.com"));
  assert.ok(calls[1]?.includes("mempool.space"));
});

test("PublicBtcUsdRate does not silently keep a null quote when a source later responds, and uses the cache within 15 minutes", async () => {
  let coinbaseOk = false;
  const fx = new PublicBtcUsdRate(async (input) => {
    const url = String(input);
    if (url.includes("api.coinbase.com")) {
      if (!coinbaseOk) return new Response("down", { status: 503 });
      return new Response(JSON.stringify({ data: { amount: "90000" } }), { status: 200 });
    }
    return new Response("down", { status: 503 });
  });
  const now = 1_700_000_000;
  assert.equal(await fx.refresh(now), null);
  assert.equal(fx.quote(now), null);
  coinbaseOk = true;
  const q = await fx.refresh(now);
  assert.equal(q?.usd_per_btc, 90000);
  const again = await fx.refresh(now + 60);
  assert.equal(again?.usd_per_btc, 90000);
  assert.equal(again?.fetched_at, now, "cached quote is reused while fresh");
});
