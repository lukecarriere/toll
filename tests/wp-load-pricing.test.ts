// Load pricing on the live local WordPress site (be/wp-load-pricing): the parity check. For one visitor
// network, with velocity on at the payment server, five prices must agree:
//   (a) the payment server's own 402 for a request from that visitor,
//   (b) the offer it relays to the site for that visitor's network (POST /v1/owner/offers with net),
//   (c) the payment server's GET /v1/price for that visitor,
//   (d) the site's GET /wp-json/toll/v1/price for that visitor (basis "current"),
//   (e) the site's agent 402 for that visitor;
// at multiplier 1, and again after paid writes through the site (redeems relayed with that network)
// raise the multiplier. Another network stays at 1, and a missing network gets the base price.
// The payment server runs in this process (velocity on, low steps, a long window) so the shared demo
// keeps its shipped config. The site sees each visitor through a test-only must-use plugin that sets
// TOLL_TRUSTED_PROXIES to 127.0.0.1 (this test connects from there and sends X-Forwarded-For); it is
// removed, and the site's payment server settings restored, in after(). Needs the local site from
// packages/wp-toll-gate/dev/setup-local-wp.sh; skipped when it isn't running, like the other live WP tests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { coarseNet, parseTrustedProxies } from "../packages/protocol/src/index.ts";
import { createAgent, testBackendPayer } from "../packages/agent/src/index.ts";
import { BASE_PRICE_NOTE } from "../packages/server-node/src/manifest.ts";
import { startDemo, PAID_ON, type Running } from "./helpers.ts";

const WP = (process.env.WP_URL ?? "http://127.0.0.1:8888").replace(/\/$/, "");
const WPCLI = process.env.WP_CLI ?? "/workspace/wp-local/wp-cli.phar";
const WPPATH = process.env.WP_PATH ?? "/workspace/wp-local/site";
const ISSUER = WP + "/wp-json/toll";
const MU = WPPATH + "/wp-content/mu-plugins/zz-toll-test-trusted-proxies.php";
const EMAIL = "agent-load@example.test";

async function up(url: string) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); await r.arrayBuffer(); return r.ok; } catch { return false; }
}
const skip = (await up(WP + "/wp-json/toll/v1/health")) && existsSync(WPCLI) ? false : `local WordPress not running at ${WP} (run packages/wp-toll-gate/dev/setup-local-wp.sh)`;

const wpEval = (php: string) => execFileSync("php", [WPCLI, "--path=" + WPPATH, "eval", php], { encoding: "utf8" }).trim().split("\n").pop()!;
const KEY = "owner-key-" + randomBytes(12).toString("hex");
let hot: Running;
let HOT = "";
let saved = "";
let postId = "1";

before(async () => {
  if (skip) return;
  // A payment server with velocity on: 3 paid redeems from one network -> x2, 6 -> x4, in a 10-minute window.
  hot = await startDemo({ work: { standard: { cost: 500 }, velocity_steps: [[3, 2], [6, 4]], velocity_window_s: 600 }, adaptive: { velocity: true }, settlement: { ...PAID_ON.settlement, owner_key: KEY } });
  hot.demo.toll.config.trusted_proxies = parseTrustedProxies("127.0.0.1, ::1").ranges; // (a) and (c): this test is the visitor's proxy too (TOLL_TRUSTED_PROXIES)
  HOT = hot.url.replace("//localhost:", "//127.0.0.1:");
  saved = wpEval("echo wp_json_encode(['s' => toll_gate_settings(), 'k' => (string) get_option('toll_gate_server_key', '')]);");
  mkdirSync(WPPATH + "/wp-content/mu-plugins", { recursive: true });
  // Same content on every run, so PHP's compiled-script cache never serves an older version.
  writeFileSync(MU, `<?php
// Test-only (tests/wp-load-pricing.test.ts): requests come from 127.0.0.1 with X-Forwarded-For naming the visitor. Removed after the run.
if (!defined('TOLL_TRUSTED_PROXIES')) define('TOLL_TRUSTED_PROXIES', '127.0.0.1');
`);
  wpEval(`$s = toll_gate_settings(); $s['payouts'] = 1; $s['connection'] = 'server'; $s['server_url'] = ${JSON.stringify(HOT)}; toll_gate_update_settings($s); update_option('toll_gate_server_key', ${JSON.stringify(KEY)}, false); toll_gate_server_down_reset(); delete_transient('toll_gate_price_cache'); echo 'ok';`);
  const post = await (await fetch(WP + "/wp-json/wp/v2/posts?per_page=1")).json();
  if (Array.isArray(post) && post[0]) postId = String(post[0].id);
});
after(async () => {
  if (skip) return;
  rmSync(MU, { force: true });
  if (saved) {
    const b64 = Buffer.from(saved).toString("base64");
    wpEval(`$o = json_decode(base64_decode('${b64}'), true); toll_gate_update_settings($o['s']); update_option('toll_gate_server_key', $o['k'], false); toll_gate_server_down_reset(); delete_transient('toll_gate_price_cache'); echo 'ok';`);
  }
  wpEval(`foreach (get_comments(['author_email' => '${EMAIL}', 'status' => 'all', 'number' => 0]) as $c) wp_delete_comment($c->comment_ID, true); echo 'ok';`);
  await hot?.close();
});

const json = { "content-type": "application/json", accept: "application/json" };
const asVisitor = (ip: string) => ({ "x-forwarded-for": ip });
/** Read a response to the end (PHP's built-in server closes each connection; see wp-counters.test.ts). */
const body = async (r: Response) => { const t = await r.text(); return t ? JSON.parse(t) : null; };

async function legs(ip: string) {
  const net = coarseNet(ip);
  assert.ok(net, ip);
  const a = await fetch(HOT + "/comments", { method: "POST", headers: { ...json, "toll-client": "agent", ...asVisitor(ip) }, body: "{}" });
  assert.equal(a.status, 402, "(a) status");
  const b = await fetch(HOT + "/v1/owner/offers", { method: "POST", headers: { ...json, authorization: "Bearer " + KEY }, body: JSON.stringify({ action: "write", net }) });
  const c = await fetch(HOT + "/v1/price?action=write", { headers: asVisitor(ip) });
  const d = await fetch(WP + "/wp-json/toll/v1/price?action=write", { headers: asVisitor(ip) });
  const e = await fetch(WP + "/wp-comments-post.php", { method: "POST", redirect: "manual", headers: { accept: "application/json", "toll-client": "agent", ...asVisitor(ip) }, body: new URLSearchParams({ comment_post_ID: postId, author: "Agent", email: EMAIL, comment: "price check " + Math.random() }) });
  const [aj, bj, cj, dj, ej] = [await body(a), await body(b), await body(c), await body(d), await body(e)];
  assert.equal(e.status, 402, "(e) status: " + JSON.stringify(ej));
  return {
    amounts: { a: aj.offers[0].amount_msat, b: bj.offers[0].amount_msat, c: cj.amount_msat, d: dj.amount_msat, e: ej.offers[0].amount_msat },
    mult: { c: cj.load_multiplier, d: dj.load_multiplier },
    basis: dj.basis,
    usd: { d: dj.usd, e: ej.offers[0].display?.usd },
  };
}
const all = (x: number) => ({ a: x, b: x, c: x, d: x, e: x });

/** Paid writes through the site as the visitor: the agent library, with X-Forwarded-For on every request it makes to the site. */
async function paidWrites(ip: string, n: number) {
  const viaProxy: typeof fetch = (u, init) => {
    const h = new Headers(init?.headers);
    h.set("x-forwarded-for", ip);
    return fetch(u, { ...init, headers: h });
  };
  const agent = createAgent({ base: WP, issuer: ISSUER, pay: testBackendPayer(HOT), work: false, fetch: viaProxy });
  for (let i = 0; i < n; i++) {
    const r = await agent.fetch("/wp-comments-post.php", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ comment_post_ID: postId, author: "Agent", email: EMAIL, comment: `paid ${i} ${Math.random()}` }).toString() });
    await r.response.arrayBuffer();
    assert.equal(r.via, "paid", `write ${i} paid`);
    assert.equal(r.redeemed?.rail, "settle");
    assert.ok(r.response.status < 400, `write ${i} accepted: ${r.response.status}`);
  }
}

test("parity: the payment server's own 402, the relayed offer, its /v1/price, the site's /price and the site's agent 402 agree for one network, at x1 and after paid writes raise it; another network stays at x1; no network (or a walk stopped by an invalid entry) gets the base", { skip }, async () => {
  const A = "203.0.113.41";
  const B = "2001:db8:1::7";
  const at1A = await legs(A);
  assert.deepEqual(at1A.amounts, all(10000), "x1, network A");
  assert.deepEqual(at1A.mult, { c: 1, d: 1 });
  assert.equal(at1A.basis, "current");
  assert.deepEqual(at1A.usd, { d: "0.0100", e: "0.0100" });
  assert.deepEqual((await legs(B)).amounts, all(10000), "x1, network B");

  await paidWrites(A, 3);
  const raised = await legs(A);
  assert.deepEqual(raised.mult, { c: 2, d: 2 }, "the multiplier rose");
  assert.deepEqual(raised.amounts, all(20000), "x2 for network A on all five");
  assert.deepEqual(raised.usd, { d: "0.0200", e: "0.0200" });
  assert.deepEqual((await legs("203.0.113.200")).amounts, all(20000), "another address in the same /24");
  assert.deepEqual((await legs("::ffff:203.0.113.9")).amounts, all(20000), "the IPv4-mapped form of the same network");
  const b = await legs(B);
  assert.deepEqual([b.amounts, b.mult], [all(10000), { c: 1, d: 1 }], "network B stays at x1");
  assert.deepEqual((await legs("198.51.100.7")).amounts, all(10000), "network C at x1");

  // No network: the relay and the quote use the base price.
  const noNet = await (await fetch(HOT + "/v1/owner/offers", { method: "POST", headers: { ...json, authorization: "Bearer " + KEY }, body: JSON.stringify({ action: "write" }) })).json() as any;
  const noNetQuote = await (await fetch(HOT + "/v1/owner/quote", { method: "POST", headers: { ...json, authorization: "Bearer " + KEY }, body: JSON.stringify({ action: "write" }) })).json() as any;
  assert.deepEqual([noNet.offers[0].amount_msat, noNetQuote.amount_msat, noNetQuote.load_multiplier], [10000, 10000, 1]);
  // Through the site: the visitor names network A but the proxy appends "unknown", so the walk stops there and
  // no net is sent; the site's /price and its agent 402 are the base, never A's raised price (nor the proxy's network).
  const stop = { "x-forwarded-for": A + ", unknown" };
  const sp = await body(await fetch(WP + "/wp-json/toll/v1/price?action=write", { headers: stop }));
  const s402 = await fetch(WP + "/wp-comments-post.php", { method: "POST", redirect: "manual", headers: { accept: "application/json", "toll-client": "agent", ...stop }, body: new URLSearchParams({ comment_post_ID: postId, author: "Agent", email: EMAIL, comment: "price check " + Math.random() }) });
  const s402j = await body(s402);
  assert.equal(s402.status, 402);
  assert.deepEqual([sp.amount_msat, sp.load_multiplier, s402j.offers[0].amount_msat], [10000, 1, 10000], "an invalid entry stops the walk: base price");

  // IPv6 network B rises the same way through the site.
  await paidWrites(B, 3);
  assert.deepEqual((await legs("2001:db8:1:ffff::2")).amounts, all(20000), "network B after its own paid writes");
});

test("the site's manifest shows the base-price note when its payment server applies load (velocity on, the site sends networks); a site that does not declare it is told false", { skip }, async () => {
  wpEval("delete_transient('toll_gate_price_cache'); echo 'ok';");
  const doc: any = await body(await fetch(WP + "/.well-known/toll.json"));
  assert.equal(doc.tools[1].price.note, BASE_PRICE_NOTE);
  assert.equal(doc.tools[1].price.basis, "base");
  assert.equal(doc.tools[1].price.amount_msat, 10000, "the manifest is the base price whatever the load");
  const auth = { authorization: "Bearer " + KEY };
  assert.deepEqual((await body(await fetch(HOT + "/v1/owner/price", { headers: auth }))).load_pricing, { search: false, write: false, account: false, admin: false }, "older plugin: never true");
  assert.deepEqual((await body(await fetch(HOT + "/v1/owner/price?net=1", { headers: auth }))).load_pricing, { search: true, write: true, account: true, admin: true });
  assert.equal(wpEval("$c = get_transient('toll_gate_price_cache'); echo is_array($c) && ($c['net_declared'] ?? null) === true && ($c['load_pricing']['write'] ?? null) === true ? 'declared' : 'no';"), "declared");
});

test("the site stores no visitor network or address: options and transients (the price cache included) never hold them", { skip }, async () => {
  const marks = ["203.0.113.", "2001:0db8:0001", "2001:db8:1:", "198.51.100."];
  const where = marks.map((m) => `option_value LIKE '%${m}%' OR option_name LIKE '%${m}%'`).join(" OR ");
  assert.equal(wpEval(`global $wpdb; echo (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->options} WHERE ${where}");`), "0");
  assert.equal(wpEval("echo (int) $GLOBALS['wpdb']->get_var(\"SELECT COUNT(*) FROM {$GLOBALS['wpdb']->options} WHERE option_name LIKE '%toll_gate_price_cache%'\");"), "2", "one cache entry (value + timeout), one key for every visitor");
});
