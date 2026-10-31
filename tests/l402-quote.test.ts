// Production quote offer. The flag defaults off. A real invoice is decoded only when it is on.
// The mint is local. No public mint is contacted and nothing is paid.
import { test, after } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBolt11, encodeBolt11, l402Enabled, paymentHashOf, paymentHashOfBolt11, paymentRequired, quoteMode, QUOTE_KIND } from "../packages/settlement-ln/src/index.ts";
import { startKeysetMint } from "../packages/settlement-ln/src/keyset-mint.ts";
import { sha256 } from "../packages/protocol/src/hmac.ts";
import { fromHex, toHex } from "../packages/protocol/src/bytes.ts";
import { TollError } from "../packages/protocol/src/errors.ts";
import { startDemo } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC = "https://pay.example.com/Bitcoin";
const HASH = "0001020304050607080900010203040506070809000102030405060708090102";
const COFFEE = "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";
const DONATION = "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql";
const CASHU_ONLY = '{"error":"payment_required","challenge_url":"/v1/challenge?site=site_test&action=write&path=%2Fcontact&client=agent&offers=0","offers":[{"id":"off_fixed","kind":"cashu","amount_msat":10000,"amount":10,"unit":"sat","mint":"https://pay.example.com/Bitcoin","request":"creqAfixed","credential":"cred","exp":1700000000}]}';

const saved = process.env.L402_ENABLED;
delete process.env.L402_ENABLED;
after(() => {
  if (saved === undefined) delete process.env.L402_ENABLED;
  else process.env.L402_ENABLED = saved;
});

test("a bolt11 invoice yields its payment hash and amount, and the loopback stand-in does not", () => {
  const coffee = decodeBolt11(COFFEE);
  assert.equal(coffee.network, "bc");
  assert.equal(coffee.amountMsat, 250_000_000);
  assert.equal(coffee.paymentHash, HASH);
  assert.equal(decodeBolt11(DONATION).amountMsat, null);
  assert.equal(decodeBolt11(DONATION).paymentHash, HASH);
  const flipped = COFFEE.slice(0, -1) + (COFFEE.endsWith("h") ? "q" : "h");
  assert.throws(() => decodeBolt11(flipped), (e: TollError) => e.code === "malformed");
  assert.throws(() => decodeBolt11(COFFEE.toUpperCase()), (e: TollError) => e.code === "malformed");
  const ten = encodeBolt11({ amountMsat: 10_000, paymentHash: HASH });
  assert.equal(decodeBolt11(ten).amountMsat, 10_000);
  assert.equal(decodeBolt11(ten).paymentHash, HASH);
  assert.equal(paymentHashOfBolt11(ten, 10_000), HASH);
  assert.throws(() => paymentHashOfBolt11(ten, 9_000), (e: TollError) => e.code === "malformed");
  assert.throws(() => paymentHashOfBolt11(DONATION, 10_000), (e: TollError) => e.code === "malformed");
  assert.throws(() => paymentHashOf(ten), (e: TollError) => e.code === "malformed");
  const loop = "lnbc100n1" + HASH;
  assert.equal(paymentHashOf(loop), HASH);
  assert.throws(() => paymentHashOfBolt11(loop, 10_000), (e: TollError) => e.code === "malformed");
  const testnet = encodeBolt11({ network: "tb", amountMsat: 10_000, paymentHash: HASH });
  assert.equal(decodeBolt11(testnet).network, "tb");
  assert.throws(() => paymentHashOfBolt11(testnet, 10_000), (e: TollError) => e.code === "malformed");
  assert.equal(l402Enabled(undefined), false);
  assert.equal(l402Enabled("0"), false);
  assert.equal(l402Enabled("1"), true);
  assert.equal(quoteMode({}), "off");
  assert.equal(quoteMode({ TOLL_TEST_HOOKS: "1" }), "loopback");
  assert.equal(quoteMode({ L402_ENABLED: "1", TOLL_TEST_HOOKS: "1" }), "bolt11");
});

test("the cashu-only 402 bytes stay fixed", () => {
  const offer = { id: "off_fixed", kind: "cashu" as const, amount_msat: 10000, amount: 10, unit: "sat" as const, mint: PUBLIC, request: "creqAfixed", credential: "cred", exp: 1700000000 };
  const pr = paymentRequired("site_test", "write", "/contact", [offer]);
  assert.equal(JSON.stringify(pr.body), CASHU_ONLY);
  assert.deepEqual(pr.headers, { "x-cashu": "creqAfixed", "access-control-expose-headers": "x-cashu" });
  assert.equal("www-authenticate" in pr.headers, false);
});

function proxy(local: string): typeof fetch {
  return async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(href);
    const i = u.pathname.indexOf("/v1/");
    const path = i >= 0 ? u.pathname.slice(i) : u.pathname;
    return fetch(new URL(local).origin + path + u.search, init);
  };
}

function issuerConfig(store: string) {
  return {
    work: { standard: { cost: 500 } },
    settlement: {
      enabled: true, backend: "stub", fee_bps: 1000, fx: { source: "none" },
      cashu: { enabled: true, mints: [PUBLIC], store },
    },
  };
}

async function boot(flag: boolean) {
  const mint = await startKeysetMint({ quotes: true });
  if (flag) process.env.L402_ENABLED = "1";
  else delete process.env.L402_ENABLED;
  const dir = mkdtempSync(join(tmpdir(), "toll-l402-"));
  const demo = await startDemo(issuerConfig(join(dir, "proofs.json")), {
    settlement: { mintGuard: { lookup: async () => ["1.1.1.1"], fetch: proxy(mint.url) } },
  });
  return { mint, demo };
}

function post(url: string, headers: Record<string, string> = {}) {
  return fetch(url + "/contact", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent", ...headers },
    body: "{}",
  });
}

async function quoteOf(url: string) {
  const denied = await post(url);
  const text = await denied.text();
  const body = JSON.parse(text);
  assert.equal(denied.status, 402, text);
  const www = denied.headers.get("www-authenticate") ?? "";
  const m = /^L402 macaroon="([^"]+)", invoice="([^"]+)"$/.exec(www);
  assert.ok(m, www);
  assert.equal(body.offers.length, 2);
  assert.equal(body.offers[0].kind, "cashu");
  assert.equal(body.offers[1].kind, "l402");
  assert.equal(body.offers[1].invoice, m[2]);
  const decoded = decodeBolt11(m[2]);
  assert.equal(decoded.amountMsat, body.offers[1].amount_msat);
  assert.equal(decoded.network, "bc");
  return { body, macaroon: m[1], invoice: m[2], hash: decoded.paymentHash };
}

async function pay(mintUrl: string, invoice: string): Promise<string> {
  const r = await fetch(mintUrl + "/test/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: invoice }) });
  const body = await r.json();
  assert.equal(r.status, 200);
  return body.preimage as string;
}

test("a paid quote grants a pass, and a replay is refused for a real invoice", async () => {
  const { mint, demo } = await boot(true);
  try {
    const manifest = await (await fetch(demo.url + "/.well-known/toll.json")).json();
    for (const tool of manifest.tools) {
      const kinds = tool.payment.methods.map((m: { kind: string; status: string }) => m.kind);
      assert.deepEqual(kinds, ["cashu", QUOTE_KIND]);
      assert.equal(tool.payment.methods.find((m: { kind: string }) => m.kind === QUOTE_KIND).status, QUOTE_KIND);
    }
    const first = await quoteOf(demo.url);
    const preimage = await pay(mint.url, first.invoice);
    assert.equal(toHex(await sha256(fromHex(preimage))), first.hash);
    const paid = await post(demo.url, { authorization: `L402 ${first.macaroon}:${preimage}` });
    const passBody = await paid.json();
    assert.equal(paid.status, 200, JSON.stringify(passBody));
    assert.equal(passBody.rail, "settle");
    assert.equal(await demo.store.hasMintQuote?.(JSON.parse(Buffer.from(first.macaroon.split(".")[0], "base64url").toString()).quote), true);
    const again = await post(demo.url, { authorization: `L402 ${first.macaroon}:${preimage}` });
    assert.equal(again.status, 401);
    assert.equal((await again.json()).error, "replay");
    for (const line of demo.lines) {
      assert.equal(line.includes(preimage), false);
      assert.equal(line.includes(first.macaroon), false);
      assert.equal(line.includes(first.invoice), false);
    }
  } finally {
    delete process.env.L402_ENABLED;
    await demo.close();
    await mint.close();
  }
});

test("the live check refuses a cap above 10 and does not print the wallet", () => {
  const script = ROOT + "scripts/l402-live-check.sh";
  const high = spawnSync("sh", [script, "11"], { encoding: "utf8" });
  assert.equal(high.status, 2);
  assert.match(high.stderr, /1 to 10/);
  const missing = spawnSync("sh", [script, "10"], { encoding: "utf8", env: { ...process.env, L402_ENABLED: "", L402_BASE: "", L402_WALLET: "" } });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /required/);
  const secret = "supersecretwallet";
  const down = spawnSync("sh", [script, "10"], {
    encoding: "utf8",
    env: { ...process.env, L402_BASE: "http://127.0.0.1:1", L402_WALLET: "printf " + secret, PATH: process.env.PATH },
  });
  assert.notEqual(down.status, 0);
  assert.equal((down.stdout + down.stderr).includes(secret), false);
});

test("the live check sends the macaroon alone when the wallet prints nothing", async () => {
  const script = ROOT + "scripts/l402-live-check.sh";
  let auth = "";
  const server = createServer((req, res) => {
    req.resume();
    if (req.method === "POST" && !req.headers.authorization) {
      const body = JSON.stringify({
        error: "payment_required",
        offers: [{ kind: "l402", amount_msat: 10000, invoice: "lnbc100n1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" }],
      });
      res.writeHead(402, {
        "content-type": "application/json",
        "www-authenticate": 'L402 macaroon="macaroon-token", invoice="lnbc100n1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"',
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    auth = String(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  try {
    const run = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn("sh", [script, "10"], {
        env: { ...process.env, L402_BASE: "http://127.0.0.1:" + port, L402_PATH: "/", L402_WALLET: "true", PATH: process.env.PATH },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "ok 10");
    assert.equal(auth, "L402 macaroon-token");
    assert.equal(run.stdout.includes("macaroon-token"), false);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});

test("L402_ENABLED unset: the 402 is the cashu-only response and the mint is not asked for a quote", async () => {
  const { mint, demo } = await boot(false);
  try {
    const denied = await post(demo.url);
    const text = await denied.text();
    const body = JSON.parse(text);
    assert.equal(denied.status, 402);
    assert.equal(body.offers.length, 1);
    assert.equal(body.offers[0].kind, "cashu");
    assert.equal(body.offers[0].mint, PUBLIC);
    const pr = paymentRequired("site_test", "write", "/contact", body.offers);
    assert.equal(text, JSON.stringify(pr.body));
    assert.equal(denied.headers.get("www-authenticate"), null);
    assert.equal(denied.headers.get("access-control-expose-headers"), "x-cashu");
    assert.equal(denied.headers.get("x-cashu"), body.offers[0].request);
    assert.deepEqual(pr.headers, { "x-cashu": body.offers[0].request, "access-control-expose-headers": "x-cashu" });
    assert.equal(mint.quotePosts(), 0);
    const manifest = await (await fetch(demo.url + "/.well-known/toll.json")).json();
    for (const tool of manifest.tools) assert.deepEqual(tool.payment.methods.map((m: { kind: string }) => m.kind), ["cashu"]);
    assert.equal(mint.quotePosts(), 0);
  } finally {
    await demo.close();
    await mint.close();
  }
});

const LOST = "mint signed; signatures were not recovered";

function quoteId(macaroon: string): string {
  return JSON.parse(Buffer.from(macaroon.split(".")[0], "base64url").toString()).quote as string;
}

test("a mint 500 releases the quote and the retry passes once", async () => {
  const { mint, demo } = await boot(true);
  try {
    const offer = await quoteOf(demo.url);
    const preimage = await pay(mint.url, offer.invoice);
    const quote = quoteId(offer.macaroon);
    const before = mint.mintPosts();
    mint.failNextMints(8);
    const failed = await post(demo.url, { authorization: `L402 ${offer.macaroon}:${preimage}` });
    const failedBody = await failed.json();
    assert.equal(failed.status, 503, JSON.stringify(failedBody));
    assert.equal(failedBody.error, "unavailable");
    assert.equal(failedBody.detail, undefined);
    assert.equal(await demo.store.hasMintQuote?.(quote), false);
    assert.equal((demo.store.mintQuoteLosses?.() ?? []).some((o) => o.quote === quote), false);
    mint.failNextMints(0);
    const ok = await post(demo.url, { authorization: `L402 ${offer.macaroon}:${preimage}` });
    const okBody = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(okBody));
    assert.equal(okBody.rail, "settle");
    const again = await post(demo.url, { authorization: `L402 ${offer.macaroon}:${preimage}` });
    assert.equal(again.status, 401);
    assert.equal((await again.json()).error, "replay");
    assert.equal(mint.mintPosts(), before + 3);
    assert.equal((demo.store.mintQuoteLosses?.() ?? []).some((o) => o.quote === quote), false);
  } finally {
    delete process.env.L402_ENABLED;
    await demo.close();
    await mint.close();
  }
});

test("a dropped mint response is recovered by the retry, once", async () => {
  const { mint, demo } = await boot(true);
  try {
    const offer = await quoteOf(demo.url);
    const preimage = await pay(mint.url, offer.invoice);
    const quote = quoteId(offer.macaroon);
    const before = mint.mintPosts();
    mint.setDropMint(true);
    const failed = await post(demo.url, { authorization: `L402 ${offer.macaroon}:${preimage}` });
    const failedBody = await failed.json();
    assert.equal(failed.status, 503, JSON.stringify(failedBody));
    assert.equal(failedBody.error, "unavailable");
    assert.equal(await demo.store.hasMintQuote?.(quote), true);
    assert.equal((demo.store.mintQuoteLosses?.() ?? []).some((o) => o.quote === quote), false);
    mint.setDropMint(false);
    const ok = await post(demo.url, { authorization: `L402 ${offer.macaroon}:${preimage}` });
    const okBody = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(okBody));
    assert.equal(okBody.rail, "settle");
    const again = await post(demo.url, { authorization: `L402 ${offer.macaroon}:${preimage}` });
    assert.equal(again.status, 401);
    assert.equal((await again.json()).error, "replay");
    assert.equal(mint.mintPosts(), before + 2);
    assert.equal((demo.store.mintQuoteLosses?.() ?? []).some((o) => o.quote === quote), false);
  } finally {
    delete process.env.L402_ENABLED;
    await demo.close();
    await mint.close();
  }
});

test("concurrent retries during a failing first mint yield one pass", async () => {
  const { mint, demo } = await boot(true);
  try {
    const offer = await quoteOf(demo.url);
    const preimage = await pay(mint.url, offer.invoice);
    const before = mint.mintPosts();
    mint.failNextMints(1);
    const results = await Promise.all(Array.from({ length: 8 }, () => post(demo.url, { authorization: `L402 ${offer.macaroon}:${preimage}` })));
    const rows = [];
    for (const r of results) rows.push({ status: r.status, body: await r.json() });
    assert.equal(rows.filter((r) => r.status === 200 && r.body.rail === "settle").length, 1, JSON.stringify(rows));
    assert.equal(rows.filter((r) => r.status === 401 && r.body.error === "replay").length, 7, JSON.stringify(rows));
    assert.equal(mint.mintPosts(), before + 2);
    const again = await post(demo.url, { authorization: `L402 ${offer.macaroon}:${preimage}` });
    assert.equal(again.status, 401);
    assert.equal((await again.json()).error, "replay");
  } finally {
    delete process.env.L402_ENABLED;
    await demo.close();
    await mint.close();
  }
});

test("twelve overlapping retries mint once", async () => {
  const { mint, demo } = await boot(true);
  try {
    const offer = await quoteOf(demo.url);
    const preimage = await pay(mint.url, offer.invoice);
    const before = mint.mintPosts();
    const gate = mint.holdNextMint();
    const pending = Promise.all(Array.from({ length: 12 }, () => post(demo.url, { authorization: `L402 ${offer.macaroon}:${preimage}` })));
    const held = await gate;
    await new Promise((r) => setTimeout(r, 80));
    held.release();
    const results = await pending;
    const rows = [];
    for (const r of results) rows.push({ status: r.status, body: await r.json() });
    assert.equal(rows.filter((r) => r.status === 200).length, 1, JSON.stringify(rows));
    assert.equal(rows.filter((r) => r.status === 401 && r.body.error === "replay").length, 11, JSON.stringify(rows));
    assert.equal(mint.mintPosts(), before + 1);
  } finally {
    delete process.env.L402_ENABLED;
    await demo.close();
    await mint.close();
  }
});

test("an issued quote whose signatures cannot be fetched records one loss", async () => {
  const { mint, demo } = await boot(true);
  try {
    const offer = await quoteOf(demo.url);
    const preimage = await pay(mint.url, offer.invoice);
    const quote = quoteId(offer.macaroon);
    mint.setDropMint(true);
    const failed = await post(demo.url, { authorization: `L402 ${offer.macaroon}:${preimage}` });
    const failedBody = await failed.json();
    assert.equal(failed.status, 503, JSON.stringify(failedBody));
    assert.equal((demo.store.mintQuoteLosses?.() ?? []).some((o) => o.quote === quote), false);
    mint.setDropMint(false);
    mint.setStuckMint(true);
    const lost = await post(demo.url, { authorization: `L402 ${offer.macaroon}:${preimage}` });
    const lostBody = await lost.json();
    assert.equal(lost.status, 503, JSON.stringify(lostBody));
    assert.equal(lostBody.error, "unavailable");
    assert.equal(lostBody.detail, LOST);
    const losses = (demo.store.mintQuoteLosses?.() ?? []).filter((o) => o.quote === quote);
    assert.equal(losses.length, 1);
    assert.equal(losses[0].amount, 10);
    const again = await post(demo.url, { authorization: `L402 ${offer.macaroon}:${preimage}` });
    const againBody = await again.json();
    assert.equal(again.status, 503, JSON.stringify(againBody));
    assert.equal(againBody.detail, LOST);
    assert.equal((demo.store.mintQuoteLosses?.() ?? []).filter((o) => o.quote === quote).length, 1);
    assert.equal(await demo.store.hasMintQuote?.(quote), true);
  } finally {
    delete process.env.L402_ENABLED;
    await demo.close();
    await mint.close();
  }
});
