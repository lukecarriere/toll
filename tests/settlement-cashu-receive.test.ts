// Production Cashu receive against a loopback mint with a version-01 keyset.
// The allowlist is empty unless configured. Real mints stay off. The loopback test engine is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromB64url, fromUtf8 } from "../packages/protocol/src/bytes.ts";
import { normalizeConfig } from "../packages/server-node/src/index.ts";
import { decodeTokenV4, CashuReceiveEngine, assertProductionMint, guardMintUrl, mintFetch, resolveKeysetId, deriveKeysetIdV2, startKeysetMint, blockedAddress } from "../packages/settlement-ln/src/index.ts";
import { cashuPayer, createAgent } from "../packages/agent/src/index.ts";
import { startDemo, drain } from "./helpers.ts";

const base = { site_id: "s", secret: "x".repeat(32) };
const MINT = "https://pay.example.com/Bitcoin";

function passClaims(pass: string): { n: number; iat: number; exp: number } {
  return JSON.parse(fromUtf8(fromB64url(pass.split(".")[1])));
}

test("short version-01 keyset ids map only when the mint's ids are provided", () => {
  const full = "01" + "ab".repeat(7) + "cd".repeat(25);
  const other = "01" + "ab".repeat(7) + "ef".repeat(25);
  const short = Uint8Array.from(Buffer.from(full.slice(0, 16), "hex"));
  assert.equal(resolveKeysetId(short, [full]), full);
  assert.throws(() => resolveKeysetId(short, []), /short keyset id/);
  assert.throws(() => resolveKeysetId(short, [full, other]), /short keyset id/);
  assert.equal(resolveKeysetId(Uint8Array.from(Buffer.from(full, "hex")), [full]), full);
  const id = deriveKeysetIdV2({ "1": "02" + "11".repeat(32), "2": "02" + "22".repeat(32) }, "sat");
  assert.equal(id.length, 66);
  assert.notEqual(id, deriveKeysetIdV2({ "1": "02" + "11".repeat(32), "2": "02" + "22".repeat(32) }, "sat", 100));
});

test("production allowlist is https and public; empty means off; the test mint stays loopback", () => {
  assert.equal(normalizeConfig({ ...base, settlement: { enabled: true, cashu: { enabled: true, mints: [] } } }).settlement.cashu, undefined);
  const ok = normalizeConfig({ ...base, settlement: { enabled: true, cashu: { enabled: true, mints: [MINT + "/"], store: "env:TOLL_CASHU_STORE" } } }, { TOLL_CASHU_STORE: "/tmp/toll-cashu-proofs" });
  assert.deepEqual(ok.settlement.cashu, { enabled: true, mints: [MINT], store: "/tmp/toll-cashu-proofs" });
  assert.equal(ok.settlement.backend, "stub");
  assert.throws(() => normalizeConfig({ ...base, settlement: { enabled: true, cashu: { enabled: true, mints: ["http://pay.example.com/Bitcoin"], store: "/tmp/p" } } }), (e: Error) => /must be https/.test(e.message) && !/not public/.test(e.message));
  for (const mint of ["https://127.0.0.1/Bitcoin", "https://10.0.0.5/Bitcoin", "https://169.254.169.254/", "https://localhost/Bitcoin", "https://[::1]/Bitcoin"]) {
    assert.throws(() => assertProductionMint(mint), (e: Error) => /not public/.test(e.message) && !/must be https/.test(e.message), mint);
  }
  assert.throws(() => assertProductionMint("https://user:secret@pay.example.com/Bitcoin"), /userinfo/);
  assert.throws(() => normalizeConfig({ ...base, settlement: { enabled: true, cashu: { enabled: true, mints: [MINT] } } }), /store is required/);
  assert.throws(() => normalizeConfig({ ...base, settlement: { enabled: true, mode: "live", cashu: { enabled: true, mints: [MINT], store: "/tmp/p" } } }), /only available in test mode/);
  assert.throws(() => normalizeConfig({ ...base, settlement: { enabled: true, cashu: { enabled: true, mint: "http://127.0.0.1:9", mints: [MINT], store: "/tmp/p" } } }), /are separate/);
  assert.equal(blockedAddress("8.8.8.8"), false);
  assert.equal(blockedAddress("10.1.2.3"), true);
});

test("a mint URL is fetched only when it is allowlisted, https, and public; redirects are not followed", async () => {
  let looked = false;
  await assert.rejects(guardMintUrl("http://pay.example.com/Bitcoin", ["http://pay.example.com/Bitcoin"], { lookup: async () => { looked = true; return ["1.1.1.1"]; } }), (e: Error) => /must be https/.test(e.message) && !looked);
  await assert.rejects(guardMintUrl(MINT, [MINT], { lookup: async () => ["10.0.0.8"] }), /not public/);
  await assert.rejects(guardMintUrl("https://evil.example/Bitcoin", [MINT], { lookup: async () => ["1.1.1.1"] }), /allowlist/);
  assert.equal(await guardMintUrl(MINT, [MINT], { lookup: async () => ["1.1.1.1"] }), MINT);

  let trapHits = 0;
  const trap = createServer((req, res) => { trapHits++; res.writeHead(200).end("no"); req.resume(); });
  const redir = createServer((req, res) => {
    res.writeHead(302, { location: "http://127.0.0.1:" + (trap.address() as AddressInfo).port + "/secret" });
    res.end();
    req.resume();
  });
  await new Promise<void>((ok) => trap.listen(0, "127.0.0.1", ok));
  await new Promise<void>((ok) => redir.listen(0, "127.0.0.1", ok));
  const url = "http://127.0.0.1:" + (redir.address() as AddressInfo).port;
  try {
    await assert.rejects(mintFetch(url, "/v1/info", { method: "GET" }, { loopbackHttp: true }, [url]), (e: { code?: string }) => e.code === "store_unavailable");
    assert.equal(trapHits, 0);
  } finally {
    redir.close();
    trap.close();
  }
});

test("a version-01 token swaps into stored proofs; replay, allowlist, and a down mint hold", async () => {
  const mint = await startKeysetMint();
  const dir = mkdtempSync(join(tmpdir(), "toll-cashu-"));
  const store = join(dir, "proofs.json");
  const secret = "cashu-receive-test-secret";
  const engine = () => new CashuReceiveEngine({ secret, mints: [mint.url], store, loopbackHttp: true });
  const lines: string[] = [];
  const spy = (name: "log" | "info" | "warn" | "error" | "debug") => {
    const orig = console[name].bind(console);
    console[name] = (...a: unknown[]) => { lines.push(a.map((x) => typeof x === "string" ? x : "").join(" ")); orig(...a); };
  };
  spy("log"); spy("info"); spy("warn"); spy("error"); spy("debug");
  const S = await startDemo({
    work: { standard: { cost: 500 } },
    settlement: { enabled: true, backend: "stub", fee_bps: 1000, fx: { source: "fixed", usd_per_btc: 100000 }, cashu: { enabled: true, mint: mint.url } },
  }, { settlement: { engine: engine() } });
  const post = (headers: Record<string, string>) =>
    fetch(S.url + "/contact", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", ...headers }, body: "{}" });
  try {
    const denied = await post({ "toll-client": "agent" });
    assert.equal(denied.status, 402);
    const header = denied.headers.get("x-cashu");
    assert.ok(header?.startsWith("creqA"));
    const body = await denied.json();
    const source = mint.token(10);
    const decoded = decodeTokenV4(source);
    assert.equal(decoded.proofs[0].id.length, 8);
    assert.equal(decoded.proofs[0].id[0], 0x01);
    const payer = cashuPayer({ token: source });
    const paidToken = await payer(body.offers[0]);
    assert.equal(paidToken, source);
    const swapsBefore = mint.swaps();
    const paid = await post({ "toll-client": "agent", "x-cashu": paidToken });
    assert.equal(paid.status, 200);
    const passBody = await paid.json();
    assert.equal(passBody.rail, "settle");
    const claims = passClaims(passBody.pass);
    assert.equal(claims.n, 1);
    assert.equal(claims.exp - claims.iat, 60);
    assert.equal(mint.swaps(), swapsBefore + 1);
    assert.equal(mint.lastInputIds()[0].length, 66, "the swap uses the full keyset id");
    assert.ok(mint.lastInputIds()[0].startsWith("01"));
    const { readFileSync } = await import("node:fs");
    const saved = JSON.parse(readFileSync(store, "utf8"));
    assert.equal(saved.proofs.reduce((n: number, p: { amount: number }) => n + p.amount, 0), 10);
    assert.equal(saved.proofs[0].id.length, 66);
    const blob = lines.concat(S.lines).join("\n");
    assert.equal(decoded.proofs.every((p) => !blob.includes(p.secret)) && !blob.includes(paidToken), true);

    const again = await post({ "toll-client": "agent", "x-cashu": paidToken });
    assert.equal(again.status, 401);
    assert.equal((await again.json()).error, "replay");
    assert.equal(mint.swaps(), swapsBefore + 1, "a replay is refused from the store, before another swap");

    const empty = join(dir, "empty.json");
    const remembered = mint.swaps();
    const S3 = await startDemo({
      work: { standard: { cost: 500 } },
      settlement: { enabled: true, backend: "stub", cashu: { enabled: true, mint: mint.url } },
    }, { settlement: { engine: new CashuReceiveEngine({ secret, mints: [mint.url], store: empty, loopbackHttp: true }) } });
    try {
      const other = await fetch(S3.url + "/contact", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", "x-cashu": paidToken }, body: "{}" });
      assert.equal(other.status, 401);
      assert.equal((await other.json()).error, "replay");
      assert.ok(mint.swaps() > remembered, "with an empty store the mint's spent state still refuses");
    } finally {
      await S3.close();
    }

    mint.forgetSpent();
    const swapsAt = mint.swaps();
    const S2 = await startDemo({
      work: { standard: { cost: 500 } },
      settlement: { enabled: true, backend: "stub", cashu: { enabled: true, mint: mint.url } },
    }, { settlement: { engine: engine() } });
    try {
      const restarted = await fetch(S2.url + "/contact", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", "x-cashu": paidToken }, body: "{}" });
      assert.equal(restarted.status, 401);
      assert.equal((await restarted.json()).error, "replay");
      assert.equal(mint.swaps(), swapsAt, "the spent set survived the new process");
    } finally {
      await S2.close();
    }

    let change = "";
    const bigger = cashuPayer({ token: mint.token(16) }, { onChange: (t) => { change = t; } });
    const denied2 = await post({ "toll-client": "agent" });
    const body2 = await denied2.json();
    assert.equal(denied2.status, 402);
    const split = await bigger(body2.offers[0]);
    assert.equal(decodeTokenV4(split).proofs.reduce((n, p) => n + p.amount, 0), 10);
    assert.equal(decodeTokenV4(change).proofs.reduce((n, p) => n + p.amount, 0), 6);
    const agent = createAgent({ base: S.url, pay: cashuPayer({ token: mint.token(10) }) });
    const via = await agent.fetch("/contact", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await drain(via.response);
    assert.equal(via.via, "paid");
    assert.equal(via.response.status, 200);

    mint.setDown(true);
    const down = await post({ "toll-client": "agent" });
    assert.equal(down.status, 403);
    const downBody = await down.json();
    assert.equal(downBody.error, "toll_required");
    assert.ok(downBody.challenge?.work);
  } finally {
    await S.close();
    await mint.close();
  }
});
