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
import { fromB64url } from "../packages/protocol/src/bytes.ts";
import { cborDecode } from "../packages/settlement-ln/src/cbor.ts";
import { decodePaymentRequest, decodeTokenV4, encodeTokenV4 } from "../packages/settlement-ln/src/cashu.ts";
import { startKeysetMint } from "../packages/settlement-ln/src/keyset-mint.ts";
import { guardMintUrl } from "../packages/settlement-ln/src/cashu-net.ts";
import { solveWork } from "../packages/work-adapter/src/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MINT = "https://mint.minibits.cash/Bitcoin";
const SECRET = "edge-cashu-test-secret-0001";
const UNLISTED = "https://evil.example/Bitcoin";

let wr: ChildProcess;
let base = "";
let mint: Awaited<ReturnType<typeof startKeysetMint>>;

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
  let log = "";
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("wrangler dev did not start:\n" + log)), 90_000);
    const on = (c: Buffer) => { log += c.toString(); if (/Ready on http/.test(log)) { clearTimeout(t); resolve(); } };
    wr.stdout!.on("data", on);
    wr.stderr!.on("data", on);
    wr.on("exit", (code) => { clearTimeout(t); reject(new Error("wrangler dev exited " + code + "\n" + log)); });
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

/** stored + pending covers every sat the mint has signed, and this scenario booked no loss. */
function holds(before: { stored: number; pending: number; losses: number }, after: { stored: number; pending: number; losses: number }, signedBefore: number) {
  const signed = mint.signedSats() - signedBefore;
  const kept = (after.stored - before.stored) + (after.pending - before.pending);
  assert.equal(kept, signed, "stored + pending must equal the sats the mint signed");
  assert.equal(after.losses, before.losses);
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
    holds(before, mid, signed);
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
    holds(before, mid, signed);
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
    holds(before, mid, signed);
    mint.setFault("/v1/restore", "nosig");
    mint.setFault("/v1/checkstate", "pending");
    const retry = await pay(token);
    assert.equal(retry.status, 503, retry.text);
    assert.notEqual(retry.body.error, "replay");
    const still = await books();
    holds(before, still, signed);
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
    holds(before, mid, signed);
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
    holds(before, mid, signed);
    assert.equal(mid.pending, before.pending + 10);
    assert.equal(mid.losses, before.losses);
    await finish(token, before);
  }
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
