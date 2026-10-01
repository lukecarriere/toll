// Edge worker (spec §11, phase 3) under `wrangler dev --local` (workerd + local KV). No deploy, no account.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { solveWork } from "../packages/work-adapter/src/index.ts";

const SECRET = "edge-test-secret-do-not-use-000001";
let wr: ChildProcess;
let BASE = "";
let origin: Server;
const seen: { method: string; url: string; body: string; auth?: string }[] = [];

before(async () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../packages/edge-cf/build.mjs", import.meta.url))]);
  origin = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, body: b, auth: req.headers.authorization });
      res.setHeader("content-type", "text/plain");
      res.end(`origin ${req.method} ${req.url}`);
    });
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  const port = (origin.address() as AddressInfo).port;
  const free = await new Promise<number>((r) => { const t = createServer().listen(0, "127.0.0.1", () => { const p = (t.address() as AddressInfo).port; t.close(() => r(p)); }); });
  const dir = fileURLToPath(new URL("../packages/edge-cf/", import.meta.url));
  const bin = fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));
  const vars = { SITE_ID: "site_edge", SITE_SECRET: SECRET, ORIGIN: `http://127.0.0.1:${port}`, WRITE_PATHS: '["/contact","/wp-comments-post.php"]' };
  wr = spawn(bin, ["dev", "--local", "--ip", "127.0.0.1", "--port", String(free), "--persist-to", mkdtempSync(join(tmpdir(), "toll-edge-")), "--show-interactive-dev-session=false", ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])], { cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("wrangler dev did not start:\n" + log)), 60_000);
    const on = (c: Buffer) => { log += c; if (/Ready on http/.test(log)) { clearTimeout(t); resolve(); } };
    wr.stdout!.on("data", on);
    wr.stderr!.on("data", on);
    wr.on("exit", (code) => { clearTimeout(t); reject(new Error("wrangler dev exited " + code + "\n" + log)); });
  });
  wr.removeAllListeners("exit");
  BASE = `http://127.0.0.1:${free}`;
});
after(async () => { wr?.kill("SIGTERM"); origin?.close(); });

const f = (path: string, init: any = {}) => fetch(BASE + path, init);
async function pass(action = "write") {
  const { challenge } = (await (await f(`/v1/challenge?action=${action}&path=/contact`)).json()) as any;
  const s = await solveWork(challenge.work);
  const r = await f("/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id: challenge.id, challenge, solution: { work: { counter: s!.counter, derivedKey: s!.derivedKey }, took_ms: 1 } }) });
  return { r, j: (await r.json()) as any, challenge, s: s! };
}

test("edge: reads proxy to the origin; health says edge, settlement off; widget served same-origin", async () => {
  const r = await f("/blog/post?x=1");
  assert.equal(await r.text(), "origin GET /blog/post?x=1");
  assert.deepEqual(await (await f("/v1/health")).json(), { ok: true, v: "1.0.0", settlement: "off", edge: true });
  const js = await f("/toll/v1/toll.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type")!, /javascript/);
  assert.match(await js.text(), /toll-gate/);
  assert.equal((await f("/toll/v1/toll.worker.js")).status, 200);
});

test("edge: gated POST without a pass -> 403 with a fresh challenge (JSON) or the interstitial (HTML); origin untouched", async () => {
  const n = seen.length;
  const r = await f("/contact", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ message: "hi" }) });
  assert.equal(r.status, 403);
  const j: any = await r.json();
  assert.equal(j.error, "toll_required");
  assert.equal(j.challenge.bound.action, "write");
  assert.equal(j.challenge.site, "site_edge");
  assert.equal(j.challenge.alg, "pbkdf2-sha256");
  const h = await f("/wp-comments-post.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" }, body: "comment=hello+there&comment_post_ID=1" });
  assert.equal(h.status, 403);
  const html = await h.text();
  assert.match(html, /data-toll="write"/);
  assert.match(html, /<input type="hidden" name="comment" value="hello there">/);
  assert.match(html, /<noscript>This form needs JavaScript\.<\/noscript>/);
  assert.match(html, /src="\/toll\/v1\/toll\.js"/);
  assert.equal(seen.length, n, "nothing reached the origin");
});

test("edge: challenge -> solve -> redeem -> pass (cookie + body) -> gated POST proxied; replayed challenge 401", async () => {
  const { r, j, challenge, s } = await pass();
  assert.equal(r.status, 200);
  assert.equal(j.rail, "work");
  assert.match(r.headers.get("set-cookie")!, /^toll_pass=.+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax/);
  const n = seen.length;
  const ok = await f("/contact", { method: "POST", headers: { "content-type": "application/json", authorization: "Toll " + j.pass }, body: JSON.stringify({ message: "hi" }) });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "origin POST /contact");
  assert.equal(seen.length, n + 1);
  assert.equal(seen.at(-1)!.body, '{"message":"hi"}');
  const viaCookie = await f("/contact", { method: "POST", headers: { cookie: "toll_pass=" + encodeURIComponent(j.pass) }, body: "x" });
  assert.equal(viaCookie.status, 200);
  const st: any = await (await f("/v1/status", { headers: { authorization: "Toll " + j.pass } })).json();
  assert.deepEqual([st.ok, st.cls, st.n], [true, "write", 18], "two of 20 uses spent (KV-backed counts)");
  const again = await f("/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id: challenge.id, challenge, solution: { work: { counter: s.counter, derivedKey: s.derivedKey } } }) });
  assert.equal(again.status, 401);
  assert.deepEqual(await again.json(), { error: "replay" });
  const bad = await f("/contact", { method: "POST", headers: { accept: "application/json", authorization: "Toll not.a.pass" }, body: "x" });
  assert.equal(bad.status, 403);
});

test("edge: /v1/siteverify (form and JSON) per spec §8.5: secret check, pass or redeem payload, action, no coin fields", async () => {
  const { j } = await pass();
  const form = (o: Record<string, string>) => f("/v1/siteverify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
  assert.deepEqual(await (await form({ secret: "wrong-secret-wrong-secret", response: j.pass })).json(), { success: false, "error-codes": ["invalid-input-secret"] });
  const ok: any = await (await form({ secret: SECRET, response: j.pass, action: "write" })).json();
  assert.equal(ok.success, true);
  assert.equal(ok.action, "write");
  assert.equal(ok.hostname, "127.0.0.1", "the origin's hostname");
  assert.match(ok.challenge_ts, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(Object.keys(ok).sort(), ["action", "challenge_ts", "hostname", "success"]);
  assert.deepEqual(await (await form({ secret: SECRET, response: "garbage" })).json(), { success: false, "error-codes": ["invalid-input-response"] });
  assert.deepEqual(await (await form({ secret: SECRET, response: j.pass, action: "admin" })).json(), { success: false, "error-codes": ["invalid-input-response"] }, "a write pass does not cover admin");
  // JSON body with a redeem payload instead of a pass (how plugins migrate).
  const { challenge } = (await (await f("/v1/challenge?action=write")).json()) as any;
  const s = await solveWork(challenge.work);
  const payload = JSON.stringify({ challenge_id: challenge.id, challenge, solution: { work: { counter: s!.counter, derivedKey: s!.derivedKey } } });
  const jr: any = await (await f("/v1/siteverify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: SECRET, response: payload }) })).json();
  assert.equal(jr.success, true);
  const dup: any = await (await f("/v1/siteverify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: SECRET, response: payload }) })).json();
  assert.deepEqual(dup, { success: false, "error-codes": ["timeout-or-duplicate"] });
});

test("edge: paid redeem is refused at the edge (work-only), offers always []", async () => {
  const c: any = await (await f("/v1/challenge?action=write&client=agent")).json();
  assert.deepEqual(c.offers, []);
  const r = await f("/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offer_id: "off_x", kind: "ln402", preimage: "00", macaroon: "m" }) });
  assert.equal(r.status, 400);
});
