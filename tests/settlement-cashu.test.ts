// Test-only Cashu option (NUT-24). A local fake mint spends tokens. No real mint, no funds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../packages/server-node/src/index.ts";
import { decodePaymentRequest, decodeTokenV4, encodeTokenV4, startTestMint } from "../packages/settlement-ln/src/index.ts";
import { fromB64url, fromUtf8, randomBytes } from "../packages/protocol/src/bytes.ts";
import { createAgent, solveWork, testMintPayer } from "../packages/agent/src/index.ts";
import { startDemo, drain } from "./helpers.ts";

const SPEC_TOKEN = "cashuBo2F0gqJhaUgA_9SLj17PgGFwgaNhYQFhc3hAYWNjMTI0MzVlN2I4NDg0YzNjZjE4NTAxNDkyMThhZjkwZjcxNmE1MmJmNGE1ZWQzNDdlNDhlY2MxM2Y3NzM4OGFjWCECRFODGd5IXVW-07KaZCvuWHk3WrnnpiDhHki6SCQh88-iYWlIAK0mjE0fWCZhcIKjYWECYXN4QDEzMjNkM2Q0NzA3YTU4YWQyZTIzYWRhNGU5ZjFmNDlmNWE1YjRhYzdiNzA4ZWIwZDYxZjczOGY0ODMwN2U4ZWVhY1ghAjRWqhENhLSsdHrr2Cw7AFrKUL9Ffr1XN6RBT6w659lNo2FhAWFzeEA1NmJjYmNiYjdjYzY0MDZiM2ZhNWQ1N2QyMTc0ZjRlZmY4YjQ0MDJiMTc2OTI2ZDNhNTdkM2MzZGNiYjU5ZDU3YWNYIQJzEpxXGeWZN5qXSmJjY8MzxWyvwObQGr5G1YCCgHicY2FtdWh0dHA6Ly9sb2NhbGhvc3Q6MzMzOGF1Y3NhdA";

function passClaims(pass: string): { n: number; iat: number; exp: number; cls: string } {
  return JSON.parse(fromUtf8(fromB64url(pass.split(".")[1])));
}

test("config refuses the Cashu option outside test mode and refuses a non-loopback mint", () => {
  const base = { site_id: "s", secret: "x".repeat(32) };
  for (const settlement of [
    { enabled: true, backend: "stub", mode: "live", cashu: { enabled: true, mint: "http://127.0.0.1:3338" } },
    { enabled: true, backend: "nwc", cashu: { enabled: true, mint: "http://127.0.0.1:3338" } },
    { enabled: true, backend: "regtest", cashu: { enabled: true, mint: "http://127.0.0.1:3338" } },
    { enabled: false, backend: "nwc", cashu: { enabled: true, mint: "http://127.0.0.1:3338" } },
  ]) {
    assert.throws(() => normalizeConfig({ ...base, settlement }), /only available in test mode/, JSON.stringify(settlement));
  }
  assert.throws(() => normalizeConfig({ ...base, settlement: { enabled: true, cashu: { enabled: true, mint: "https://example.com" } } }), /must be http/);
  // Host rule, separate from the path rule. Forcing the host check true would accept these.
  const hostErr = /host must be loopback/;
  const pathErr = /must not include a path/;
  for (const mint of ["http://example.com:3338", "http://10.0.0.5:3338", "http://192.168.1.2:3338"]) {
    assert.throws(
      () => normalizeConfig({ ...base, settlement: { enabled: true, cashu: { enabled: true, mint } } }),
      (e: Error) => hostErr.test(e.message) && !pathErr.test(e.message),
      mint,
    );
  }
  assert.throws(
    () => normalizeConfig({ ...base, settlement: { enabled: true, cashu: { enabled: true, mint: "http://127.0.0.1:3338/mint" } } }),
    (e: Error) => pathErr.test(e.message) && !hostErr.test(e.message),
  );
  const ok = normalizeConfig({ ...base, settlement: { enabled: true, cashu: { enabled: true, mint: "http://127.0.0.1:3338/" } } });
  assert.equal(ok.settlement.cashu?.enabled, true);
  assert.equal(ok.settlement.cashu && "mint" in ok.settlement.cashu ? ok.settlement.cashu.mint : "", "http://127.0.0.1:3338");
  assert.equal(ok.settlement.backend, "stub");
  assert.equal(normalizeConfig({ ...base, settlement: { enabled: true } }).settlement.cashu, undefined);
});

test("NUT-00 cashuB example decodes", () => {
  const t = decodeTokenV4(SPEC_TOKEN);
  assert.equal(t.mint, "http://localhost:3338");
  assert.equal(t.unit, "sat");
  assert.deepEqual(t.proofs.map((p) => p.amount), [1, 2, 1]);
});

test("agent 402 carries an X-Cashu payment request; a test-mint token yields a 1-use 60s pass; replay is 401; a down mint falls back to work", async () => {
  const mint = await startTestMint();
  const S = await startDemo({
    work: { standard: { cost: 500 } },
    settlement: { enabled: true, backend: "stub", fee_bps: 1000, fx: { source: "fixed", usd_per_btc: 100000 }, cashu: { enabled: true, mint: mint.url } },
  });
  const post = (headers: Record<string, string>, body = "{}") =>
    fetch(S.url + "/contact", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", ...headers }, body });
  try {
    const human = await post({});
    assert.equal(human.status, 403);
    const humanBody = await human.json();
    assert.equal(humanBody.error, "toll_required");
    assert.equal(human.headers.get("x-cashu"), null);
    assert.equal(humanBody.offers, undefined);

    const denied = await post({ "toll-client": "agent" });
    assert.equal(denied.status, 402);
    const header = denied.headers.get("x-cashu");
    assert.ok(header?.startsWith("creqA"), header ?? "");
    assert.equal(denied.headers.get("www-authenticate"), null);
    const body = await denied.json();
    assert.deepEqual(Object.keys(body), ["error", "challenge_url", "offers"]);
    assert.equal(body.error, "payment_required");
    assert.equal(body.challenge, undefined);
    assert.match(body.challenge_url, /offers=0/);
    const req = decodePaymentRequest(header!);
    assert.equal(req.u, "sat");
    assert.equal(req.a, 10);
    assert.deepEqual(req.m, [mint.url]);
    assert.equal(req.s, true);
    assert.equal(body.offers.length, 1);
    assert.equal(body.offers[0].kind, "cashu");
    assert.equal(body.offers[0].request, header);
    assert.equal(body.offers[0].amount, 10);
    assert.equal(body.offers[0].amount_msat, 10000);
    assert.equal(body.offers[0].mint, mint.url);
    assert.equal(req.i, body.offers[0].id);

    const legacy = await post({ "toll-client": "agent", "x-cashu": "cashuAeyJ0b2tlbiI6W119" });
    assert.equal(legacy.status, 400);
    assert.equal((await legacy.json()).error, "malformed");

    const swapsBefore = mint.swaps();
    const token = await testMintPayer(mint.url)(body.offers[0]);
    assert.ok(token.startsWith("cashuB"));
    const paid = await post({ "toll-client": "agent", "x-cashu": token });
    assert.equal(paid.status, 200);
    const passBody = await paid.json();
    assert.equal(passBody.rail, "settle");
    assert.equal(passBody.cls, "write");
    assert.equal(typeof passBody.pass, "string");
    const claims = passClaims(passBody.pass);
    assert.equal(claims.n, 1);
    assert.equal(claims.exp - claims.iat, 60);
    assert.equal(passBody.exp, claims.exp);
    assert.ok(mint.swaps() > swapsBefore, "verification called the mint");

    const once = await post({ authorization: "Toll " + passBody.pass });
    assert.equal(once.status, 200);
    assert.equal((await once.json()).ok, true);
    const twice = await post({ authorization: "Toll " + passBody.pass });
    assert.equal(twice.status, 403);
    assert.equal((await twice.json()).error, "toll_required");

    const again = await post({ "toll-client": "agent", "x-cashu": token });
    assert.equal(again.status, 401);
    assert.equal((await again.json()).error, "replay");
    assert.ok(mint.swaps() > swapsBefore + 1, "a replay is refused by the mint, not only by a local flag");

    // A second issuer has an empty replay store, so local firstUse cannot know this token.
    // Replay here is only the mint reporting the proofs already spent.
    const S2 = await startDemo({
      work: { standard: { cost: 500 } },
      settlement: { enabled: true, backend: "stub", fee_bps: 1000, fx: { source: "fixed", usd_per_btc: 100000 }, cashu: { enabled: true, mint: mint.url } },
    });
    try {
      const swapsAt = mint.swaps();
      const other = await fetch(S2.url + "/contact", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", "x-cashu": token }, body: "{}" });
      assert.equal(other.status, 401);
      assert.equal((await other.json()).error, "replay");
      assert.ok(mint.swaps() > swapsAt, "the fresh issuer asked the mint");
    } finally {
      await S2.close();
    }

    const forged = encodeTokenV4({ mint: mint.url, unit: "sat", proofs: [{ amount: 10, secret: "ab".repeat(32), id: randomBytes(8), C: randomBytes(33) }] });
    const unknown = await post({ "toll-client": "agent", "x-cashu": forged });
    assert.equal(unknown.status, 401);
    assert.equal((await unknown.json()).error, "bad_solution");

    const agent = createAgent({ base: S.url, pay: testMintPayer(mint.url) });
    const viaAgent = await agent.fetch("/contact", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await viaAgent.response.arrayBuffer();
    assert.equal(viaAgent.via, "paid");
    assert.equal(viaAgent.response.status, 200);
    assert.ok(viaAgent.token?.startsWith("cashuB"));
    assert.equal(viaAgent.redeemed?.rail, "settle");
    const agentClaims = passClaims(viaAgent.pass!);
    assert.equal(agentClaims.n, 1);
    assert.equal(agentClaims.exp - agentClaims.iat, 60);

    mint.setDown(true);
    const down = await post({ "toll-client": "agent" });
    assert.equal(down.status, 403);
    assert.equal(down.headers.get("x-cashu"), null);
    const downBody = await down.json();
    assert.equal(downBody.error, "toll_required");
    assert.equal(downBody.offers, undefined);
    assert.equal(typeof downBody.challenge?.id, "string");
    assert.ok(downBody.challenge.work);
    const solved = await solveWork(downBody.challenge.work);
    assert.ok(solved);
    const redeemed = await fetch(S.url + "/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id: downBody.challenge.id, challenge: downBody.challenge, solution: { work: { counter: solved!.counter, derivedKey: solved!.derivedKey }, took_ms: 1 } }) });
    assert.equal(redeemed.status, 200);
    const workPass = await redeemed.json();
    assert.equal(workPass.rail, "work");
    const wrote = await post({ authorization: "Toll " + workPass.pass });
    assert.equal(wrote.status, 200);
    await drain(wrote);
  } finally {
    await S.close();
    await mint.close();
  }
});
