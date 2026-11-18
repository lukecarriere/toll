// Regression: dummy token data only; every fetch is intercepted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgent, cashuPayer } from "../packages/agent/src/index.ts";
import { decodeToken, encodePaymentRequest, encodeTokenV4 } from "../packages/settlement-ln/src/cashu.ts";

const BASE = "http://127.0.0.1:8800";
const MINT = "http://127.0.0.1:8801";

async function exercise(amount: number, declaredMsat: unknown, requestAmount = amount, cap = 1000) {
  let payCalls = 0;
  let redeemCalls = 0;
  let sentSats = 0;
  let mintCalls = 0;
  const source = encodeTokenV4({ mint: MINT, unit: "sat", proofs: [{
    amount, secret: "test-dummy-unspendable-proof", id: new Uint8Array(8), C: new Uint8Array(33),
  }] });
  const offer: Record<string, unknown> = {
    kind: "cashu", id: "test-offer", credential: "test-dummy-credential",
    amount, mint: MINT, unit: "sat", exp: Math.floor(Date.now() / 1000) + 60,
    request: encodePaymentRequest({ a: requestAmount, u: "sat", m: [MINT] }),
  };
  if (declaredMsat !== undefined) offer.amount_msat = declaredMsat;
  const payer = cashuPayer({ token: source }, { fetch: async () => {
    mintCalls++;
    throw new Error("mint network not allowed in this test");
  } });
  const client = createAgent({ base: BASE, work: false, maxAmountMsat: cap,
    pay: async (o) => { payCalls++; return payer(o); },
    fetch: async (input, init) => {
      const url = String(input);
      if (url === BASE + "/v1/redeem") {
        redeemCalls++;
        const body: unknown = JSON.parse(String(init?.body));
        assert.ok(body && typeof body === "object" && "token" in body && typeof body.token === "string");
        sentSats = decodeToken(body.token).proofs.reduce((n, p) => n + p.amount, 0);
        return Response.json({ pass: "test-dummy-pass", rail: "settle", cls: "write", exp: 1 });
      }
      assert.equal(url, BASE + "/contact", "all agent calls remain inside the mock fixture");
      if (new Headers(init?.headers).has("authorization")) return Response.json({ ok: true });
      return Response.json({ offers: [offer] }, { status: 402 });
    },
  });
  let outcome = "rejected";
  try {
    const result = await client.fetch("/contact", { method: "POST", body: "{}" });
    await result.response.arrayBuffer();
    outcome = result.via;
  } catch (e) {
    assert.ok(e instanceof Error);
  }
  return { payCalls, redeemCalls, sentSats, mintCalls, outcome };
}

test("max amount control: consistent within-cap offer pays only one dummy sat", async () => {
  assert.deepEqual(await exercise(1, 1000), { payCalls: 1, redeemCalls: 1, sentSats: 1, mintCalls: 0, outcome: "paid" });
});

test("max amount control: truthful over-cap offer never invokes payer", async () => {
  assert.deepEqual(await exercise(100, 100000), { payCalls: 0, redeemCalls: 0, sentSats: 0, mintCalls: 0, outcome: "rejected" });
});

test("max amount control: payer rejects amount versus request mismatch", async () => {
  const result = await exercise(100, 1000, 99);
  assert.equal(result.redeemCalls, 0);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.mintCalls, 0);
});

for (const [label, value] of [
  ["inconsistent", 1000], ["omitted", undefined], ["null", null],
  ["string", "1000"], ["non-numeric string", "not-a-number"], ["zero", 0], ["negative", -1000], ["unsafe", Number.MAX_SAFE_INTEGER + 1],
] as const) {
  test(`max amount: ${label} msat field cannot authorize 100 sats with a 1-sat cap`, async () => {
    const result = await exercise(100, value);
    assert.equal(result.mintCalls, 0, "fixture must never call a mint");
    assert.deepEqual({ payCalls: result.payCalls, redeemCalls: result.redeemCalls, sentSats: result.sentSats },
      { payCalls: 0, redeemCalls: 0, sentSats: 0 }, "invalid remote price must be rejected before invoking payer");
  });
}

// The price must be valid even without a small ceiling to incidentally catch it.
for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.5, NaN, Infinity]) {
  test(`max amount: invalid numeric price ${String(value)} is rejected under a large cap`, async () => {
    const result = await exercise(1, value, 1, Number.MAX_SAFE_INTEGER);
    assert.equal(result.payCalls, 0);
    assert.equal(result.redeemCalls, 0);
  });
}

test("max amount: a request larger than the consistent declared amount is refused before custom payer", async () => {
  const result = await exercise(1, 1000, 100);
  assert.equal(result.payCalls, 0);
  assert.equal(result.redeemCalls, 0);
});

test("max amount: invalid trusted ceilings fail closed", () => {
  for (const maxAmountMsat of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createAgent({ base: BASE, maxAmountMsat }), /maxAmountMsat/);
  }
});

test("max amount: zero ceiling refuses a valid paid offer", async () => {
  const result = await exercise(1, 1000, 1, 0);
  assert.equal(result.payCalls, 0);
  assert.equal(result.redeemCalls, 0);
});

test("max amount: standalone built-in payer refuses an unbound amount", async () => {
  const payer = cashuPayer({ proofs: [], mint: MINT });
  await assert.rejects(payer({ kind: "cashu", amount_msat: 1000, amount: 100, unit: "sat",
    request: encodePaymentRequest({ a: 100, u: "sat", m: [MINT] }), mint: MINT,
    id: "test-offer", credential: "test-dummy-credential", exp: 1 }), /inconsistent price/);
});
