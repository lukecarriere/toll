// Owner books and withdraw through the built site worker under `wrangler dev --local`, with the
// loopback keyset mint behind the configured mint URL. OWNER_KEY is a test value in .dev.vars.
// No deploy, no real mint, no sats.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { randomHex } from "../packages/protocol/src/bytes.ts";
import { encodeBolt11 } from "../packages/settlement-ln/src/bolt11.ts";
import { decodeTokenV4, encodeTokenV4 } from "../packages/settlement-ln/src/cashu.ts";
import { startKeysetMint } from "../packages/settlement-ln/src/keyset-mint.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MINT = "https://mint.minibits.cash/Bitcoin";
const SECRET = randomBytes(24).toString("hex");
const KEY = randomBytes(24).toString("hex");

let wr: ChildProcess;
let base = "";
let wrLog = "";
let mint: Awaited<ReturnType<typeof startKeysetMint>>;

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, init);
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

const owner = (path: string, body?: unknown, key: string | null = KEY) => call(path, {
  method: body === undefined ? "GET" : "POST",
  headers: { "content-type": "application/json", ...(key === null ? {} : { authorization: "Bearer " + key }) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

before(async () => {
  execFileSync(process.execPath, [ROOT + "website/build.mjs"], { cwd: ROOT });
  execFileSync(process.execPath, [ROOT + "packages/edge-cf/build.mjs"], { cwd: ROOT });
  mint = await startKeysetMint();
  writeFileSync(ROOT + ".dev.vars", `SITE_SECRET="${SECRET}"\nTOLL_TEST_HOOKS=1\nCASHU_FETCH_PROXY="${mint.url}"\nOWNER_KEY="${KEY}"\n`, { mode: 0o600 });
  const free = await new Promise<number>((r) => { const t = createServer().listen(0, "127.0.0.1", () => { const p = (t.address() as AddressInfo).port; t.close(() => r(p)); }); });
  const persist = mkdtempSync(join(tmpdir(), "toll-edge-owner-"));
  wr = spawn(ROOT + "node_modules/.bin/wrangler", ["dev", "--local", "--ip", "127.0.0.1", "--port", String(free), "--persist-to", persist, "--show-interactive-dev-session=false"], {
    cwd: ROOT,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("wrangler dev did not start")), 90_000);
    const on = (c: Buffer) => { wrLog += c.toString(); if (/Ready on http/.test(wrLog)) { clearTimeout(t); resolve(); } };
    wr.stdout!.on("data", on);
    wr.stderr!.on("data", on);
    wr.on("exit", (code) => { clearTimeout(t); reject(new Error("wrangler dev exited " + code)); });
  });
  wr.removeAllListeners("exit");
  base = `http://127.0.0.1:${free}`;
});

after(async () => {
  wr?.kill("SIGTERM");
  rmSync(ROOT + ".dev.vars", { force: true });
  await mint?.close();
});

async function payIn(sat: number) {
  const token = mint.token(sat);
  const d = decodeTokenV4(token);
  const paid = await call("/demo/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", "x-cashu": encodeTokenV4({ mint: MINT, unit: d.unit, proofs: d.proofs }) },
    body: "{}",
  });
  assert.equal(paid.status, 200, paid.text);
}

test("the site worker: owner books and a melt to an invoice, with the key; 401 without it", async () => {
  for (let i = 0; i < 3; i++) await payIn(10);
  assert.equal((await owner("/v1/owner/books", undefined, null)).status, 401);
  assert.equal((await owner("/v1/owner/books", undefined, "x".repeat(48))).status, 401);
  const b = await owner("/v1/owner/books");
  assert.equal(b.status, 200, b.text);
  assert.equal(b.body.stored_sat, 30);
  assert.deepEqual(b.body.mints.map((m: { mint: string }) => m.mint), [MINT]);
  assert.ok(!/"(secret|C|C_|B_)"/.test(b.text));

  const inv = encodeBolt11({ amountMsat: 15_000, paymentHash: randomHex(32) });
  const w = await owner("/v1/owner/withdraw", { invoice: inv });
  assert.equal(w.status, 200, w.text);
  assert.equal(w.body.state, "paid");
  assert.equal(w.body.amount_sat, 15);
  assert.deepEqual(mint.meltsPaid(), [inv]);
  const after = await owner("/v1/owner/books");
  assert.equal(after.body.withdrawn_sat, 15);
  assert.equal(after.body.stored_sat + after.body.withdrawn_sat + after.body.withdraw_fee_sat, 30);
  const test = await call("/v1/test/cashu-books");
  assert.equal(test.body.stored, after.body.stored_sat, "the receive books see the same stored proofs");

  assert.equal((await owner("/v1/owner/withdraw/check", { quote: "nope" })).status, 404);
  assert.ok(!wrLog.includes(KEY), "the key is not logged");
  assert.ok(!wrLog.includes(inv), "the invoice is not logged");
});
