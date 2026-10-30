// Loopback quote on the site worker. The allowlisted host is proxied to the test mint. No deploy.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { fromB64url, fromUtf8 } from "../packages/protocol/src/bytes.ts";
import { startTestMint } from "../packages/settlement-ln/src/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MINT = "https://mint.minibits.cash/Bitcoin";
let wr: ChildProcess;
let base = "";
let mint: Awaited<ReturnType<typeof startTestMint>>;

async function read(res: Response): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { const parsed: unknown = text ? JSON.parse(text) : {}; if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>; } catch { body = {}; }
  return { status: res.status, headers: res.headers, body };
}

before(async () => {
  execFileSync(process.execPath, [ROOT + "packages/edge-cf/build.mjs"], { cwd: ROOT });
  mint = await startTestMint();
  writeFileSync(ROOT + ".dev.vars", `SITE_SECRET="edge-quote-test-secret-0001"\nTOLL_TEST_HOOKS=1\nCASHU_FETCH_PROXY="${mint.url}"\n`, { mode: 0o600 });
  const free = await new Promise<number>((r) => { const t = createServer().listen(0, "127.0.0.1", () => { const p = (t.address() as AddressInfo).port; t.close(() => r(p)); }); });
  const persist = mkdtempSync(join(tmpdir(), "toll-edge-quote-"));
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

test("the worker stores its own quote row and refuses a quote someone else minted", async () => {
  const denied = await post({});
  assert.equal(denied.status, 402);
  assert.ok(String(denied.headers.get("x-cashu")).startsWith("creqA"));
  const www = denied.headers.get("www-authenticate") ?? "";
  const m = /^L402 macaroon="([^"]+)", invoice="([^"]+)"$/.exec(www);
  assert.ok(m, www);
  const offers = denied.body.offers as { kind: string }[];
  assert.equal(offers[1].kind, "l402");
  const macaroon = m[1];
  const invoice = m[2];
  const quote = JSON.parse(fromUtf8(fromB64url(macaroon.split(".")[0]))).quote as string;
  const paid = await fetch(mint.url + "/test/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: invoice }) });
  const payBody = await paid.json();
  assert.equal(paid.status, 200);
  const stolen = await fetch(mint.url + "/v1/mint/bolt11", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quote }) });
  assert.equal(stolen.status, 200);
  await stolen.arrayBuffer();
  const retry = await post({ authorization: `L402 ${macaroon}:${payBody.preimage}` });
  assert.notEqual(retry.status, 200, JSON.stringify(retry.body));
  const books = await read(await fetch(base + "/v1/test/cashu-books"));
  assert.equal(books.status, 200);
  assert.equal(books.body.stored, 0);
});
