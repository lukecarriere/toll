// toll.json names the protocols the issuer actually offers. x402 stays a stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "../packages/server-node/src/manifest.ts";
import { QUOTE_KIND, startTestMint } from "../packages/settlement-ln/src/index.ts";
import { startDemo } from "./helpers.ts";

const prices = {
  write: { amount_msat: 10000, usd: "0.0100" },
  search: { amount_msat: 2000, usd: "0.0020" },
  account: { amount_msat: 25000, usd: "0.0250" },
  admin: { amount_msat: 100000, usd: "0.1000" },
};

test("no paid offer: every tool stays protocol none", () => {
  const doc = buildManifest({ api: "http://x.test/v1", docs: null, status: "stub", prices: null });
  assert.equal(doc.tools.length, 3);
  for (const t of doc.tools) assert.deepEqual(t.payment, { status: "stub", protocol: "none", methods: [], x402: { status: "stub" } });
});

test("cashu is listed on every tool, and the quote method only when the issuer offers it", () => {
  const cashu = buildManifest({ api: "http://x.test/v1", docs: null, status: "cashu", prices, methods: ["cashu"] });
  for (const t of cashu.tools) {
    assert.equal(t.payment.protocol, "HTTP 402");
    assert.deepEqual(t.payment.methods, [{ kind: "cashu", status: "cashu" }]);
    assert.equal(t.payment.x402.status, "stub");
  }
  const both = buildManifest({ api: "http://x.test/v1", docs: null, status: "cashu", prices, methods: ["cashu", QUOTE_KIND] });
  for (const t of both.tools) {
    assert.deepEqual(t.payment.methods.map((m) => m.kind), ["cashu", QUOTE_KIND]);
    assert.equal(t.payment.methods.find((m) => m.kind === "cashu")?.status, "cashu");
    assert.equal(t.payment.methods.find((m) => m.kind === QUOTE_KIND)?.status, QUOTE_KIND);
  }
});

test("the loopback issuer toll.json and the 402 offer the same methods", async () => {
  const mint = await startTestMint();
  const S = await startDemo({
    settlement: { enabled: true, backend: "stub", fee_bps: 1000, fx: { source: "fixed", usd_per_btc: 100000 }, cashu: { enabled: true, mint: mint.url } },
  });
  try {
    const res = await fetch(S.url + "/.well-known/toll.json");
    const doc = await res.json();
    assert.equal(res.status, 200);
    assert.equal(doc.tools.length, 3);
    const denied = await fetch(S.url + "/contact", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent" },
      body: "{}",
    });
    const body = await denied.json();
    assert.equal(denied.status, 402);
    const offered = body.offers.map((o: { kind: string }) => o.kind);
    assert.deepEqual(offered, ["cashu", QUOTE_KIND]);
    for (const t of doc.tools) {
      assert.equal(t.payment.protocol, "HTTP 402");
      assert.deepEqual(t.payment.methods.map((m: { kind: string }) => m.kind), offered);
      assert.equal(t.payment.methods.find((m: { kind: string }) => m.kind === "cashu").status, "cashu");
      assert.equal(t.payment.methods.find((m: { kind: string }) => m.kind === QUOTE_KIND).status, QUOTE_KIND);
      assert.equal(t.payment.x402.status, "stub");
    }
  } finally {
    await S.close();
    await mint.close();
  }
});
