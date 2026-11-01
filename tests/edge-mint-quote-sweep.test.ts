// The site worker's cron sweep under `wrangler dev --test-scheduled`. The configured mint host is
// proxied to a local stub mint that counts every call. Ports and .dev.vars live in a temp dir.
// Test hooks only; no deploy.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { startSweepStubMint } from "./sweep-stub-mint.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MINT = "https://mint.minibits.cash/Bitcoin";
let base = "";
let work = "";
let wr: ChildProcess;
let log = "";
let mint: Awaited<ReturnType<typeof startSweepStubMint>>;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

before(async () => {
  execFileSync(process.execPath, [ROOT + "packages/edge-cf/build.mjs"], { cwd: ROOT });
  mint = await startSweepStubMint();
  work = mkdtempSync(join(tmpdir(), "toll-edge-sweep-"));
  const port = await freePort();
  const inspector = await freePort();
  base = `http://127.0.0.1:${port}`;
  // The worker config's paths are absolute so this directory can hold .dev.vars without touching the repo.
  writeFileSync(join(work, "wrangler.toml"), `
name = "toll-site"
main = "${ROOT}packages/edge-cf/dist/site.js"
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true
preview_urls = false

[assets]
directory = "${ROOT}website/dist"
binding = "ASSETS"
html_handling = "drop-trailing-slash"
not_found_handling = "none"
run_worker_first = true

[vars]
TOLL_SITE_URL = "https://lessspam.dev"
SITE_ID = "site_demo"
WRITE_PATHS = '["/demo/contact"]'
CASHU_MINTS = '["https://mint.minibits.cash/Bitcoin"]'
L402_ENABLED = "1"

[triggers]
crons = ["*/30 * * * *"]

[[durable_objects.bindings]]
name = "TOLL_STORE"
class_name = "TollStoreDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TollStoreDO"]
`);
  writeFileSync(join(work, ".dev.vars"), `SITE_SECRET="edge-sweep-test-secret-0001"\nTOLL_TEST_HOOKS=1\nL402_ENABLED=1\nCASHU_FETCH_PROXY="${mint.url}"\n`, { mode: 0o600 });
  wr = spawn(ROOT + "node_modules/.bin/wrangler", ["dev", "--local", "--test-scheduled", "--config", join(work, "wrangler.toml"), "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", join(work, "persist"), "--show-interactive-dev-session=false"], {
    cwd: work, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("wrangler dev did not start:\n" + log)), 90_000);
    const on = (c: Buffer) => { log += c.toString(); if (/Ready on http/.test(log)) { clearTimeout(t); resolve(); } };
    wr.stdout!.on("data", on);
    wr.stderr!.on("data", on);
    wr.on("exit", (code) => { clearTimeout(t); reject(new Error("wrangler dev exited " + code + "\n" + log)); });
  });
  wr.removeAllListeners("exit");
});

after(async () => {
  if (wr && wr.exitCode === null && !wr.killed) {
    wr.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2_000);
      wr.once("exit", () => { clearTimeout(t); resolve(); });
    });
  }
  if (work) rmSync(work, { recursive: true, force: true });
  await mint?.close();
});

async function seed(b: { quote: string; amount: number; mint: string; ageS: number; open?: boolean; loss?: string }) {
  const r = await fetch(base + "/v1/test/mint-quote-seed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "write", ...b }) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
}

/** Fires the cron once and returns its summary log line. */
async function cron(): Promise<Record<string, unknown>> {
  const from = log.length;
  const r = await fetch(base + "/__scheduled?cron=" + encodeURIComponent("*/30 * * * *"));
  assert.equal(r.status, 200);
  await r.text();
  const deadline = Date.now() + 30_000;
  for (;;) {
    const m = /\{"event":"mint_quote_sweep"[^\n]*\}/.exec(log.slice(from));
    if (m) return JSON.parse(m[0]) as Record<string, unknown>;
    if (Date.now() > deadline) throw new Error("no sweep log line:\n" + log.slice(from));
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

async function stats(): Promise<Record<string, number>> {
  return (await (await fetch(base + "/demo/stats")).json()) as Record<string, number>;
}

test("edge cron sweep: a worst-case mint is held under the 40-call cap, one log line per run, losses kept", async () => {
  mint.set("refused");
  for (let i = 0; i < 12; i++) await seed({ quote: "q" + String(i).padStart(2, "0"), amount: 10, mint: i % 2 ? "" : MINT, ageS: 300, loss: "mint_refused" });
  const before = await stats();
  mint.calls.length = 0;
  const line = await cron();
  assert.equal(line.cron, "*/30 * * * *");
  assert.equal(line.error, undefined, JSON.stringify(line));
  // Counted at the mint: every subrequest the run made to it, keys included.
  assert.equal(line.calls, mint.calls.length, JSON.stringify(mint.calls));
  assert.ok(mint.calls.length <= 40);
  assert.ok(1 + 2 + mint.calls.length <= 45, "the cron RPC, one lookup and the mint calls stay within the ceiling");
  assert.deepEqual({ scanned: line.scanned, skipped: line.skipped, recovered: line.recovered, stop: line.stop }, { scanned: 5, skipped: 5, recovered: 0, stop: "calls" });
  assert.equal(mint.calls.filter((c) => c.endsWith("/v1/keysets")).length, 1);
  assert.equal((log.match(/"event":"mint_quote_sweep"/g) ?? []).length, 1, "one summary line per run");
  const after = await stats();
  assert.equal(after.reversals, before.reversals);
  // The next run starts after the cursor: the five tried rows are not reached again before the rest.
  mint.calls.length = 0;
  const next = await cron();
  assert.equal(next.calls, mint.calls.length);
  assert.ok(mint.calls.length <= 40);
  assert.equal(next.scanned, 5, JSON.stringify(next));
  assert.equal((log.match(/"event":"mint_quote_sweep"/g) ?? []).length, 2);
});

test("edge cron sweep: a loss booked with mint '' is minted on the configured mint and reversed", async () => {
  mint.set("real");
  const made = await (await fetch(mint.keysetUrl + "/v1/mint/quote/bolt11", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: 10, unit: "sat" }) })).json() as { quote: string; request: string };
  const paid = await fetch(mint.keysetUrl + "/test/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: made.request }) });
  assert.equal(paid.status, 200);
  await paid.arrayBuffer();
  await seed({ quote: made.quote, amount: 10, mint: "", ageS: 300, loss: "mint_refused" });
  const before = await stats();
  let line: Record<string, unknown> = {};
  // The cursor may sit past this quote; a run wraps, so at most a few runs reach it.
  for (let i = 0; i < 4 && !line.recovered; i++) {
    mint.calls.length = 0;
    line = await cron();
    assert.ok(mint.calls.length <= 40 && line.calls === mint.calls.length, JSON.stringify(line));
  }
  assert.equal(line.recovered, 1, JSON.stringify(line));
  assert.equal(line.reversedSats, 10);
  const after = await stats();
  assert.equal(after.reversals, before.reversals + 1);
  assert.equal(after.reversed_sats, before.reversed_sats + 10);
});
