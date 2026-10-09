// Demo worker (T3) under `wrangler dev --local`. No deploy, no route, no zone.
// Proof: curl transcripts and Playwright screenshots written for the PR.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { solveWork } from "../packages/work-adapter/src/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SECRET = randomBytes(24).toString("hex");
const ART = "/opt/cursor/artifacts";
const SHOTS = ART + "/screenshots";
const SITE_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const DEMO_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const PAGES = ["/", "/mission", "/vision", "/values", "/ecosystem"] as const;
const PAGE_FILE: Record<string, string> = { "/": "index.html", "/mission": "mission.html", "/vision": "vision.html", "/values": "values.html", "/ecosystem": "ecosystem.html" };

let wr: ChildProcess;
let BASE = "";
let log = "";
const proof: string[] = [];

function redact(s: string): string {
  const hidden = SECRET ? s.split(SECRET).join("[secret]") : s;
  return hidden.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[pass]");
}

function record(title: string, text: string) {
  proof.push("## " + title, redact(text).trimEnd(), "");
}

before(async () => {
  execFileSync(process.execPath, [ROOT + "website/build.mjs"], { cwd: ROOT });
  execFileSync(process.execPath, [ROOT + "packages/edge-cf/build.mjs"], { cwd: ROOT });
  writeFileSync(ROOT + ".dev.vars", `SITE_SECRET="${SECRET}"\nTOLL_TEST_HOOKS=1\n`, { mode: 0o600 });
  const free = await new Promise<number>((r) => { const t = createServer().listen(0, "127.0.0.1", () => { const p = (t.address() as AddressInfo).port; t.close(() => r(p)); }); });
  const bin = ROOT + "node_modules/.bin/wrangler";
  const persist = mkdtempSync(join(tmpdir(), "toll-site-"));
  wr = spawn(bin, ["dev", "--local", "--ip", "127.0.0.1", "--port", String(free), "--persist-to", persist, "--show-interactive-dev-session=false"], {
    cwd: ROOT,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("wrangler dev did not start:\n" + redact(log))), 90_000);
    const on = (c: Buffer) => { log += c.toString(); if (/Ready on http/.test(log)) { clearTimeout(t); resolve(); } };
    wr.stdout!.on("data", on);
    wr.stderr!.on("data", on);
    wr.on("exit", (code) => { clearTimeout(t); reject(new Error("wrangler dev exited " + code + "\n" + redact(log))); });
  });
  wr.removeAllListeners("exit");
  const on = (c: Buffer) => { log += c.toString(); };
  wr.stdout!.on("data", on);
  wr.stderr!.on("data", on);
  BASE = `http://127.0.0.1:${free}`;
  record("wrangler dev", "Ready on " + BASE);
});

after(() => {
  wr?.kill("SIGTERM");
  rmSync(ROOT + ".dev.vars", { force: true });
  mkdirSync(ART, { recursive: true });
  writeFileSync(ART + "/t3-proof.txt", proof.join("\n") + "\n");
});

function curl(urlPath: string, args: string[] = []): { status: number; body: string; headers: string; raw: string } {
  const r = spawnSync("curl", ["-sS", "-D", "-", ...args, BASE + urlPath], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(redact(r.stderr || r.stdout || "curl failed"));
  const raw = r.stdout;
  const idx = raw.search(/\r?\n\r?\n/);
  const headers = idx < 0 ? raw : raw.slice(0, idx);
  const body = idx < 0 ? "" : raw.slice(idx).replace(/^\r?\n\r?\n/, "");
  const status = Number(/HTTP\/\d(?:\.\d)? (\d+)/.exec(headers)?.[1] ?? 0);
  return { status, body, headers, raw };
}

function curlShow(title: string, urlPath: string, args: string[] = []) {
  const shown = ["curl -sS -D -", ...args, "http://127.0.0.1" + urlPath].join(" ");
  const out = curl(urlPath, args);
  record(title, "$ " + shown + "\n" + out.raw);
  return out;
}

test("wrangler.toml: assets, sqlite durable object, workers_dev, no routes or zones", () => {
  const toml = readFileSync(ROOT + "wrangler.toml", "utf8");
  assert.match(toml, /^name = "toll-site"$/m);
  assert.match(toml, /^main = "packages\/edge-cf\/dist\/site\.js"$/m);
  assert.match(toml, /^workers_dev = true$/m);
  assert.match(toml, /^preview_urls = false$/m);
  assert.match(toml, /binding = "ASSETS"/);
  assert.match(toml, /run_worker_first = \[ "\/v1\/\*", "\/toll\/v1\/\*", "\/demo\/\*", "\/\.well-known\/toll\.json", "\/\.well-known\/agents\.json" \]/);
  assert.match(toml, /new_sqlite_classes = \["TollStoreDO"\]/);
  assert.match(toml, /class_name = "TollStoreDO"/);
  assert.doesNotMatch(toml, /^\s*routes?\s*=|\[\[routes\]\]|zone_id|zone_name|pattern\s*=/m);
  assert.doesNotMatch(toml, /^\s*(SITE_SECRET|TOLL_TEST_HOOKS|STORE_FAIL)\s*=/m);
  record("wrangler.toml checks", "name, main, assets.run_worker_first, new_sqlite_classes, workers_dev, preview_urls; no routes, zones, or secret");
});

test("existing pages: 200, site CSP unchanged, body byte-identical to the build", () => {
  const lines: string[] = [];
  for (const p of PAGES) {
    const res = curlShow("GET " + p, p);
    assert.equal(res.status, 200, p);
    const csp = /content-security-policy:\s*(.+)/i.exec(res.headers)?.[1]?.trim();
    assert.equal(csp, SITE_CSP, p);
    const built = readFileSync(ROOT + "website/dist/" + PAGE_FILE[p]);
    assert.deepEqual(Buffer.from(res.body), built, p + " body");
    lines.push(p + " 200 CSP site " + built.length + " bytes");
  }
  record("page bytes", lines.join("\n"));
});

test("demo page: demo CSP, and a pass-less POST is 403 with a challenge", () => {
  const page = curlShow("GET /demo", "/demo");
  assert.equal(page.status, 200);
  const csp = /content-security-policy:\s*(.+)/i.exec(page.headers)?.[1]?.trim();
  assert.equal(csp, DEMO_CSP);
  assert.deepEqual(Buffer.from(page.body), readFileSync(ROOT + "website/dist/demo.html"));
  const post = curlShow("POST /demo/contact without a pass", "/demo/contact", ["-X", "POST", "-H", "accept: application/json", "-H", "content-type: application/json", "-d", "{\"message\":\"hi\"}"]);
  assert.equal(post.status, 403);
  const j = JSON.parse(post.body);
  assert.equal(j.error, "toll_required");
  assert.equal(j.challenge.bound.action, "write");
  assert.equal(j.challenge.alg, "pbkdf2-sha256");
  assert.doesNotMatch(post.raw, /"message"/);
});

async function solved(action = "write", path = "/demo/contact") {
  const issued = curl("/v1/challenge?action=" + action + "&path=" + encodeURIComponent(path));
  assert.equal(issued.status, 200, issued.body);
  const { challenge } = JSON.parse(issued.body);
  const s = await solveWork(challenge.work);
  assert.ok(s);
  const payload = JSON.stringify({ challenge_id: challenge.id, challenge, solution: { work: { counter: s.counter, derivedKey: s.derivedKey }, took_ms: 1 } });
  return { challenge, payload };
}

test("replayed challenge is 401; a spent pass is rejected; price is stub; paid redeem is 400", async () => {
  const { challenge, payload } = await solved();
  const ok = curlShow("POST /v1/redeem", "/v1/redeem", ["-X", "POST", "-H", "content-type: application/json", "-d", payload]);
  assert.equal(ok.status, 200);
  const pass = JSON.parse(ok.body).pass as string;
  assert.equal(typeof pass, "string");
  const again = curlShow("POST /v1/redeem replay", "/v1/redeem", ["-X", "POST", "-H", "content-type: application/json", "-d", payload]);
  assert.equal(again.status, 401);
  assert.deepEqual(JSON.parse(again.body), { error: "replay" });

  let last = 0;
  for (let i = 0; i < 20; i++) {
    const r = curl("/demo/contact", ["-X", "POST", "-H", "accept: application/json", "-H", "authorization: Toll " + pass, "-d", "message=n"]);
    assert.equal(r.status, 200, "use " + i + " " + r.body);
    last = r.status;
  }
  const spent = curlShow("POST /demo/contact with a spent pass", "/demo/contact", ["-X", "POST", "-H", "accept: application/json", "-H", "authorization: Toll " + pass, "-d", "message=spent"]);
  assert.equal(spent.status, 403);
  assert.equal(JSON.parse(spent.body).error, "toll_required");
  assert.notEqual(last, 403);
  record("spent pass", "20 accepts then 403");

  const price = curlShow("GET /v1/price?action=write", "/v1/price?action=write");
  assert.equal(price.status, 200);
  const pj = JSON.parse(price.body);
  assert.equal(pj.status, "stub");
  assert.equal(pj.amount_msat, null);
  assert.equal(pj.basis, "current");
  const paid = curlShow("POST /v1/redeem paid", "/v1/redeem", ["-X", "POST", "-H", "content-type: application/json", "-d", JSON.stringify({ offer_id: "off_x", kind: "ln402", preimage: "00" })]);
  assert.equal(paid.status, 400);
  assert.equal(JSON.parse(paid.body).error, "unsupported");
});

test("two concurrent redeems of one challenge give exactly one pass", async () => {
  const { payload } = await solved();
  const args = ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", "-H", "content-type: application/json", "-d", payload, BASE + "/v1/redeem"];
  const [a, b] = await Promise.all([
    new Promise<string>((resolve, reject) => { const c = spawn("curl", args); let o = ""; c.stdout.on("data", (d) => (o += d)); c.on("exit", (code) => code === 0 ? resolve(o) : reject(new Error("curl " + code))); }),
    new Promise<string>((resolve, reject) => { const c = spawn("curl", args); let o = ""; c.stdout.on("data", (d) => (o += d)); c.on("exit", (code) => code === 0 ? resolve(o) : reject(new Error("curl " + code))); }),
  ]);
  const codes = [a, b].sort();
  record("concurrent redeem", codes.join(" "));
  assert.deepEqual(codes, ["200", "401"]);
});

test("injected store failure rejects writes; pages stay 200", async () => {
  const { payload } = await solved();
  const minted = curl("/v1/redeem", ["-X", "POST", "-H", "content-type: application/json", "-d", payload]);
  assert.equal(minted.status, 200, minted.body);
  const pass = JSON.parse(minted.body).pass as string;
  const fresh = await solved();
  const header = ["-H", "x-toll-store-fail: 1"];
  for (const p of ["/", "/mission", "/demo", "/toll/v1/toll.js"]) {
    const res = curlShow("GET " + p + " during store failure", p, header);
    assert.equal(res.status, 200, p);
  }
  const write = curlShow("POST /demo/contact with store failure and a pass", "/demo/contact", ["-X", "POST", "-H", "accept: application/json", "-H", "authorization: Toll " + pass, ...header, "-d", "message=nope"]);
  assert.equal(write.status, 503, write.body);
  assert.notEqual(JSON.parse(write.body).ok, true);
  const bare = curlShow("POST /demo/contact with store failure and no pass", "/demo/contact", ["-X", "POST", "-H", "accept: application/json", ...header, "-d", "message=nope"]);
  assert.equal(bare.status, 503, bare.body);
  const redeem = curlShow("POST /v1/redeem with store failure", "/v1/redeem", ["-X", "POST", "-H", "content-type: application/json", ...header, "-d", fresh.payload]);
  assert.equal(redeem.status, 503, redeem.body);
});

test("demo form submits without thinking; no CSP violations; no third-party requests", { timeout: 120_000 }, async () => {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const csp: string[] = [];
  const urls: string[] = [];
  try {
  await page.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as any).__csp.push(e.violatedDirective + " " + e.blockedURI));
  });
  page.on("request", (r) => urls.push(r.url()));
  const marker = "unique-private-message-7731";
  const stats1 = page.waitForResponse((r) => r.url().includes("/demo/stats") && r.ok());
  await page.goto(BASE + "/demo", { waitUntil: "load" });
  await stats1;
  const beforeRej = Number(await page.textContent("#st-rej"));
  await page.fill("#m", marker);
  await page.click("#contact button[type=submit]");
  const stats2 = page.waitForResponse((r) => r.url().includes("/demo/stats") && r.ok());
  await page.waitForURL(/sent=contact/, { timeout: 60_000 });
  await stats2;
  await page.waitForSelector("#sent:not([hidden])");
  assert.match((await page.textContent("#sent"))!, /Accepted/);
  const accepted = Number(await page.textContent("#st-acc"));
  assert.ok(accepted >= 1, "accepted count from the store");
  const stats3 = page.waitForResponse((r) => r.url().includes("/demo/stats") && r.ok());
  await page.click("#nopass-btn");
  await page.waitForSelector("#nopass-out:not([hidden])");
  assert.match((await page.textContent("#nopass-out"))!, /403/);
  await stats3;
  const rejected = Number(await page.textContent("#st-rej"));
  assert.ok(rejected > beforeRej, "rejected count from the store");
  assert.equal(await page.evaluate(() => (window as any).__csp.length), 0);
  csp.push(...await page.evaluate(() => (window as any).__csp as string[]));
  assert.deepEqual(csp, []);
  const foreign = urls.filter((u) => !u.startsWith(BASE + "/") && u !== BASE + "/demo" && !u.startsWith(BASE + "/demo?"));
  assert.deepEqual(foreign, [], "third-party requests");
  assert.equal(await page.locator("body").innerText().then((t) => t.includes(marker)), false, "the message is not echoed");
  const shot = SHOTS + "/demo-accepted.png";
  await page.screenshot({ path: shot, fullPage: true });
  record("playwright", [
    "url " + page.url(),
    "accepted pill visible",
    "rejected pill visible",
    "csp violations 0",
    "third-party requests 0",
    "message echoed no",
    "screenshot " + shot,
    "requests",
    ...urls,
  ].join("\n"));
  } finally {
    await browser.close();
  }
});

test("the message is not in the worker log", () => {
  assert.equal(log.includes("unique-private-message-7731"), false);
  assert.equal(log.includes(SECRET), false);
  record("worker log", "message absent, secret absent, " + log.length + " chars");
});

test("bundle is within the Workers Free limit and dry-run succeeds", () => {
  const out = mkdtempSync(join(tmpdir(), "toll-dry-"));
  const bin = ROOT + "node_modules/.bin/wrangler";
  const r = spawnSync(bin, ["deploy", "--dry-run", "--outdir", out], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  const text = redact((r.stdout || "") + (r.stderr || ""));
  record("wrangler deploy --dry-run --outdir", text);
  assert.equal(r.status, 0, text);
  const m = /gzip:\s*([\d.]+)\s*KiB/.exec(text);
  assert.ok(m, text);
  const gzip = Number(m[1]) * 1024;
  // Workers Free script limit is 3 MiB.
  assert.ok(gzip < 3 * 1024 * 1024, m[0]);
});
