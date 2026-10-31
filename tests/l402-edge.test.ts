// Quote offer on the site worker when L402_ENABLED=1. The allowlisted host is proxied to a local mint.
// No deploy, and the flag is set only in this process's .dev.vars.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { decodeBolt11, startKeysetMint } from "../packages/settlement-ln/src/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MINT = "https://mint.minibits.cash/Bitcoin";
let wr: ChildProcess;
let base = "";
let mint: Awaited<ReturnType<typeof startKeysetMint>>;

async function read(res: Response): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch { body = {}; }
  return { status: res.status, headers: res.headers, body };
}

before(async () => {
  execFileSync(process.execPath, [ROOT + "packages/edge-cf/build.mjs"], { cwd: ROOT });
  mint = await startKeysetMint({ quotes: true });
  writeFileSync(ROOT + ".dev.vars", `SITE_SECRET="edge-quote-flag-secret-0001"\nTOLL_TEST_HOOKS=1\nL402_ENABLED=1\nCASHU_FETCH_PROXY="${mint.url}"\n`, { mode: 0o600 });
  const free = await new Promise<number>((r) => { const t = createServer().listen(0, "127.0.0.1", () => { const p = (t.address() as AddressInfo).port; t.close(() => r(p)); }); });
  const persist = mkdtempSync(join(tmpdir(), "toll-l402-edge-"));
  wr = spawn(ROOT + "node_modules/.bin/wrangler", ["dev", "--local", "--ip", "127.0.0.1", "--port", String(free), "--persist-to", persist, "--show-interactive-dev-session=false"], {
    cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"],
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

function post(headers: Record<string, string>) {
  return fetch(base + "/demo/contact", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", ...headers }, body: "{}" }).then(read);
}

test("the worker mints a paid quote into one store call and refuses a forged or reused preimage", async () => {
  const denied = await post({});
  assert.equal(denied.status, 402);
  assert.ok(String(denied.headers.get("x-cashu")).startsWith("creqA"));
  const www = denied.headers.get("www-authenticate") ?? "";
  const m = /^L402 macaroon="([^"]+)", invoice="([^"]+)"$/.exec(www);
  assert.ok(m, www);
  const offers = denied.body.offers as { kind: string; mint?: string; amount_msat?: number; invoice?: string }[];
  assert.equal(offers[0].kind, "cashu");
  assert.equal(offers[0].mint, MINT);
  assert.equal(offers[1].kind, "l402");
  const decoded = decodeBolt11(m[2]);
  assert.equal(decoded.network, "bc");
  assert.equal(decoded.amountMsat, offers[1].amount_msat);
  const manifest = await read(await fetch(base + "/.well-known/toll.json"));
  const tools = manifest.body.tools as { payment: { methods: { kind: string; status: string }[] } }[];
  for (const t of tools) {
    assert.deepEqual(t.payment.methods.map((row) => row.kind), ["cashu", "l402"]);
    assert.equal(t.payment.methods.find((row) => row.kind === "l402")?.status, "l402");
  }

  const paid = await fetch(mint.url + "/test/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: m[2] }) });
  const payBody = await paid.json() as { preimage: string };
  assert.equal(paid.status, 200);
  const forged = await post({ authorization: `L402 ${m[1]}:${"ab".repeat(32)}` });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.error, "bad_solution");
  const books = await read(await fetch(base + "/v1/test/cashu-books"));
  assert.equal(books.body.stored, 0);

  const ok = await post({ authorization: `L402 ${m[1]}:${payBody.preimage}` });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.rail, "settle");
  const after = await read(await fetch(base + "/v1/test/cashu-books"));
  assert.equal(after.body.stored, 10);
  assert.equal(after.body.inSats, after.body.stored);

  const reuse = await post({ authorization: `L402 ${m[1]}:${payBody.preimage}` });
  assert.equal(reuse.status, 401);
  assert.equal(reuse.body.error, "replay");
  const held = await read(await fetch(base + "/v1/test/cashu-books"));
  assert.equal(held.body.stored, 10);
});

test("POST /v1/demo/agent offers without an agent header, and a macaroon alone pays once", async () => {
  const manifest = await read(await fetch(base + "/.well-known/toll.json"));
  assert.equal(String(manifest.body.pay).endsWith("/v1/demo/agent"), true, JSON.stringify(manifest.body.pay));
  assert.equal(String(manifest.body.description).includes("test mode"), false);
  const human = await read(await fetch(base + "/demo/contact", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: "{}" }));
  assert.equal(human.status, 403);
  assert.equal(human.body.error, "toll_required");

  const denied = await read(await fetch(base + "/v1/demo/agent", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: "{}" }));
  assert.equal(denied.status, 402);
  assert.equal(denied.headers.get("toll-client"), null);
  const www = denied.headers.get("www-authenticate") ?? "";
  const m = /^L402 macaroon="([^"]+)", invoice="([^"]+)"$/.exec(www);
  assert.ok(m, www);
  assert.ok(String(denied.headers.get("x-cashu")).startsWith("creqA"));
  const unpaid = await read(await fetch(base + "/v1/demo/agent", { method: "POST", headers: { authorization: `L402 ${m![1]}` }, body: "{}" }));
  assert.equal(unpaid.status, 401);
  assert.equal(unpaid.body.error, "bad_solution");
  const paid = await fetch(mint.url + "/test/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: m![2] }) });
  assert.equal(paid.status, 200);
  await paid.arrayBuffer();
  const ok = await read(await fetch(base + "/v1/demo/agent", { method: "POST", headers: { authorization: `L402 ${m![1]}` }, body: "{}" }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.rail, "settle");
  const again = await read(await fetch(base + "/v1/demo/agent", { method: "POST", headers: { authorization: `L402 ${m![1]}:` }, body: "{}" }));
  assert.equal(again.status, 401);
  assert.equal(again.body.error, "replay");
  const forged = m![1].slice(0, -1) + (m![1].endsWith("a") ? "b" : "a");
  const bad = await read(await fetch(base + "/v1/demo/agent", { method: "POST", headers: { authorization: `L402 ${forged}` }, body: "{}" }));
  assert.equal(bad.status, 401);
});

test("eight concurrent retries on the worker mint once", async () => {
  const denied = await post({});
  const www = denied.headers.get("www-authenticate") ?? "";
  const m = /^L402 macaroon="([^"]+)", invoice="([^"]+)"$/.exec(www);
  assert.ok(m);
  const paid = await fetch(mint.url + "/test/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: m[2] }) });
  const payBody = await paid.json() as { preimage: string };
  assert.equal(paid.status, 200);
  const before = mint.mintPosts();
  const beforeBooks = await read(await fetch(base + "/v1/test/cashu-books"));
  const results = await Promise.all(Array.from({ length: 8 }, () => post({ authorization: `L402 ${m[1]}:${payBody.preimage}` })));
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => [r.status, r.body.error])));
  assert.equal(results.filter((r) => r.status === 401).length, 7);
  assert.equal(mint.mintPosts(), before + 1);
  const books = await read(await fetch(base + "/v1/test/cashu-books"));
  assert.equal(books.body.stored, Number(beforeBooks.body.stored) + 10);
});

async function paidOffer() {
  const denied = await post({});
  const www = denied.headers.get("www-authenticate") ?? "";
  const m = /^L402 macaroon="([^"]+)", invoice="([^"]+)"$/.exec(www);
  assert.ok(m);
  const paid = await fetch(mint.url + "/test/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: m[2] }) });
  const payBody = await paid.json() as { preimage: string };
  assert.equal(paid.status, 200);
  return { macaroon: m[1], preimage: payBody.preimage };
}

test("a mint 500 on the worker releases the quote and the retry passes once", async () => {
  const { macaroon, preimage } = await paidOffer();
  const before = mint.mintPosts();
  const beforeBooks = await read(await fetch(base + "/v1/test/cashu-books"));
  mint.failNextMints(8);
  const failed = await post({ authorization: `L402 ${macaroon}:${preimage}` });
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(failed.body.error, "store_unavailable");
  assert.equal(failed.body.detail, undefined);
  mint.failNextMints(0);
  const ok = await post({ authorization: `L402 ${macaroon}:${preimage}` });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.rail, "settle");
  const again = await post({ authorization: `L402 ${macaroon}:${preimage}` });
  assert.equal(again.status, 401);
  assert.equal(again.body.error, "replay");
  assert.equal(mint.mintPosts(), before + 3);
  const books = await read(await fetch(base + "/v1/test/cashu-books"));
  assert.equal(books.body.stored, Number(beforeBooks.body.stored) + 10);
  assert.equal(books.body.losses, beforeBooks.body.losses);
});

test("a dropped mint response on the worker is recovered by the retry", async () => {
  const { macaroon, preimage } = await paidOffer();
  const before = mint.mintPosts();
  const beforeBooks = await read(await fetch(base + "/v1/test/cashu-books"));
  mint.setDropMint(true);
  const failed = await post({ authorization: `L402 ${macaroon}:${preimage}` });
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(failed.body.error, "store_unavailable");
  mint.setDropMint(false);
  const ok = await post({ authorization: `L402 ${macaroon}:${preimage}` });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const again = await post({ authorization: `L402 ${macaroon}:${preimage}` });
  assert.equal(again.status, 401);
  assert.equal(again.body.error, "replay");
  assert.equal(mint.mintPosts(), before + 2);
  const books = await read(await fetch(base + "/v1/test/cashu-books"));
  assert.equal(books.body.stored, Number(beforeBooks.body.stored) + 10);
  assert.equal(books.body.losses, beforeBooks.body.losses);
});

test("concurrent retries during a failing first mint on the worker yield one pass", async () => {
  const { macaroon, preimage } = await paidOffer();
  const before = mint.mintPosts();
  const beforeBooks = await read(await fetch(base + "/v1/test/cashu-books"));
  mint.failNextMints(1);
  const results = await Promise.all(Array.from({ length: 8 }, () => post({ authorization: `L402 ${macaroon}:${preimage}` })));
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => [r.status, r.body.error])));
  assert.equal(results.filter((r) => r.status === 401).length, 7);
  assert.equal(mint.mintPosts(), before + 2);
  const books = await read(await fetch(base + "/v1/test/cashu-books"));
  assert.equal(books.body.stored, Number(beforeBooks.body.stored) + 10);
  assert.equal(books.body.losses, beforeBooks.body.losses);
});

test("an unrecoverable mint on the worker records the loss once", async () => {
  const { macaroon, preimage } = await paidOffer();
  const beforeBooks = await read(await fetch(base + "/v1/test/cashu-books"));
  mint.setDropMint(true);
  const failed = await post({ authorization: `L402 ${macaroon}:${preimage}` });
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(failed.body.detail, undefined);
  const mid = await read(await fetch(base + "/v1/test/cashu-books"));
  assert.equal(mid.body.losses, beforeBooks.body.losses);
  assert.equal(mid.body.stored, beforeBooks.body.stored);
  mint.setDropMint(false);
  mint.setStuckMint(true);
  const lost = await post({ authorization: `L402 ${macaroon}:${preimage}` });
  assert.equal(lost.status, 503, JSON.stringify(lost.body));
  assert.equal(lost.body.error, "store_unavailable");
  assert.equal(lost.body.detail, "mint signed; signatures were not recovered");
  const again = await post({ authorization: `L402 ${macaroon}:${preimage}` });
  assert.equal(again.status, 503);
  assert.equal(again.body.detail, "mint signed; signatures were not recovered");
  const books = await read(await fetch(base + "/v1/test/cashu-books"));
  assert.equal(books.body.losses, Number(beforeBooks.body.losses) + 10);
  assert.equal(books.body.stored, beforeBooks.body.stored);
  mint.setStuckMint(false);
});
