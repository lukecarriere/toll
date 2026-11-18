// The public USD rate must come only from mempool.space's prices endpoint
// (the USD field). No other public host is contacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicBtcUsdRate, PUBLIC_FX_URLS } from "../packages/settlement-ln/src/fx.ts";

const MEMPOOL_PRICES = "https://mempool.space/api/v1/prices";
const MEMPOOL_USD = 81234;

test("PublicBtcUsdRate requests only mempool.space and reads the USD field", async () => {
  const calls: string[] = [];
  const fx = new PublicBtcUsdRate(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === MEMPOOL_PRICES) {
      return new Response(JSON.stringify({ time: 1, USD: MEMPOOL_USD, EUR: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // A tempting alternate body: if a leftover primary source were still
    // tried first and its shape were still accepted, the quote would be 100000
    // instead of the mempool USD value.
    return new Response(JSON.stringify({ data: { amount: "100000" } }), { status: 200 });
  });
  const now = 1_700_000_000;
  const q = await fx.refresh(now);
  assert.deepEqual(calls, [MEMPOOL_PRICES], `public FX requests must be only ${MEMPOOL_PRICES}, got ${JSON.stringify(calls)}`);
  assert.equal(q?.usd_per_btc, MEMPOOL_USD);
  assert.equal(q?.source, MEMPOOL_PRICES);
  assert.equal(fx.quote(now)?.usd_per_btc, MEMPOOL_USD);
  assert.deepEqual([...PUBLIC_FX_URLS], [MEMPOOL_PRICES]);
});
