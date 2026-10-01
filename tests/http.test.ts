// §19.3, §19.4, §19.5, §19.11 over HTTP, plus fail-closed, rate limit, logging and API shape.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mintChallenge, signChallenge } from "../packages/protocol/src/index.ts";
import { createWorkAdapter, solveWork } from "../packages/work-adapter/src/index.ts";
import { startDemo, TEST_SECRET, type Running } from "./helpers.ts";

let S: Running;
// Lighter engine cost so the Node-side solver keeps the suite fast; the shape is the default.
before(async () => { S = await startDemo({ work: { standard: { cost: 500 } } }); });
after(async () => { await S.close(); });

const json = { accept: "application/json" };
async function getChallenge(action = "write", extra = "", headers: Record<string, string> = {}) {
  const r = await fetch(`${S.url}/v1/challenge?action=${action}${extra}`, { headers });
  assert.equal(r.status, 200);
  return r.json();
}
/** The engine solution for a Toll challenge (opaque `work`), solved in Node with the engine's solver. */
async function solve(challenge: any): Promise<{ counter: number; derivedKey: string }> {
  const s = (await solveWork(challenge.work))!;
  return { counter: s.counter, derivedKey: s.derivedKey };
}
async function redeem(challenge: any, work: unknown, took_ms = 123) {
  return fetch(`${S.url}/v1/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id: challenge.id, challenge, solution: { work, took_ms, ua_class: "desktop" } }) });
}
async function solvePass(action = "write") {
  const { challenge } = await getChallenge(action);
  const r = await redeem(challenge, await solve(challenge));
  assert.equal(r.status, 200);
  return r.json();
}
const postContact = (headers: Record<string, string> = {}, body = "message=hello") =>
  fetch(`${S.url}/contact`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body });

test("19.3 mint -> solve -> redeem -> POST accepted (header, form field and cookie)", async () => {
  const p = await solvePass();
  assert.equal(p.rail, "work");
  assert.equal(p.cls, "write");
  assert.equal((await postContact({ authorization: `Toll ${p.pass}`, ...json })).status, 200);
  assert.equal((await postContact({}, `message=hi&toll-pass=${encodeURIComponent(p.pass)}`)).status, 303);
  // Cookie set by redeem
  const { challenge } = await getChallenge();
  const r = await redeem(challenge, await solve(challenge));
  const cookie = r.headers.get("set-cookie")!;
  assert.match(cookie, /^toll_pass=[^;]+; Path=\/; Max-Age=900; HttpOnly; SameSite=Lax/);
  assert.equal((await postContact({ cookie: cookie.split(";")[0], ...json })).status, 200);
});

test("19.4 POST without a pass is rejected (curl, JSON client, browser without JS)", async () => {
  const curl = await postContact({ accept: "*/*" });
  assert.equal(curl.status, 403);
  const body = await curl.json();
  assert.equal(body.error, "toll_required");
  assert.equal(body.challenge.bound.action, "write");
  const j = await postContact(json);
  assert.equal(j.status, 403);
  const html = await postContact({ accept: "text/html,application/xhtml+xml" });
  assert.equal(html.status, 403);
  assert.match(await html.text(), /This form needs JavaScript\./);
  assert.equal((await postContact({ authorization: "Toll garbage", ...json })).status, 403);
});

test("19.5 replayed challenge, expired challenge and bad signature are rejected", async () => {
  const { challenge } = await getChallenge();
  const sol = await solve(challenge);
  assert.equal((await redeem(challenge, sol)).status, 200);
  const replay = await redeem(challenge, sol);
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error, "replay");

  const now = Math.floor(Date.now() / 1000);
  const eng = createWorkAdapter(TEST_SECRET);
  const old = await mintChallenge({ secret: TEST_SECRET, site: "site_test", action: "write", path_prefix: "/", alg: "pbkdf2-sha256", ttl_s: 120, now: now - 300, makeWork: async (tid) => (await eng.issue({ tid, spec: { alg: "pbkdf2-sha256", cost: 100, counter_max: 10 } })) as any });
  const exp = await redeem(old, await solve(old));
  assert.equal(exp.status, 401);
  assert.equal((await exp.json()).error, "expired");

  const { challenge: c2 } = await getChallenge();
  const sol2 = await solve(c2);
  const tampered = { ...c2, work: { ...c2.work, parameters: { ...c2.work.parameters, cost: 1 } } };
  const bad = await redeem(tampered, sol2);
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error, "bad_sig");
  const { sig, ...unsigned } = c2;
  const forged = await signChallenge("not-the-site-secret-0000000000", unsigned as any);
  assert.equal((await redeem(forged, sol2)).status, 401);
  const wrong = await redeem(c2, { ...sol2, derivedKey: sol2.derivedKey.slice(0, -1) + (sol2.derivedKey.endsWith("0") ? "1" : "0") });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, "bad_solution");
});

test("expired pass, wrong class and used-up pass are rejected", async () => {
  const search = await solvePass("search");
  assert.equal((await postContact({ authorization: `Toll ${search.pass}`, ...json })).status, 403, "search pass cannot authorize write");
  const p = await solvePass("write");
  for (let i = 0; i < 20; i++) assert.equal((await postContact({ authorization: `Toll ${p.pass}`, ...json })).status, 200, `use ${i + 1}`);
  assert.equal((await postContact({ authorization: `Toll ${p.pass}`, ...json })).status, 403, "21st use rejected (n=20)");
});

test("19.11 settlement off: offers is empty, health says off, work flow still works", async () => {
  const w = await getChallenge("write", "&client=agent");
  assert.deepEqual(w.offers, []);
  assert.deepEqual(await (await fetch(`${S.url}/v1/health`)).json(), { ok: true, v: "1.0.0", settlement: "off" });
  const paid = await fetch(`${S.url}/v1/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offer_id: "off_x", kind: "ln402", preimage: "00", macaroon: "x" }) });
  assert.equal(paid.status, 400);
  const p = await solvePass();
  assert.equal((await postContact({ authorization: `Toll ${p.pass}`, ...json })).status, 200);
});

test("replay store down: redeem and protected writes fail closed (503), never accepted", async () => {
  const p = await solvePass();
  const { challenge } = await getChallenge();
  const sol = await solve(challenge);
  S.store.setDown(true);
  try {
    assert.equal((await redeem(challenge, sol)).status, 503);
    assert.equal((await postContact({ authorization: `Toll ${p.pass}`, ...json })).status, 503);
  } finally {
    S.store.setDown(false);
  }
});

test("status reports the cookie or bearer pass; siteverify works (form and JSON) without coin fields", async () => {
  const p = await solvePass();
  const st = await (await fetch(`${S.url}/v1/status`, { headers: { authorization: `Toll ${p.pass}` } })).json();
  assert.equal(st.ok, true);
  assert.equal(st.cls, "write");
  assert.equal(st.n, 20);
  assert.deepEqual(await (await fetch(`${S.url}/v1/status`)).json(), { ok: false });
  const form = await (await fetch(`${S.url}/v1/siteverify`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ secret: TEST_SECRET, response: p.pass }).toString() })).json();
  assert.equal(form.success, true);
  assert.equal(form.action, "write");
  assert.deepEqual(Object.keys(form).sort(), ["action", "challenge_ts", "hostname", "success"]);
  const bad = await (await fetch(`${S.url}/v1/siteverify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "wrong", response: p.pass }) })).json();
  assert.equal(bad.success, false);
  const { challenge } = await getChallenge();
  const sol = await solve(challenge);
  const viaPayload = await (await fetch(`${S.url}/v1/siteverify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: TEST_SECRET, response: JSON.stringify({ challenge_id: challenge.id, challenge, solution: { work: sol } }) }) })).json();
  assert.equal(viaPayload.success, true);
});

test("CORS echoes configured origins only, never * with credentials", async () => {
  const ok = await fetch(`${S.url}/v1/challenge?action=write`, { headers: { origin: "http://localhost:8787" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:8787");
  assert.equal(ok.headers.get("access-control-allow-credentials"), "true");
  const evil = await fetch(`${S.url}/v1/challenge?action=write`, { headers: { origin: "https://evil.example" } });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
});

test("challenge TTL is at most 120s, bound to site/action/path prefix, not IP", async () => {
  const { challenge: c } = await getChallenge("write", "&path=/contact/form");
  assert.ok(c.exp - c.iat <= 120);
  assert.deepEqual(c.bound, { action: "write", path_prefix: "/contact" });
  assert.equal(c.site, "site_test");
  assert.ok(!JSON.stringify(c).includes("127.0.0.1"));
  assert.equal((await fetch(`${S.url}/v1/challenge?action=read`)).status, 400);
  assert.equal((await fetch(`${S.url}/v1/challenge?action=write&site=other`)).status, 401);
});

test("mobile user agents get lighter work (device_mult 0.6); the work size never appears in the challenge", async () => {
  const d = (await getChallenge()).challenge;
  const m = (await getChallenge("write", "", { "user-agent": "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) Mobile Safari/537.36" })).challenge;
  const minted = S.events.filter((e) => e.event === "challenge_minted").slice(-2);
  assert.equal(minted[0].ua_class, "desktop");
  assert.equal(minted[1].ua_class, "mobile");
  assert.ok(minted[1].counter_max < minted[0].counter_max, JSON.stringify(minted));
  assert.equal(d.alg, "pbkdf2-sha256");
  for (const c of [d, m]) assert.ok(!JSON.stringify(c).includes("counter"), "the secret counter and its range stay on the issuer");
});

test("logs: raw took_ms with rail and cls tags, counters with settled_msat and settlement_degraded, no secrets or bodies", async () => {
  const p = await solvePass();
  await postContact({ authorization: `Toll ${p.pass}`, cookie: "session=abc123", ...json }, "message=very-private-text");
  S.demo.toll.metrics.flush();
  const ev = S.events;
  const ok = ev.find((e) => e.event === "redeem_ok");
  assert.ok(ok && ok.rail === "work" && ok.cls === "write" && Number.isInteger(ok.took_ms) && typeof ok.verify_ms === "number");
  const acc = ev.find((e) => e.event === "pass_accept");
  assert.ok(acc && acc.rail === "work" && acc.cls === "write");
  const counters = ev.filter((e) => e.event === "counters").pop();
  for (const k of ["challenges_minted", "redeems_ok", "redeems_fail", "pass_accept", "pass_reject", "avg_took_ms", "settled_msat", "settlement_degraded", "took_ms_p50", "took_ms_p95"]) assert.ok(k in counters, k);
  const all = S.lines.join("\n");
  for (const secret of [TEST_SECRET, p.pass, "very-private-text", "abc123", "127.0.0.1"]) assert.ok(!all.includes(secret), `log leaked ${secret.slice(0, 12)}`);
});

test("the pass cookie is first-party only: no Set-Cookie for a cross-origin redeem", async () => {
  const { challenge } = await getChallenge();
  const sol = await solve(challenge);
  const r = await fetch(`${S.url}/v1/redeem`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:8787" }, body: JSON.stringify({ challenge_id: challenge.id, challenge, solution: { work: sol } }) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("set-cookie"), null);
  assert.ok((await r.json()).pass);
});
