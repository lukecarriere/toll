// Cashu receive on the toll-site worker (miniflare via wrangler dev --local). No deploy.
// The allowlist is the Minibits mint. Fetch to that host is proxied to a loopback stub so the
// suite does not spend and does not need the public mint to be up.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { fromB64url, toB64url, toHex, utf8 } from "../packages/protocol/src/bytes.ts";
import { cborDecode } from "../packages/settlement-ln/src/cbor.ts";
import { decodePaymentRequest, decodeToken, decodeTokenV4, encodeTokenV3, encodeTokenV4 } from "../packages/settlement-ln/src/cashu.ts";
import { CashuReceiveEngine } from "../packages/settlement-ln/src/cashu-receive.ts";
import { startKeysetMint } from "../packages/settlement-ln/src/keyset-mint.ts";
import { guardMintUrl } from "../packages/settlement-ln/src/cashu-net.ts";
import type { PendingSwap, ProofStore, StoredProof } from "../packages/settlement-ln/src/cashu-store.ts";
import { TollError } from "../packages/protocol/src/errors.ts";
import { solveWork } from "../packages/work-adapter/src/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MINT = "https://mint.minibits.cash/Bitcoin";
const SECRET = "edge-cashu-test-secret-0001";
const UNLISTED = "https://evil.example/Bitcoin";

let wr: ChildProcess;
let base = "";
let wrLog = "";
let mint: Awaited<ReturnType<typeof startKeysetMint>>;

/** cashuA whose keyset id is the mint's full 33-byte id, the shape a wallet sends as-is. */
function cashuA(token: string): string {
  const decoded = decodeToken(token);
  const obj = {
    token: [{
      mint: MINT,
      proofs: decoded.proofs.map((p) => ({ amount: p.amount, id: mint.keysetId, secret: p.secret, C: toHex(p.C) })),
    }],
    unit: decoded.unit,
  };
  return "cashuA" + toB64url(utf8(JSON.stringify(obj)));
}

function retarget(token: string, mintUrl: string): string {
  const decoded = decodeTokenV4(token);
  return encodeTokenV4({ mint: mintUrl, unit: decoded.unit, proofs: decoded.proofs });
}

async function read(res: Response): Promise<{ status: number; headers: Headers; body: any; text: string }> {
  const text = await res.text();
  let body: any = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  return { status: res.status, headers: res.headers, body, text };
}

function call(path: string, init: RequestInit = {}) {
  return fetch(base + path, init).then(read);
}

before(async () => {
  execFileSync(process.execPath, [ROOT + "website/build.mjs"], { cwd: ROOT });
  execFileSync(process.execPath, [ROOT + "packages/edge-cf/build.mjs"], { cwd: ROOT });
  mint = await startKeysetMint();
  writeFileSync(ROOT + ".dev.vars", `SITE_SECRET="${SECRET}"\nTOLL_TEST_HOOKS=1\nCASHU_FETCH_PROXY="${mint.url}"\n`, { mode: 0o600 });
  const free = await new Promise<number>((r) => { const t = createServer().listen(0, "127.0.0.1", () => { const p = (t.address() as AddressInfo).port; t.close(() => r(p)); }); });
  const persist = mkdtempSync(join(tmpdir(), "toll-edge-cashu-"));
  const bin = ROOT + "node_modules/.bin/wrangler";
  wr = spawn(bin, ["dev", "--local", "--ip", "127.0.0.1", "--port", String(free), "--persist-to", persist, "--show-interactive-dev-session=false"], {
    cwd: ROOT,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  wrLog = "";
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("wrangler dev did not start:\n" + wrLog)), 90_000);
    const on = (c: Buffer) => { wrLog += c.toString(); if (/Ready on http/.test(wrLog)) { clearTimeout(t); resolve(); } };
    wr.stdout!.on("data", on);
    wr.stderr!.on("data", on);
    wr.on("exit", (code) => { clearTimeout(t); reject(new Error("wrangler dev exited " + code + "\n" + wrLog)); });
  });
  wr.removeAllListeners("exit");
  base = `http://127.0.0.1:${free}`;
});

after(async () => {
  wr?.kill("SIGTERM");
  rmSync(ROOT + ".dev.vars", { force: true });
  await mint?.close();
});

function booksOk(b: { inSats: number; stored: number; pending: number; losses: number }) {
  assert.equal(b.inSats, b.stored + b.pending + b.losses);
}

test("a private or http mint is refused before it is fetched", async () => {
  await assert.rejects(guardMintUrl("http://pay.example.com/Bitcoin", [MINT], { lookup: async () => ["1.1.1.1"] }), /must be https/);
  await assert.rejects(guardMintUrl("https://10.0.0.8/Bitcoin", ["https://10.0.0.8/Bitcoin"], { lookup: async () => ["1.1.1.1"] }), /not public/);
  await assert.rejects(guardMintUrl(UNLISTED, [MINT], { lookup: async () => ["1.1.1.1"] }), /allowlist/);
});

test("health and the manifest report Cashu, and an agent 402 carries a creqA naming the allowlisted mint", async () => {
  const health = await call("/v1/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.settlement, "cashu");
  assert.equal(health.body.edge, true);
  assert.equal(health.body.settlement_degraded, false);
  const manifest = await call("/.well-known/toll.json");
  assert.equal(manifest.status, 200);
  const gate = manifest.body.tools[1];
  assert.equal(gate.payment.status, "cashu");
  assert.equal(gate.payment.methods[0].kind, "cashu");
  assert.equal(gate.price.status, "cashu");
  assert.equal(gate.price.amount_msat, 10000);

  const denied = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent" },
    body: "{}",
  });
  assert.equal(denied.status, 402);
  const header = denied.headers.get("x-cashu") ?? "";
  assert.ok(header.startsWith("creqA"));
  const req = decodePaymentRequest(header);
  assert.equal(req.a, 10);
  assert.equal(req.u, "sat");
  assert.equal(req.s, true);
  assert.equal(typeof req.i, "string");
  assert.ok(req.m.includes(MINT));
  const raw = cborDecode(fromB64url(header.slice(5))) as Record<string, unknown>;
  assert.equal("t" in raw, false);
  assert.deepEqual(Object.keys(raw).sort(), ["a", "i", "m", "s", "u"]);
  assert.equal(denied.body.error, "payment_required");
  assert.equal(denied.body.offers[0].kind, "cashu");
  assert.equal(denied.body.offers[0].mint, MINT);
});

test("a payment is accepted, the input is marked spent, and a replay is rejected before another swap", async () => {
  const before = await call("/v1/test/cashu-books");
  const swaps = mint.swaps();
  const denied = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent" },
    body: "{}",
  });
  assert.equal(denied.status, 402);
  const token = retarget(mint.token(10), MINT);
  const paid = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", "x-cashu": token },
    body: "{}",
  });
  assert.equal(paid.status, 200, paid.text);
  assert.equal(paid.body.rail, "settle");
  assert.equal(typeof paid.body.pass, "string");
  const after = await call("/v1/test/cashu-books");
  booksOk(after.body);
  assert.equal(after.body.stored, before.body.stored + 10);
  assert.equal(after.body.pending, before.body.pending);
  const inputs = decodeTokenV4(token).proofs.length;
  assert.equal(after.body.spent, before.body.spent + inputs);
  assert.equal(mint.swaps(), swaps + 1);

  const again = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", "x-cashu": token },
    body: "{}",
  });
  assert.equal(again.status, 401);
  assert.equal(again.body.error, "replay");
  assert.equal(mint.swaps(), swaps + 1, "the spent input is refused from the store");
  const held = await call("/v1/test/cashu-books");
  assert.equal(held.body.stored, after.body.stored);
});

test("parallel receives that share an input: one 200 from the durable object, the rest 4xx, no 500", async () => {
  const before = await call("/v1/test/cashu-books");
  const signedBefore = mint.signedSats();
  const eight = decodeToken(retarget(mint.token(8), MINT));
  const two = decodeToken(retarget(mint.token(2), MINT));
  const searchTok = encodeTokenV4({ mint: MINT, unit: eight.unit, proofs: eight.proofs });
  const writeTok = encodeTokenV4({ mint: MINT, unit: eight.unit, proofs: [...eight.proofs, ...two.proofs] });
  const N = 8;
  const results = await Promise.all(Array.from({ length: N }, (_, i) => call(i === 0 ? "/demo/contact" : "/search", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", "x-cashu": i === 0 ? writeTok : searchTok },
    body: "{}",
  })));
  const ok = results.filter((r) => r.status === 200);
  const crashed = results.filter((r) => r.status >= 500);
  assert.equal(crashed.length, 0, JSON.stringify(results.map((r) => [r.status, r.body?.error])));
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => [r.status, r.body?.error])));
  for (const r of results) if (r.status !== 200) assert.ok(r.status >= 400 && r.status < 500, String(r.status));
  assert.equal(typeof ok[0].body.pass, "string");
  const after = await call("/v1/test/cashu-books");
  booksOk(after.body);
  const signed = mint.signedSats() - signedBefore;
  assert.equal(after.body.pending, before.body.pending);
  assert.equal(after.body.stored - before.body.stored, signed);
  assert.equal(after.body.inSats - before.body.inSats, signed);
});

test("a claimed durable-object row keeps its lease until the mint answers", async () => {
  const before = await books();
  const signedBefore = mint.signedSats();
  const parts = decodeToken(retarget(mint.token(10), MINT));
  const shared = parts.proofs[0];
  const large = encodeTokenV4({ mint: MINT, unit: parts.unit, proofs: parts.proofs });
  const small = encodeTokenV4({ mint: MINT, unit: parts.unit, proofs: [shared] });
  const held = pay(large, "hold-before-swap");
  const deadline = Date.now() + 5_000;
  let pending = before.pending;
  while (pending === before.pending) {
    if (Date.now() > deadline) throw new Error("the claim was not saved");
    await new Promise((r) => setTimeout(r, 20));
    pending = (await books()).pending;
  }
  assert.equal(pending, before.pending + 10);
  const overlap = await call("/search", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", "x-cashu": small },
    body: "{}",
  });
  assert.equal(overlap.status, 401, overlap.text);
  assert.equal(overlap.body.error, "replay");
  const mid = await books();
  booksOk(mid);
  assert.equal(mid.pending, before.pending + 10, "an overlapping receive must not abort the claimed row");
  assert.equal(mid.stored, before.stored);
  const released = await call("/v1/test/release-hold", { method: "POST" });
  assert.equal(released.status, 200, released.text);
  const paid = await held;
  assert.equal(paid.status, 200, paid.text);
  assert.equal(typeof paid.body.pass, "string");
  const after = await books();
  booksOk(after);
  holds(after);
  const signed = mint.signedSats() - signedBefore;
  assert.equal(after.pending, before.pending);
  assert.equal(after.stored - before.stored, signed);
  assert.equal(after.stored - before.stored, 10);
  assert.equal(after.losses, before.losses);
});

test("an unlisted mint is refused and not fetched", async () => {
  await call("/v1/test/mint-fetches");
  const denied = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent" },
    body: "{}",
  });
  assert.equal(denied.status, 402);
  await call("/v1/test/mint-fetches");
  const token = retarget(mint.token(10), UNLISTED);
  const refused = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", "x-cashu": token },
    body: "{}",
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "malformed");
  assert.equal(typeof refused.body.pass, "undefined");
  const seen = await call("/v1/test/mint-fetches");
  assert.equal(seen.body.urls.some((u: string) => u.includes("evil.example")), false);
});

test("a cashuA token pays, a replay is rejected, a short keyset id is mapped, and an unlisted mint is refused", async () => {
  const denied = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent" },
    body: "{}",
  });
  assert.equal(denied.status, 402);
  const raw = decodeToken(mint.token(10));
  const token = encodeTokenV3({ ...raw, mint: MINT });
  const short = toHex(decodeToken(token).proofs[0].id);
  assert.equal(short.length, 16);
  const swaps = mint.swaps();
  const paid = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", "x-cashu": token },
    body: "{}",
  });
  assert.equal(paid.status, 200, paid.text);
  assert.equal(paid.body.rail, "settle");
  assert.equal(mint.lastInputIds()[0].length, 66);
  assert.ok(mint.lastInputIds()[0].startsWith(short));
  const again = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", "x-cashu": token },
    body: "{}",
  });
  assert.equal(again.status, 401);
  assert.equal(again.body.error, "replay");
  assert.equal(mint.swaps(), swaps + 1);

  await call("/v1/test/mint-fetches");
  const foreign = encodeTokenV3({ ...decodeToken(mint.token(10)), mint: UNLISTED });
  const refused = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", "x-cashu": foreign },
    body: "{}",
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "malformed");
  const seen = await call("/v1/test/mint-fetches");
  assert.equal(seen.body.urls.some((u: string) => u.includes("evil.example")), false);

  const both = decodeToken(mint.token(10));
  const v4 = encodeTokenV4({ mint: MINT, unit: both.unit, proofs: both.proofs });
  const paidB = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", "x-cashu": v4 },
    body: "{}",
  });
  assert.equal(paidB.status, 200, paidB.text);
});

test("uppercase C_ is accepted", async () => {
  mint.setFault("/v1/swap", "uppercase");
  try {
    const denied = await call("/demo/contact", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent" },
      body: "{}",
    });
    assert.equal(denied.status, 402);
    const before = await call("/v1/test/cashu-books");
    const token = retarget(mint.token(10), MINT);
    const paid = await call("/demo/contact", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", "x-cashu": token },
      body: "{}",
    });
    assert.equal(paid.status, 200, paid.text);
    const after = await call("/v1/test/cashu-books");
    booksOk(after.body);
    assert.equal(after.body.stored, before.body.stored + 10);
  } finally {
    mint.setFault(null, null);
  }
});

test("a crash after the swap and before the save loses no proofs", async () => {
  const before = await call("/v1/test/cashu-books");
  const denied = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent" },
    body: "{}",
  });
  assert.equal(denied.status, 402);
  const token = retarget(mint.token(10), MINT);
  const crashed = await call("/demo/contact", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "toll-client": "agent",
      "x-cashu": token,
      "x-toll-cashu-fault": "crash-after-swap",
    },
    body: "{}",
  });
  assert.equal(crashed.status, 503, crashed.text);
  assert.equal(crashed.body.pass, undefined);
  const mid = await call("/v1/test/cashu-books");
  booksOk(mid.body);
  assert.equal(mid.body.stored, before.body.stored);
  assert.equal(mid.body.pending, before.body.pending + 10);
  const restored = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", "x-cashu": token },
    body: "{}",
  });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.body.rail, "settle");
  const after = await call("/v1/test/cashu-books");
  booksOk(after.body);
  assert.equal(after.body.stored, before.body.stored + 10);
  assert.equal(after.body.pending, before.body.pending);
  assert.equal(after.body.losses, before.body.losses);
});

async function books(): Promise<{ stored: number; pending: number; losses: number; inSats: number; spent: number }> {
  const r = await call("/v1/test/cashu-books");
  assert.equal(r.status, 200, r.text);
  return r.body;
}

/** Sats the mint has signed equal stored proofs plus pending outputs plus recorded losses. */
function holds(after: { stored: number; pending: number; losses: number }) {
  assert.equal(after.stored + after.pending + after.losses, mint.signedSats(), "signed sats must equal stored + pending + losses");
}

async function freshToken(): Promise<string> {
  const denied = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent" },
    body: "{}",
  });
  assert.equal(denied.status, 402, denied.text);
  return retarget(mint.token(10), MINT);
}

function pay(token: string, fault?: string) {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "toll-client": "agent",
    "x-cashu": token,
  };
  if (fault) headers["x-toll-cashu-fault"] = fault;
  return call("/demo/contact", { method: "POST", headers, body: "{}" });
}

test("conservation: inconclusive mint results keep the blinded outputs", async () => {
  async function finish(token: string, before: { stored: number; pending: number }) {
    mint.setFault(null, null);
    mint.setDown(false);
    const done = await pay(token);
    assert.equal(done.status, 200, done.text);
    const after = await books();
    assert.equal(after.stored, before.stored + 10);
    assert.equal(after.pending, before.pending);
    assert.equal(after.losses, 0);
    assert.equal(after.stored + after.pending, mint.signedSats());
  }

  // Reset after the mint has read the body and signed. Restore has no usable signatures. Inputs are SPENT.
  {
    mint.setFault("/v1/swap", "drop-after");
    mint.setFault("/v1/restore", "nosig");
    const before = await books();
    const signed = mint.signedSats();
    const token = await freshToken();
    const failed = await pay(token);
    assert.equal(failed.status, 503, failed.text);
    assert.equal(failed.body.pass, undefined);
    const mid = await books();
    holds(mid);
    assert.equal(mid.pending, before.pending + 10);
    assert.equal(mid.spent, before.spent);
    await finish(token, before);
  }

  // Partial restore, then a malformed restore. Neither is a reason to drop the outputs.
  for (const mode of ["partial", "malformed"] as const) {
    mint.setFault("/v1/swap", "drop-after");
    mint.setFault("/v1/restore", mode);
    const before = await books();
    const signed = mint.signedSats();
    const token = await freshToken();
    const failed = await pay(token);
    assert.equal(failed.status, 503, failed.text + " " + mode);
    const mid = await books();
    holds(mid);
    assert.equal(mid.pending, before.pending + 10);
    await finish(token, before);
  }

  // Retry after crash-after-swap: 11001, empty restore, checkstate PENDING. Do not abort.
  {
    const before = await books();
    const signed = mint.signedSats();
    const token = await freshToken();
    const crashed = await pay(token, "crash-after-swap");
    assert.equal(crashed.status, 503, crashed.text);
    const mid = await books();
    holds(mid);
    mint.setFault("/v1/restore", "nosig");
    mint.setFault("/v1/checkstate", "pending");
    const retry = await pay(token);
    assert.equal(retry.status, 503, retry.text);
    assert.notEqual(retry.body.error, "replay");
    const still = await books();
    holds(still);
    assert.equal(still.pending, before.pending + 10);
    assert.equal(still.spent, before.spent);
    await finish(token, before);
  }

  // Mint down after the outputs are saved. Pending stays, then a live mint stores them.
  {
    const before = await books();
    const signed = mint.signedSats();
    const token = await freshToken();
    const crashed = await pay(token, "crash-after-swap");
    assert.equal(crashed.status, 503, crashed.text);
    mint.setDown(true);
    const down = await pay(token);
    assert.equal(down.status, 503, down.text);
    const mid = await books();
    holds(mid);
    assert.equal(mid.pending, before.pending + 10);
    await finish(token, before);
  }

  // Crash before the proof write. The mint has signed; the pending row is the recoverable set.
  {
    const before = await books();
    const signed = mint.signedSats();
    const token = await freshToken();
    const dropped = await pay(token, "drop-commit");
    assert.equal(dropped.status, 503, dropped.text);
    assert.equal(dropped.body.pass, undefined);
    const mid = await books();
    holds(mid);
    assert.equal(mid.pending, before.pending + 10);
    assert.equal(mid.losses, before.losses);
    await finish(token, before);
  }

  // The mint committed, then the connection dropped. checkstate is forced UNSPENT.
  // nosig, empty, and partial restores are not a reason to abort.
  for (const mode of ["nosig", "empty", "partial"] as const) {
    mint.setFault("/v1/swap", "drop-after");
    mint.setFault("/v1/restore", mode);
    mint.setFault("/v1/checkstate", "unspent");
    const before = await books();
    const token = await freshToken();
    const failed = await pay(token);
    assert.equal(failed.status, 503, failed.text + " " + mode);
    assert.equal(failed.body.pass, undefined);
    const mid = await books();
    holds(mid);
    assert.equal(mid.pending, before.pending + 10);
    assert.equal(mid.losses, before.losses);
    await finish(token, before);
  }

  // After the mint commits, a 5xx, a 429, or a 4xx that does not parse is not a refusal.
  for (const swap of ["http-500-json", "http-500-text", "http-502", "http-503", "http-429", "http-400-text"] as const) {
    for (const restore of ["nosig", "empty"] as const) {
      mint.setFault("/v1/swap", swap);
      mint.setFault("/v1/restore", restore);
      mint.setFault("/v1/checkstate", "unspent");
      const before = await books();
      const token = await freshToken();
      const failed = await pay(token);
      assert.equal(failed.status, 503, failed.text + " " + swap + " " + restore);
      assert.equal(failed.body.pass, undefined);
      const mid = await books();
      holds(mid);
      assert.equal(mid.pending, before.pending + 10, swap + " " + restore);
      assert.equal(mid.losses, before.losses);
      await finish(token, before);
    }
  }

  // The mint signed, then returned 11000, 11002, 11003, or 11004. Those codes do not abort.
  for (const code of [11000, 11002, 11003, 11004]) {
    mint.setSignedReply({ status: 400, body: JSON.stringify({ detail: "mint", code }), type: "application/json" });
    mint.setFault("/v1/restore", "nosig");
    mint.setFault("/v1/checkstate", "unspent");
    const before = await books();
    const token = await freshToken();
    const failed = await pay(token);
    assert.equal(failed.status, 503, failed.text + " " + code);
    assert.notEqual(failed.body.error, "bad_solution");
    const mid = await books();
    holds(mid);
    assert.equal(mid.pending, before.pending + 10, String(code));
    assert.equal(mid.losses, before.losses);
    await finish(token, before);
  }

  // Conclusive empty restore, but checkstate is PENDING and the mint has signed. Do not abort.
  {
    mint.setSignedReply({ status: 400, body: JSON.stringify({ code: 11002 }), type: "application/json" });
    mint.setFault("/v1/restore", "zero");
    mint.setFault("/v1/checkstate", "pending");
    const before = await books();
    const token = await freshToken();
    const failed = await pay(token);
    assert.equal(failed.status, 503, failed.text);
    const mid = await books();
    holds(mid);
    assert.equal(mid.pending, before.pending + 10);
    await finish(token, before);
  }

  // The mint never signed. An empty signature list and all-UNSPENT inputs are the only abort.
  {
    mint.setFault("/v1/swap", "refuse");
    mint.setFault("/v1/checkstate", "unspent");
    const before = await books();
    const signed = mint.signedSats();
    const token = await freshToken();
    const failed = await pay(token);
    assert.equal(failed.status, 401, failed.text);
    assert.equal(failed.body.error, "bad_solution");
    const mid = await books();
    holds(mid);
    assert.equal(mid.pending, before.pending);
    assert.equal(mid.losses, before.losses);
    assert.equal(mint.signedSats(), signed);
    await finish(token, before);
  }

  // A dropped restore is not an empty signature list.
  {
    mint.setFault("/v1/swap", "drop-after");
    mint.setFault("/v1/restore", "network");
    mint.setFault("/v1/checkstate", "unspent");
    const before = await books();
    const token = await freshToken();
    const failed = await pay(token);
    assert.equal(failed.status, 503, failed.text);
    const mid = await books();
    holds(mid);
    assert.equal(mid.pending, before.pending + 10);
    await finish(token, before);
  }

  // The store would begin a second swap. verifyPaid's replay check is what stops it.
  {
    const local = await startKeysetMint();
    const store = looseStore();
    const engine = new CashuReceiveEngine({ secret: "cashu-receive-test-secret", mints: [local.url], store, loopbackHttp: true });
    const now = Math.floor(Date.now() / 1000);
    const firstUse = async () => true;
    try {
      const offer = await engine.offer({ site: "s", cls: "write", amount_msat: 10000, now });
      const token = local.token(10);
      await engine.verifyPaid({ site: "s", now, firstUse, proof: { kind: "cashu", offer_id: offer.id, credential: offer.credential, token } });
      const begins = store.begins();
      await assert.rejects(
        () => engine.verifyPaid({ site: "s", now, firstUse, proof: { kind: "cashu", offer_id: offer.id, credential: offer.credential, token } }),
        (e: unknown) => e instanceof TollError && e.code === "replay",
      );
      assert.equal(store.begins(), begins);
      const books = await store.books();
      assert.equal(books.stored + books.pending + books.losses, local.signedSats());
    } finally {
      await local.close();
    }
  }
});

const RESPONSE_STATUSES = ["transport", "timeout", 200, 400, 401, 404, 409, 422, 429, 500, 502, 503] as const;

const RESPONSE_BODIES: ReadonlyArray<{ name: string; raw: string; type: string }> = [
  { name: "plain", raw: "nope", type: "text/plain" },
  { name: "empty", raw: "", type: "text/plain" },
  { name: "invalid", raw: "{", type: "application/json" },
  { name: "object", raw: "{}", type: "application/json" },
  { name: "null", raw: "{\"code\":null}", type: "application/json" },
  { name: "zero", raw: "{\"code\":0}", type: "application/json" },
  { name: "negative", raw: "{\"code\":-1}", type: "application/json" },
  { name: "string", raw: "{\"code\":\"11002\"}", type: "application/json" },
  { name: "fraction", raw: "{\"code\":1.5}", type: "application/json" },
  { name: "detail", raw: "{\"detail\":\"nope\"}", type: "application/json" },
  { name: "11000", raw: "{\"code\":11000}", type: "application/json" },
  { name: "11002", raw: "{\"code\":11002}", type: "application/json" },
  { name: "11003", raw: "{\"code\":11003}", type: "application/json" },
  { name: "11004", raw: "{\"code\":11004}", type: "application/json" },
  { name: "11005", raw: "{\"code\":11005}", type: "application/json" },
  { name: "10002", raw: "{\"code\":10002}", type: "application/json" },
  { name: "20001", raw: "{\"code\":20001}", type: "application/json" },
  { name: "11001", raw: "{\"detail\":\"already spent\",\"code\":11001}", type: "application/json" },
];

const RESPONSE_CHECKS = ["UNSPENT", "PENDING", "SPENT", "unknown"] as const;

test("conservation: mint response matrix keeps every signed output", async () => {
  const local = await startKeysetMint();
  const store = matrixStore();
  let swapThrow: "timeout" | null = null;
  const engine = new CashuReceiveEngine({
    secret: "cashu-receive-test-secret",
    mints: [local.url],
    store,
    loopbackHttp: true,
    fetch: async (input, init) => {
      const res = await fetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (swapThrow && url.includes("/v1/swap")) {
        await res.body?.cancel();
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return res;
    },
  });
  const now = Math.floor(Date.now() / 1000);
  const firstUse = async () => true;
  let cells = 0;
  try {
    const offer = await engine.offer({ site: "s", cls: "write", amount_msat: 10000, now });
    for (const status of RESPONSE_STATUSES) {
      for (const body of RESPONSE_BODIES) {
        for (const check of RESPONSE_CHECKS) {
          const label = status + " " + body.name + " " + check;
          local.setFault(null, null);
          swapThrow = null;
          local.setFault("/v1/restore", "nosig");
          local.setFault("/v1/checkstate", check === "UNSPENT" ? "unspent" : check === "PENDING" ? "pending" : check === "SPENT" ? "spent" : "unknown");
          if (status === "transport") local.setFault("/v1/swap", "drop-after");
          else if (status === "timeout") swapThrow = "timeout";
          else local.setSignedReply({ status, body: body.raw, type: body.type });
          const before = await store.books();
          const signedBefore = local.signedSats();
          const abortsBefore = store.aborts();
          const token = local.token(10);
          const proof = { kind: "cashu" as const, offer_id: offer.id, credential: offer.credential, token };
          let error: unknown = null;
          try {
            await engine.verifyPaid({ site: "s", now, firstUse, proof });
          } catch (e) {
            error = e;
          }
          cells++;
          if (!(error instanceof TollError)) assert.fail(label + " " + String(error));
          const after = await store.books();
          assert.equal(local.signedSats() - signedBefore, 10, label);
          assert.equal(store.aborts(), abortsBefore, label);
          assert.equal(error.code, "store_unavailable", label);
          assert.equal(after.pending, before.pending + 10, label);
          assert.equal(after.losses, before.losses, label);
          assert.equal(after.stored + after.pending + after.losses, local.signedSats(), label);
          local.setFault(null, null);
          swapThrow = null;
          await engine.recoverSaved();
          const done = await store.books();
          assert.equal(done.pending, before.pending, label);
          assert.equal(done.stored, before.stored + 10, label);
          assert.equal(done.losses, before.losses, label);
          assert.equal(done.stored + done.pending + done.losses, local.signedSats(), label);
        }
      }
    }
    assert.equal(cells, RESPONSE_STATUSES.length * RESPONSE_BODIES.length * RESPONSE_CHECKS.length);
    const end = await store.books();
    assert.equal(end.pending, 0);
    assert.equal(store.aborts(), 0);
    assert.equal(end.stored + end.pending + end.losses, local.signedSats());
  } finally {
    await local.close();
  }
});

function matrixStore(): ProofStore & { aborts: () => number } {
  let proofs: StoredProof[] = [];
  let spent: string[] = [];
  let pending: PendingSwap[] = [];
  let losses = 0;
  let aborts = 0;
  return {
    aborts: () => aborts,
    async read() { return { proofs: proofs.slice(), spent: spent.slice(), pending: pending.slice(), losses }; },
    async books() {
      const stored = proofs.reduce((n, p) => n + p.amount, 0);
      const pendingSats = pending.reduce((n, p) => n + p.outSats, 0);
      return { stored, pending: pendingSats, losses, spent: spent.length, inSats: stored + pendingSats + losses };
    },
    async begin(p) {
      if (p.marks.some((h) => spent.includes(h))) throw new TollError("replay");
      const existing = pending.find((x) => x.marks.some((h) => p.marks.includes(h)));
      if (existing) return existing;
      pending.push(p);
      losses += p.inSats - p.outSats;
      return p;
    },
    async lease(id, owner, exp) {
      const row = pending.find((x) => x.id === id);
      if (!row || (row.owner !== undefined && row.owner !== owner)) return;
      if (row.at === undefined) row.at = Date.now();
      row.owner = owner;
      row.leaseExp = exp;
    },
    async commit(o) {
      if (!pending.some((x) => x.id === o.id)) throw new TollError("store_unavailable");
      proofs = proofs.concat(o.proofs);
      for (const h of o.marks) if (!spent.includes(h)) spent.push(h);
      pending = pending.filter((x) => x.id !== o.id);
    },
    async abort(id) {
      aborts++;
      const row = pending.find((x) => x.id === id);
      if (!row) return;
      losses -= row.inSats - row.outSats;
      if (losses < 0) losses = 0;
      pending = pending.filter((x) => x.id !== id);
    },
    async lose() { throw new Error("lose"); },
  };
}

function looseStore(): ProofStore & { begins: () => number } {
  let proofs: StoredProof[] = [];
  let spent: string[] = [];
  let pending: PendingSwap[] = [];
  let losses = 0;
  let begins = 0;
  return {
    begins: () => begins,
    async read() { return { proofs: proofs.slice(), spent: spent.slice(), pending: pending.slice(), losses }; },
    async books() {
      const stored = proofs.reduce((n, p) => n + p.amount, 0);
      const pendingSats = pending.reduce((n, p) => n + p.outSats, 0);
      return { stored, pending: pendingSats, losses, spent: spent.length, inSats: stored + pendingSats + losses };
    },
    async begin(p) { begins++; pending.push(p); losses += p.inSats - p.outSats; return p; },
    async lease(id, owner, exp) {
      const row = pending.find((x) => x.id === id);
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
    async lose(_o: { id: string; marks: string[] }) { throw new Error("lose"); },
  };
}

test("a cashuA redeem whose mint refuses in plain text is not an outage, and the swap is not left pending", async () => {
  const before = await books();
  const denied = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent" },
    body: "{}",
  });
  assert.equal(denied.status, 402, denied.text);
  const offer = denied.body.offers[0];
  const token = cashuA(mint.token(10));
  assert.equal(decodeToken(token).proofs[0].id.length, 33);
  const signed = mint.signedSats();
  mint.setFault("/v1/swap", "plain-422");
  try {
    const redeem = await call("/v1/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", "toll-client": "agent" },
      body: JSON.stringify({ offer_id: offer.id, kind: "cashu", token, credential: offer.credential }),
    });
    assert.equal(redeem.status, 401, redeem.text);
    assert.equal(redeem.body.error, "bad_solution");
    const after = await books();
    booksOk(after);
    assert.equal(after.pending, before.pending);
    assert.equal(after.stored, before.stored);
    assert.equal(after.losses, before.losses);
    assert.equal(mint.signedSats(), signed);
    holds(after);
    assert.match(wrLog, /"event":"mint"/);
    assert.equal(wrLog.includes(decodeToken(token).proofs[0].secret), false);
  } finally {
    mint.setFault(null, null);
  }
});

test("a cashuA swap the mint never took is cleared on the next request", async () => {
  const before = await books();
  const crashed = await pay(cashuA(mint.token(10)), "crash-before-swap");
  assert.equal(crashed.status, 503, crashed.text);
  assert.equal(crashed.body.error, "store_unavailable");
  const mid = await books();
  booksOk(mid);
  assert.equal(mid.pending, before.pending + 10);
  assert.equal(mid.stored, before.stored);
  const paid = await pay(cashuA(mint.token(10)));
  assert.equal(paid.status, 200, paid.text);
  const after = await books();
  booksOk(after);
  holds(after);
  assert.equal(after.pending, before.pending);
  assert.equal(after.stored, before.stored + 10);
  assert.equal(after.losses, before.losses);
});

test("check-live-state.sh sends the agent header, expects 402, and reads the gate tool", async () => {
  const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("sh", [ROOT + "scripts/check-live-state.sh", base]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /gate_form_write/);
  assert.match(r.stdout, /cashu/);
  assert.match(r.stdout, /\b402\b/);
});

test("a visitor without a payment still clears the work check", async () => {
  const denied = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, "toll_required");
  assert.equal(denied.body.challenge.alg, "pbkdf2-sha256");
  const solved = await solveWork(denied.body.challenge.work);
  assert.ok(solved);
  const redeem = await call("/v1/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challenge_id: denied.body.challenge.id,
      challenge: denied.body.challenge,
      solution: { work: { counter: solved.counter, derivedKey: solved.derivedKey }, took_ms: 1 },
    }),
  });
  assert.equal(redeem.status, 200, redeem.text);
  assert.equal(redeem.body.rail, "work");
  const ok = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", authorization: "Toll " + redeem.body.pass },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.ok, true);
});
