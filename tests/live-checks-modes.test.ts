// scripts/live-checks.mjs free checks against a local stand-in site: --expect cashu with the free
// L402 assertion, and --expect off. Nothing is paid: no request carries a payment header.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomHex } from "../packages/protocol/src/bytes.ts";
import { encodeBolt11 } from "../packages/settlement-ln/src/bolt11.ts";
import { freeChecks, l402Challenge } from "../scripts/live-checks.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
type Mode = "cashu" | "cashu-bad-invoice" | "cashu-no-l402" | "off";
let mode: Mode = "cashu";
let server: Server;
let base = "";
const seen: IncomingHttpHeaders[] = [];

function site(): Server {
  return createServer((req, res) => {
    seen.push(req.headers);
    const on = mode !== "off";
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/v1/health") return send(200, { ok: true, v: "0.1.0", edge: true, settlement: on ? "cashu" : "off" });
    if (url.pathname === "/v1/price") return send(200, on ? { action: "write", amount_msat: 10000, usd: "0.0064", status: "cashu" } : { action: "write", amount_msat: null, usd: null, status: "stub" });
    if (url.pathname === "/demo/stats") return send(200, { accepted: 0, rejected: 0, reversals: 0, reversed_sats: 0 });
    if (url.pathname === "/demo/contact" && req.method === "POST") {
      const agent = req.headers["toll-client"] === "agent";
      if (!agent || !on) return send(403, { error: "toll_required", challenge: { id: "c" } });
      const invoice = encodeBolt11({ amountMsat: mode === "cashu-bad-invoice" ? 20000 : 10000, paymentHash: randomHex(32) });
      const offers: unknown[] = [{ kind: "cashu", amount: 10, unit: "sat", mint: "https://mint.example.com/Bitcoin" }];
      const headers: Record<string, string> = { "x-cashu": "creqA" + "a".repeat(40) };
      if (mode !== "cashu-no-l402") {
        offers.push({ kind: "l402", amount_msat: 10000, invoice });
        headers["www-authenticate"] = `L402 macaroon="${"m".repeat(40)}", invoice="${invoice}"`;
      }
      return send(402, { error: "payment_required", offers }, headers);
    }
    send(404, { error: "not_found" });
  });
}

before(async () => {
  server = site();
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
after(() => new Promise<void>((ok) => server.close(() => ok())));

async function run(m: Mode, expect: string, l402 = true): Promise<Record<string, string>> {
  mode = m;
  const results: Record<string, string> = {};
  await freeChecks({ base, expect, l402, note: (check: string, status: string) => { results[check] = status; } });
  return results;
}

const allPass = (r: Record<string, string>) => Object.values(r).every((s) => s === "PASS");

test("--expect cashu passes on a paying site and checks the L402 invoice amount against the price", async () => {
  const r = await run("cashu", "cashu");
  assert.deepEqual(Object.keys(r), ["health", "price", "gate403", "gate402", "l402", "stats"]);
  assert.ok(allPass(r), JSON.stringify(r));
  const bad = await run("cashu-bad-invoice", "cashu");
  assert.equal(bad.l402, "FAIL", "an invoice for another amount fails");
  const none = await run("cashu-no-l402", "cashu");
  assert.equal(none.l402, "FAIL", "a missing L402 challenge fails when L402 is expected");
  assert.equal((await run("cashu-no-l402", "cashu", false)).l402, "PASS", "--l402 off expects no challenge");
});

test("--expect off passes on a work-only site and fails on a paying one, and the reverse", async () => {
  assert.ok(allPass(await run("off", "off")));
  const onAsOff = await run("cashu", "off");
  for (const check of ["health", "price", "gate402", "l402"]) assert.equal(onAsOff[check], "FAIL", check);
  const offAsOn = await run("off", "cashu");
  for (const check of ["health", "price", "gate402", "l402"]) assert.equal(offAsOn[check], "FAIL", check);
});

test("the free checks never send a payment or a credential", () => {
  assert.ok(seen.length > 0);
  for (const h of seen) {
    assert.equal(h["x-cashu"], undefined);
    assert.equal(h.authorization, undefined);
    if (h["toll-client"] !== undefined || h["content-type"] === "application/json") assert.equal(h["toll-test"], "1");
  }
});

test("l402Challenge reads the scheme and amount, and nothing secret", () => {
  const inv = encodeBolt11({ amountMsat: 10000, paymentHash: randomHex(32) });
  const c = l402Challenge(`L402 macaroon="abc", invoice="${inv}"`);
  assert.deepEqual(c, { scheme: "L402", amount_msat: 10000, macaroon: true });
  assert.equal(l402Challenge(null).scheme, null);
  assert.equal(l402Challenge('Toll realm="x"').scheme, "Toll");
  assert.equal(l402Challenge('L402 macaroon="abc", invoice="lnbc1bad"').amount_msat, null);
});

test("an unknown --expect is refused before any request", () => {
  const before = seen.length;
  const r = spawnSync(process.execPath, [ROOT + "scripts/live-checks.mjs", "--base", base, "--expect", "lightning", "--out", "/tmp/live-checks-mode-test"], { encoding: "utf8" });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /--expect must be off or cashu/);
  assert.equal(seen.length, before);
});
