// Production Cashu receive against a loopback mint with a version-01 keyset.
// The allowlist is empty unless configured. Real mints stay off. The loopback test engine is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromB64url, fromUtf8, toB64url, toHex, utf8 } from "../packages/protocol/src/bytes.ts";
import { normalizeConfig } from "../packages/server-node/src/index.ts";
import { decodeToken, decodeTokenV4, encodeTokenV3, encodeTokenV4, CashuReceiveEngine, COMPLETE_MINT_CALLS, LEASE_MARGIN_MS, LEASE_MS, MINT_CALL_TIMEOUT_MS, assertProductionMint, guardMintUrl, mintFetch, resolveKeysetId, deriveKeysetIdV2, startKeysetMint, blockedAddress } from "../packages/settlement-ln/src/index.ts";
import { FileProofStore, type PendingSwap, type ProofStore, type StoredProof } from "../packages/settlement-ln/src/cashu-store.ts";
import { MemoryStore } from "../packages/server-node/src/stores.ts";
import { TollError } from "../packages/protocol/src/errors.ts";
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
  assert.throws(() => assertProductionMint("https://" + ["metadata", "google", "com"].join(".") + "/"), /not public/);
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
    settlement: { enabled: true, backend: "stub", fee_bps: 1000, fx: { source: "fixed", usd_per_btc: 100000 }, owner_key: "owner-test-key-0123456789abcdef", cashu: { enabled: true, mint: mint.url } },
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
      assert.equal(other.status, 503);
      assert.equal((await other.json()).error, "unavailable");
      const kept = JSON.parse(readFileSync(empty, "utf8"));
      assert.equal(kept.pending.length, 1, "11001 keeps the blinded outputs");
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

    const sourceA = encodeTokenV3(decodeToken(mint.token(10)));
    const deniedA = await post({ "toll-client": "agent" });
    assert.equal(deniedA.status, 402);
    const bodyA = await deniedA.json();
    const sentA = await cashuPayer({ token: sourceA })(bodyA.offers[0]);
    assert.equal(sentA, sourceA);
    const swapsA = mint.swaps();
    const paidA = await post({ "toll-client": "agent", "x-cashu": sentA });
    assert.equal(paidA.status, 200);
    await drain(paidA);
    assert.equal(mint.lastInputIds()[0].length, 66);
    assert.ok(mint.lastInputIds()[0].startsWith(toHex(decodeToken(sourceA).proofs[0].id)));
    const replayA = await post({ "toll-client": "agent", "x-cashu": sentA });
    assert.equal(replayA.status, 401);
    assert.equal((await replayA.json()).error, "replay");
    assert.equal(mint.swaps(), swapsA + 1);

    let changeA = "";
    const biggerA = cashuPayer({ token: encodeTokenV3(decodeToken(mint.token(16))) }, { onChange: (t) => { changeA = t; } });
    const deniedChange = await post({ "toll-client": "agent" });
    const bodyChange = await deniedChange.json();
    const splitA = await biggerA(bodyChange.offers[0]);
    assert.ok(splitA.startsWith("cashuB"));
    assert.ok(changeA.startsWith("cashuB"));

    const agentA = createAgent({ base: S.url, pay: cashuPayer({ token: encodeTokenV3(decodeToken(mint.token(10))) }) });
    const viaA = await agentA.fetch("/contact", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await drain(viaA.response);
    assert.equal(viaA.via, "paid");
    assert.equal(viaA.response.status, 200);
    assert.ok(viaA.token?.startsWith("cashuA"));

    const foreign = encodeTokenV3({ ...decodeToken(mint.token(10)), mint: "https://evil.example/Bitcoin" });
    const refusedA = await post({ "toll-client": "agent", "x-cashu": foreign });
    assert.equal(refusedA.status, 400);
    assert.equal((await refusedA.json()).error, "malformed");

    const booked = await fetch(S.url + "/v1/owner/cashu", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer owner-test-key-0123456789abcdef" },
      body: JSON.stringify({ token: encodeTokenV3(decodeToken(mint.token(10))), action: "write" }),
    });
    assert.equal(booked.status, 200);
    assert.equal((await booked.json()).ok, true);

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

/** A store that records spent inputs but will begin a second swap of them. The engine check is the only replay block. */
function looseStore(): ProofStore & { begins: () => number } {
  let proofs: StoredProof[] = [];
  let spent: string[] = [];
  let pending: PendingSwap[] = [];
  let losses = 0;
  let begins = 0;
  const books = () => {
    const stored = proofs.reduce((n, p) => n + p.amount, 0);
    const pendingSats = pending.reduce((n, p) => n + p.outSats, 0);
    return { stored, pending: pendingSats, losses, spent: spent.length, inSats: stored + pendingSats + losses };
  };
  return {
    begins: () => begins,
    async read() { return { proofs: proofs.slice(), spent: spent.slice(), pending: pending.slice(), losses }; },
    books: async () => books(),
    async begin(p) { begins++; pending.push(p); return p; },
    async lease(id, owner, exp) {
      const row = pending.find((p) => p.id === id);
      if (!row || (row.owner !== undefined && row.owner !== owner)) return;
      if (row.at === undefined) row.at = Date.now();
      row.owner = owner;
      row.leaseExp = exp;
    },
    async commit(o) {
      proofs = proofs.concat(o.proofs);
      for (const h of o.marks) if (!spent.includes(h)) spent.push(h);
      pending = pending.filter((p) => p.id !== o.id);
    },
    async abort(id) { pending = pending.filter((p) => p.id !== id); },
    async lose(o) {
      pending = pending.filter((p) => p.id !== o.id);
      for (const h of o.marks) if (!spent.includes(h)) spent.push(h);
    },
  };
}

function encodeEntries(t: { mint: string; unit: string; proofs: { amount: number; secret: string; id: Uint8Array; C: Uint8Array }[] }): string {
  const token = t.proofs.map((p) => ({
    mint: t.mint,
    proofs: [{ amount: p.amount, id: toHex(p.id).slice(0, 16), secret: p.secret, C: toHex(p.C) }],
  }));
  return "cashuA" + toB64url(utf8(JSON.stringify({ token, unit: t.unit })));
}

test("cashuA guard: a V3 token pays, replay and an unlisted mint are refused, and both encoders pay", async () => {
  const mint = await startKeysetMint();
  const store = looseStore();
  const fetched: string[] = [];
  const engine = new CashuReceiveEngine({
    secret: "cashu-receive-test-secret",
    mints: [mint.url],
    store,
    loopbackHttp: true,
    fetch: async (input, init) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetched.push(href);
      return fetch(input, init);
    },
  });
  const now = Math.floor(Date.now() / 1000);
  const firstUse = async () => true;
  const pay = async (token: string) => {
    const offer = await engine.offer({ site: "s", cls: "write", amount_msat: 10000, now });
    return engine.verifyPaid({ site: "s", now, firstUse, proof: { kind: "cashu", offer_id: offer.id, credential: offer.credential, token } });
  };
  try {
    const raw = decodeToken(mint.token(10));
    const v3 = encodeTokenV3(raw);
    assert.equal(decodeToken(v3).proofs[0].id.length, 8);
    assert.equal(decodeToken(v3).proofs[0].id[0], 0x01);
    const swaps = mint.swaps();
    const paid = await pay(v3);
    assert.equal(paid.amount_msat, 10000);
    const short = toHex(decodeToken(v3).proofs[0].id);
    assert.equal(short.length, 16);
    assert.ok(mint.lastInputIds()[0].startsWith(short));
    assert.equal(mint.lastInputIds()[0].length, 66);
    const begins = store.begins();
    await assert.rejects(() => pay(v3), (e: unknown) => e instanceof TollError && e.code === "replay");
    assert.equal(store.begins(), begins);
    assert.equal(mint.swaps(), swaps + 1);
    await assert.rejects(() => pay(encodeTokenV4(raw)), (e: unknown) => e instanceof TollError && e.code === "replay");

    const split = decodeToken(mint.token(10));
    assert.ok(split.proofs.length > 1);
    const multi = encodeEntries(split);
    assert.ok(decodeToken(multi).proofs.length > 1);
    await pay(multi);
    await pay(encodeTokenV4(decodeToken(mint.token(10))));

    const wrong = encodeTokenV3({ ...decodeToken(mint.token(10)), unit: "usd" });
    await assert.rejects(() => pay(wrong), (e: unknown) => e instanceof TollError && e.code === "malformed");
    await assert.rejects(() => pay("cashuAeyJ0b2tlbiI6W119"), (e: unknown) => e instanceof TollError && e.code === "malformed");
    const offer = await engine.offer({ site: "s", cls: "write", amount_msat: 10000, now });
    await assert.rejects(
      () => engine.verifyPaid({ site: "s", now, firstUse, proof: { kind: "cashu", offer_id: offer.id, credential: offer.credential, token: offer.request } }),
      (e: unknown) => e instanceof TollError && e.code === "malformed",
    );

    fetched.length = 0;
    const foreign = encodeTokenV3({ ...decodeToken(mint.token(10)), mint: "http://127.0.0.1:1/Bitcoin" });
    await assert.rejects(() => pay(foreign), (e: unknown) => e instanceof TollError && e.code === "malformed");
    assert.equal(fetched.some((u) => u.includes("127.0.0.1:1")), false);
  } finally {
    await mint.close();
  }
});

test("verifyPaid's replay check alone blocks a second swap when the store would accept the inputs", async () => {
  const mint = await startKeysetMint();
  const store = looseStore();
  const engine = new CashuReceiveEngine({ secret: "cashu-receive-test-secret", mints: [mint.url], store, loopbackHttp: true });
  const now = Math.floor(Date.now() / 1000);
  const firstUse = async () => true;
  try {
    const offer = await engine.offer({ site: "s", cls: "write", amount_msat: 10000, now });
    const token = mint.token(10);
    const swaps = mint.swaps();
    await engine.verifyPaid({ site: "s", now, firstUse, proof: { kind: "cashu", offer_id: offer.id, credential: offer.credential, token } });
    assert.equal(mint.swaps(), swaps + 1);
    const begins = store.begins();
    await assert.rejects(
      () => engine.verifyPaid({ site: "s", now, firstUse, proof: { kind: "cashu", offer_id: offer.id, credential: offer.credential, token } }),
      (e: unknown) => e instanceof TollError && e.code === "replay",
    );
    assert.equal(store.begins(), begins);
    assert.equal(mint.swaps(), swaps + 1);
  } finally {
    await mint.close();
  }
});

function cashuAFull(mintUrl: string, keysetId: string, token: string): string {
  const decoded = decodeToken(token);
  const obj = {
    token: [{
      mint: mintUrl,
      proofs: decoded.proofs.map((p) => ({ amount: p.amount, id: keysetId, secret: p.secret, C: toHex(p.C) })),
    }],
    unit: decoded.unit,
  };
  return "cashuA" + toB64url(utf8(JSON.stringify(obj)));
}

test("a plain 422 from the mint is a refusal, and the pending swap is aborted when nothing was spent", async () => {
  const mint = await startKeysetMint();
  const dir = mkdtempSync(join(tmpdir(), "toll-cashu-422-"));
  const store = new FileProofStore(join(dir, "proofs.json"));
  const engine = new CashuReceiveEngine({ secret: "cashu-receive-test-secret", mints: [mint.url], store, loopbackHttp: true });
  const now = Math.floor(Date.now() / 1000);
  mint.setFault("/v1/swap", "plain-422");
  try {
    const offer = await engine.offer({ site: "s", cls: "write", amount_msat: 10000, now });
    const token = cashuAFull(mint.url, mint.keysetId, mint.token(10));
    assert.equal(decodeToken(token).proofs[0].id.length, 33);
    const signed = mint.signedSats();
    await assert.rejects(
      () => engine.verifyPaid({ site: "s", now, firstUse: async () => true, proof: { kind: "cashu", offer_id: offer.id, credential: offer.credential, token } }),
      (e: unknown) => e instanceof TollError && e.code === "bad_solution",
    );
    const mid = await store.read();
    assert.equal(mid.pending.length, 0);
    const books = await store.books();
    assert.equal(books.pending, 0);
    assert.equal(books.stored, 0);
    assert.equal(books.losses, 0);
    assert.equal(books.inSats, books.stored + books.pending + books.losses);
    assert.equal(mint.signedSats(), signed);
  } finally {
    await mint.close();
  }
});

test("the next payment clears a pending swap the mint never took", async () => {
  const mint = await startKeysetMint();
  const dir = mkdtempSync(join(tmpdir(), "toll-cashu-sweep-"));
  const store = new FileProofStore(join(dir, "proofs.json"));
  const secret = "cashu-receive-test-secret";
  const stuck = new CashuReceiveEngine({
    secret, mints: [mint.url], store, loopbackHttp: true,
    beforeSwap: () => { throw new TollError("store_unavailable"); },
  });
  const now = Math.floor(Date.now() / 1000);
  const firstUse = async () => true;
  try {
    const offer = await stuck.offer({ site: "s", cls: "write", amount_msat: 10000, now });
    const token = cashuAFull(mint.url, mint.keysetId, mint.token(10));
    await assert.rejects(
      () => stuck.verifyPaid({ site: "s", now, firstUse, proof: { kind: "cashu", offer_id: offer.id, credential: offer.credential, token } }),
      (e: unknown) => e instanceof TollError && e.code === "store_unavailable",
    );
    assert.equal((await store.read()).pending.length, 1);
    const next = new CashuReceiveEngine({ secret, mints: [mint.url], store, loopbackHttp: true });
    const offer2 = await next.offer({ site: "s", cls: "write", amount_msat: 10000, now });
    const token2 = cashuAFull(mint.url, mint.keysetId, mint.token(10));
    await next.verifyPaid({ site: "s", now, firstUse, proof: { kind: "cashu", offer_id: offer2.id, credential: offer2.credential, token: token2 } });
    const end = await store.books();
    assert.equal(end.pending, 0);
    assert.equal(end.stored, 10);
    assert.equal(end.losses, 0);
    assert.equal(end.inSats, end.stored + end.pending + end.losses);
    assert.equal(end.inSats, mint.signedSats());
  } finally {
    await mint.close();
  }
});

test("a sweep does not delete a swap the mint has not answered yet", async () => {
  const mint = await startKeysetMint();
  const dir = mkdtempSync(join(tmpdir(), "toll-cashu-inflight-"));
  const store = new FileProofStore(join(dir, "proofs.json"));
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let heldSwap = false;
  const engine = new CashuReceiveEngine({
    secret: "cashu-receive-test-secret",
    mints: [mint.url],
    store,
    loopbackHttp: true,
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/v1/swap") && !heldSwap) {
        heldSwap = true;
        await held;
      }
      return fetch(input, init);
    },
  });
  const now = Math.floor(Date.now() / 1000);
  const firstUse = async () => true;
  try {
    const offer = await engine.offer({ site: "s", cls: "write", amount_msat: 10000, now });
    const token = cashuAFull(mint.url, mint.keysetId, mint.token(10));
    const paid = engine.verifyPaid({ site: "s", now, firstUse, proof: { kind: "cashu", offer_id: offer.id, credential: offer.credential, token } });
    const deadline = Date.now() + 5_000;
    let row = (await store.read()).pending[0];
    while (!row?.leaseExp) {
      if (Date.now() > deadline) throw new Error("the pending swap was not saved");
      await new Promise((r) => setTimeout(r, 5));
      row = (await store.read()).pending[0];
    }
    assert.equal(LEASE_MS, COMPLETE_MINT_CALLS * MINT_CALL_TIMEOUT_MS + LEASE_MARGIN_MS);
    assert.ok(typeof row.leaseExp === "number" && row.leaseExp - Date.now() > 10_000);
    await engine.recoverSaved();
    release();
    let error: unknown = null;
    try { await paid; } catch (e) { error = e; }
    const books = await store.books();
    assert.equal(mint.signedSats(), 10);
    assert.equal(books.stored + books.pending + books.losses, mint.signedSats());
    assert.equal(books.stored, 10);
    assert.equal(books.pending, 0);
    assert.equal(error, null);
  } finally {
    release();
    await mint.close();
  }
});

test("seven mint calls still inside complete() survive a sweep at the old 10s floor and just before the lease ends", async () => {
  const mint = await startKeysetMint();
  const dir = mkdtempSync(join(tmpdir(), "toll-cashu-seven-"));
  const store = new FileProofStore(join(dir, "proofs.json"));
  const hold = MINT_CALL_TIMEOUT_MS - 10;
  const epsilon = LEASE_MARGIN_MS + COMPLETE_MINT_CALLS * 10 + 1;
  assert.equal(LEASE_MS, COMPLETE_MINT_CALLS * MINT_CALL_TIMEOUT_MS + LEASE_MARGIN_MS);
  assert.ok(LEASE_MS > 10_000, "a 1s mint timeout does not cover seven calls past the old floor");
  assert.ok(6 * hold < 10_000 && 10_000 < 7 * hold);
  assert.ok(10_000 < LEASE_MS - epsilon && LEASE_MS - epsilon < 7 * hold);
  let phase = false;
  let n = 0;
  let sweeping = false;
  const failures: string[] = [];
  const engine = new CashuReceiveEngine({
    secret: "cashu-receive-test-secret",
    mints: [mint.url],
    store,
    loopbackHttp: true,
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url).pathname;
      if (path.endsWith("/v1/swap")) phase = true;
      const counted = phase && (path.endsWith("/v1/swap") || path.includes("/v1/keys/") || path.endsWith("/v1/restore") || path.endsWith("/v1/checkstate"));
      if (!counted) return fetch(input, init);
      if (sweeping) return reply(path, init);
      n++;
      const call = n;
      if (call < 7) {
        await new Promise((r) => setTimeout(r, hold));
        return reply(path, init);
      }
      if (call !== 7) failures.push("call " + call);
      const row = (await store.read()).pending[0];
      if (!row?.at) failures.push("row missing before the old floor");
      const floorAt = (row?.at ?? Date.now()) + 10_000;
      await new Promise((r) => setTimeout(r, Math.max(0, floorAt - Date.now())));
      sweeping = true;
      await engine.recoverSaved();
      sweeping = false;
      if ((await store.read()).pending.length !== 1) failures.push("swept at the old 10s floor");
      const leased = (await store.read()).pending[0];
      if (typeof leased?.leaseExp !== "number") failures.push("no lease");
      else {
        const beforeExpiry = leased.leaseExp - epsilon;
        if (beforeExpiry <= Date.now()) failures.push("lease expiry is not ahead of the owner");
        else {
          await new Promise((r) => setTimeout(r, beforeExpiry - Date.now()));
          sweeping = true;
          await engine.recoverSaved();
          sweeping = false;
          if ((await store.read()).pending.length !== 1) failures.push("swept at lease expiry minus epsilon");
          if (Date.now() >= leased.leaseExp) failures.push("sweep ran after the lease expired");
        }
      }
      return reply(path, init);
    },
  });
  const now = Math.floor(Date.now() / 1000);
  try {
    const offer = await engine.offer({ site: "s", cls: "write", amount_msat: 10000, now });
    const token = cashuAFull(mint.url, mint.keysetId, mint.token(10));
    await assert.rejects(
      () => engine.verifyPaid({ site: "s", now, firstUse: async () => true, proof: { kind: "cashu", offer_id: offer.id, credential: offer.credential, token } }),
      (e: unknown) => e instanceof TollError && (e.code === "bad_solution" || e.code === "store_unavailable"),
    );
    assert.equal(n, 7, "complete() did not make seven mint calls");
    assert.deepEqual(failures, []);
    const end = await store.books();
    assert.equal(end.stored + end.pending + end.losses, mint.signedSats());
    assert.equal(mint.signedSats(), 0);
    assert.equal(end.pending, 0);
  } finally {
    await mint.close();
  }

  function reply(path: string, init: RequestInit | undefined): Response {
    const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) as { outputs?: { amount: number }[]; Ys?: string[] } : {};
    const headers = { "content-type": "application/json" };
    if (path.endsWith("/v1/swap")) {
      const signatures = (reqBody.outputs ?? []).map((o) => ({ amount: o.amount, C_: "02" + "ab".repeat(32) }));
      return new Response(JSON.stringify({ signatures }), { status: 200, headers });
    }
    if (path.includes("/v1/keys/")) return new Response("no", { status: 500 });
    if (path.endsWith("/v1/restore")) return new Response(JSON.stringify({ outputs: [], signatures: [] }), { status: 200, headers });
    const states = (reqBody.Ys ?? []).map((Y) => ({ Y, state: "UNSPENT" }));
    return new Response(JSON.stringify({ states }), { status: 200, headers });
  }
});

test("a 200 restore body that is not a signature list is logged without secrets", async () => {
  const mint = await startKeysetMint();
  const dir = mkdtempSync(join(tmpdir(), "toll-cashu-shape-"));
  const store = new FileProofStore(join(dir, "proofs.json"));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); orig(...a); };
  const engine = new CashuReceiveEngine({ secret: "cashu-receive-test-secret", mints: [mint.url], store, loopbackHttp: true });
  const now = Math.floor(Date.now() / 1000);
  mint.setFault("/v1/swap", "refuse");
  mint.setFault("/v1/restore", "malformed");
  try {
    const offer = await engine.offer({ site: "s", cls: "write", amount_msat: 10000, now });
    const token = cashuAFull(mint.url, mint.keysetId, mint.token(10));
    const secret = decodeToken(token).proofs[0].secret;
    await assert.rejects(
      () => engine.verifyPaid({ site: "s", now, firstUse: async () => true, proof: { kind: "cashu", offer_id: offer.id, credential: offer.credential, token } }),
      (e: unknown) => e instanceof TollError && e.code === "store_unavailable",
    );
    const notes = lines.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
      .filter((row) => row.event === "mint_inconclusive" && row.check === "restore");
    assert.ok(notes.length > 0);
    assert.equal(notes[0].status, 200);
    assert.ok(Array.isArray(notes[0].shape?.keys) && notes[0].shape.keys.includes("wat"));
    const blob = lines.join("\n");
    assert.equal(blob.includes(secret), false);
    assert.equal(/"C"\s*:/.test(blob), false);
    assert.equal(blob.includes("cashuA"), false);
  } finally {
    console.log = orig;
    await mint.close();
  }
});

test("NUT-07 PENDING is not UNSPENT, so the blinded outputs stay", async () => {
  const mint = await startKeysetMint();
  const dir = mkdtempSync(join(tmpdir(), "toll-cashu-pending-"));
  const store = new FileProofStore(join(dir, "proofs.json"));
  const engine = new CashuReceiveEngine({ secret: "cashu-receive-test-secret", mints: [mint.url], store, loopbackHttp: true });
  const now = Math.floor(Date.now() / 1000);
  mint.setFault("/v1/swap", "refuse");
  mint.setFault("/v1/checkstate", "pending");
  try {
    const offer = await engine.offer({ site: "s", cls: "write", amount_msat: 10000, now });
    const token = mint.token(10);
    await assert.rejects(
      () => engine.verifyPaid({ site: "s", now, firstUse: async () => true, proof: { kind: "cashu", offer_id: offer.id, credential: offer.credential, token } }),
      (e: unknown) => e instanceof TollError && e.code === "store_unavailable",
    );
    const mid = await store.read();
    assert.equal(mid.pending.length, 1);
    assert.equal(mid.pending[0].outSats, 10);
    assert.equal(mid.spent.length, 0);
  } finally {
    mint.setFault(null, null);
    await mint.close();
  }
});

/** One 8-unit note, and that note plus a 2-unit note. The sets share an input and are not equal. */
function overlappingTokens(mint: Awaited<ReturnType<typeof startKeysetMint>>) {
  const eight = decodeToken(mint.token(8));
  const two = decodeToken(mint.token(2));
  const small = encodeTokenV4({ mint: mint.url, unit: eight.unit, proofs: eight.proofs });
  const large = encodeTokenV4({ mint: mint.url, unit: eight.unit, proofs: [...eight.proofs, ...two.proofs] });
  return { small, large };
}

test("overlap guard: two receives that share an input grant one pass", async () => {
  const mint = await startKeysetMint();
  const dir = mkdtempSync(join(tmpdir(), "toll-overlap-"));
  const proofs = new FileProofStore(join(dir, "proofs.json"));
  const now = 1_790_000_000;
  const replay = new MemoryStore(() => now);
  const engine = new CashuReceiveEngine({ secret: "cashu-receive-test-secret", mints: [mint.url], store: proofs, loopbackHttp: true });
  try {
    const { small, large } = overlappingTokens(mint);
    const search = await engine.offer({ site: "s", cls: "search", amount_msat: 2000, now });
    const write = await engine.offer({ site: "s", cls: "write", amount_msat: 8000, now });
    const firstUse = (key: string, ttl: number) => replay.firstUse(key, ttl);
    const pay = (offer: { id: string; credential: string }, token: string) => engine.verifyPaid({
      site: "s", now: now + 1, firstUse,
      proof: { kind: "cashu", offer_id: offer.id, credential: offer.credential, token },
    });
    const results = await Promise.allSettled([pay(search, small), pay(write, large)]);
    const granted = results.filter((r) => r.status === "fulfilled");
    const books = await proofs.books();
    assert.equal(granted.length, 1, `granted=${granted.length} signed=${mint.signedSats()} stored=${books.stored}`);
    for (const r of results) {
      if (r.status === "rejected") assert.ok(r.reason instanceof TollError && r.reason.code === "replay");
    }
    assert.equal(books.pending, 0);
    assert.equal(books.inSats, books.stored + books.pending + books.losses);
    assert.equal(books.stored, mint.signedSats());
  } finally {
    await mint.close();
  }
});

test("overlap guard: N parallel receives that share an input grant one pass", async () => {
  const mint = await startKeysetMint();
  const dir = mkdtempSync(join(tmpdir(), "toll-overlap-n-"));
  const proofs = new FileProofStore(join(dir, "proofs.json"));
  const now = 1_790_000_000;
  const replay = new MemoryStore(() => now);
  const engine = new CashuReceiveEngine({ secret: "cashu-receive-test-secret", mints: [mint.url], store: proofs, loopbackHttp: true });
  const N = 8;
  try {
    const { small, large } = overlappingTokens(mint);
    const firstUse = (key: string, ttl: number) => replay.firstUse(key, ttl);
    const offers = [];
    for (let i = 0; i < N; i++) offers.push(await engine.offer({ site: "s", cls: i === 0 ? "write" : "search", amount_msat: i === 0 ? 8000 : 2000, now }));
    const results = await Promise.allSettled(offers.map((offer, i) => engine.verifyPaid({
      site: "s", now: now + 1, firstUse,
      proof: { kind: "cashu", offer_id: offer.id, credential: offer.credential, token: i === 0 ? large : small },
    })));
    const granted = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(granted, 1, `granted=${granted}`);
    for (const r of results) {
      if (r.status === "rejected") {
        assert.ok(r.reason instanceof TollError, "a refused receive is not a 500");
        assert.equal(r.reason.code, "replay");
      }
    }
    const books = await proofs.books();
    assert.equal(books.pending, 0);
    assert.equal(books.inSats, books.stored + books.pending + books.losses);
    assert.equal(books.stored, mint.signedSats());
  } finally {
    await mint.close();
  }
});

test("overlap guard: N parallel HTTP receives on the memory replay store return one 200", async () => {
  const mint = await startKeysetMint();
  const dir = mkdtempSync(join(tmpdir(), "toll-overlap-http-"));
  const proofs = new FileProofStore(join(dir, "proofs.json"));
  const engine = new CashuReceiveEngine({ secret: "cashu-receive-test-secret", mints: [mint.url], store: proofs, loopbackHttp: true });
  const demo = await startDemo({
    work: { standard: { cost: 500 } },
    settlement: { enabled: true, backend: "stub", fee_bps: 1000, fx: { source: "fixed", usd_per_btc: 100000 }, cashu: { enabled: true, mint: mint.url } },
  }, { settlement: { engine } });
  const N = 8;
  try {
    const { small, large } = overlappingTokens(mint);
    const post = async (path: string, token: string) => {
      const r = await fetch(demo.url + path, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", "x-cashu": token },
        body: "{}",
      });
      const text = await r.text();
      let body: any = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
      return { status: r.status, body };
    };
    const results = await Promise.all(Array.from({ length: N }, (_, i) => post(i === 0 ? "/contact" : "/search", i === 0 ? large : small)));
    const ok = results.filter((r) => r.status === 200);
    const crashed = results.filter((r) => r.status >= 500);
    assert.equal(crashed.length, 0, JSON.stringify(results.map((r) => r.status)));
    assert.equal(ok.length, 1, JSON.stringify(results.map((r) => [r.status, r.body?.error])));
    for (const r of results) if (r.status !== 200) assert.ok(r.status >= 400 && r.status < 500);
    const books = await proofs.books();
    assert.equal(books.pending, 0);
    assert.equal(books.inSats, books.stored + books.pending + books.losses);
    assert.equal(books.stored, mint.signedSats());
    assert.equal(typeof ok[0].body.pass, "string");
  } finally {
    await demo.close();
    await mint.close();
  }
});

test("overlap guard: a claimed row keeps its lease until the mint answers", async () => {
  const mint = await startKeysetMint();
  const dir = mkdtempSync(join(tmpdir(), "toll-overlap-lease-"));
  const proofs = new FileProofStore(join(dir, "proofs.json"));
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  const engine = new CashuReceiveEngine({
    secret: "cashu-receive-test-secret",
    mints: [mint.url],
    store: proofs,
    loopbackHttp: true,
    beforeSwap: async () => {
      if (!held) {
        held = true;
        await gate;
      }
    },
  });
  const now = 1_790_000_000;
  const replay = new MemoryStore(() => now);
  const firstUse = (key: string, ttl: number) => replay.firstUse(key, ttl);
  try {
    const eight = decodeToken(mint.token(8));
    const two = decodeToken(mint.token(2));
    const large = encodeTokenV4({ mint: mint.url, unit: eight.unit, proofs: [...eight.proofs, ...two.proofs] });
    const small = encodeTokenV4({ mint: mint.url, unit: eight.unit, proofs: eight.proofs });
    const write = await engine.offer({ site: "s", cls: "write", amount_msat: 10000, now });
    const search = await engine.offer({ site: "s", cls: "search", amount_msat: 2000, now });
    const first = engine.verifyPaid({
      site: "s", now: now + 1, firstUse,
      proof: { kind: "cashu", offer_id: write.id, credential: write.credential, token: large },
    });
    const deadline = Date.now() + 5_000;
    let row = (await proofs.read()).pending[0];
    while (!row) {
      if (Date.now() > deadline) throw new Error("the claim was not saved");
      await new Promise((r) => setTimeout(r, 5));
      row = (await proofs.read()).pending[0];
    }
    assert.equal(row.outSats, 10);
    assert.ok(typeof row.leaseExp === "number" && row.leaseExp > Date.now(), "the claim write leases the row");
    const claimed = row.id;
    await assert.rejects(
      engine.verifyPaid({
        site: "s", now: now + 1, firstUse,
        proof: { kind: "cashu", offer_id: search.id, credential: search.credential, token: small },
      }),
      (e: unknown) => e instanceof TollError && e.code === "replay",
    );
    const mid = await proofs.read();
    assert.equal(mid.pending.length, 1);
    assert.equal(mid.pending[0].id, claimed, "an overlapping receive must not abort the claimed row");
    release();
    const paid = await first;
    assert.equal(paid.amount_msat, 10000);
    const books = await proofs.books();
    assert.equal(books.pending, 0);
    assert.equal(books.stored + books.pending + books.losses, mint.signedSats());
    assert.equal(books.stored, mint.signedSats());
    assert.equal(books.stored, 10);
  } finally {
    release();
    await mint.close();
  }
});
