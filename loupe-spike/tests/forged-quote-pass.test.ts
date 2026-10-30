// Expected to FAIL on c8a7a8fa605fb7409005062eaf375de091edec17.
// Not part of the root test run. Proves a pass is minted after another caller has already
// minted the quote and spent the proofs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToll } from "../../packages/server-node/src/toll.ts";
import { normalizeConfig } from "../../packages/server-node/src/config.ts";
import { MemoryStore } from "../../packages/server-node/src/stores.ts";
import { startTestMint } from "../../packages/settlement-ln/src/test-mint.ts";
import { fromB64url, fromUtf8 } from "../../packages/protocol/src/bytes.ts";

async function readJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const r = await fetch(url, init);
  const text = await r.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  return { status: r.status, body };
}

test("a quote minted by another wallet does not mint a pass", async () => {
  const mint = await startTestMint();
  const now = 1_790_000_000;
  try {
    const config = normalizeConfig({
      site_id: "s",
      secret: "x".repeat(32),
      settlement: { enabled: true, backend: "stub", cashu: { enabled: true, mint: mint.url } },
    });
    const toll = createToll(config, { now: () => now, store: new MemoryStore(() => now) });
    const offers = await toll.offersFor({ action: "write", path: "/contact", client: "agent" });
    const quote = offers.find((o) => o.kind === "ln402");
    assert.ok(quote, "the 402 includes a quote offer");
    const paid = await readJson(mint.url + "/test/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: quote.invoice }),
    });
    assert.equal(paid.status, 200);
    const preimage = String(paid.body.preimage ?? "");
    assert.match(preimage, /^[0-9a-f]{64}$/);
    const caveats = JSON.parse(fromUtf8(fromB64url(quote.macaroon.split(".")[0])));
    const minted = await readJson(mint.url + "/v1/mint/bolt11", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quote: caveats.quote }),
    });
    assert.equal(minted.status, 200, "the other wallet minted the quote");
    assert.ok(Array.isArray(minted.body.proofs) && minted.body.proofs.length > 0);
    const spent = await readJson(mint.url + "/v1/swap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs: minted.body.proofs, outputs: [] }),
    });
    assert.equal(spent.status, 200, "the other wallet spent the proofs");
    await assert.rejects(
      toll.redeemQuoted({ macaroon: quote.macaroon, preimage, action: "write" }),
      (e: { code?: string }) => typeof e?.code === "string",
      "a quote another wallet already minted and spent must not mint a pass",
    );
  } finally {
    await mint.close();
  }
});
