// Agents on the WordPress plugin (packages/wp-toll-gate): the same 402 contract as the Node issuer
// when the owner collects usage payouts through a Payment server, the work check otherwise.
//   (a) the plugin only relays offers the payment server mints and asks that server to check each
//       payment: no invoice or credential code on the paid path;
//   (b) offers only with payouts ticked, Payment server chosen and an address set;
//   (c) server down, slow or broken: no offers, agents do the work, never a 500;
//   (d) every 402 carries challenge_url (offers=0), and fetching it counts work_after_402.
// agent-pay runs 20 writes on the comment form in Test mode (all work) and against the Node demo
// on :8787 as the payment server (stub backend, all paid). Needs the local site from
// packages/wp-toll-gate/dev/setup-local-wp.sh; skipped when it isn't running.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { agentPay } from "../packages/agent/src/agent-pay.ts";

const WP = (process.env.WP_URL ?? "http://127.0.0.1:8888").replace(/\/$/, "");
const CREDS = process.env.WP_ADMIN_CREDENTIALS ?? "/workspace/wp-local/ADMIN_CREDENTIALS.txt";
const WPCLI = process.env.WP_CLI ?? "/workspace/wp-local/wp-cli.phar";
const WPPATH = process.env.WP_PATH ?? "/workspace/wp-local/site";
const DEMO = process.env.TOLL_DEMO_URL ?? "http://127.0.0.1:8787";
const DEMO_KEY_FILE = new URL("../demo/.owner-key", import.meta.url);
const DEAD = "http://127.0.0.1:8799";
const PLUGIN = new URL("../packages/wp-toll-gate/", import.meta.url);
const ISSUER = WP + "/wp-json/toll";
const COUNTERS = ["pass_accept", "pass_reject", "pass_absent", "turned_away", "offer_shown", "paid", "work_after_402", "challenges_minted"] as const;
type Counts = Record<(typeof COUNTERS)[number], number>;

async function up(url: string) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}
const wpUp = (await up(WP + "/wp-json/toll/v1/health")) && existsSync(CREDS) && existsSync(WPCLI);
const skip = wpUp ? false : `local WordPress not running at ${WP} (run packages/wp-toll-gate/dev/setup-local-wp.sh)`;
const demoKey = existsSync(DEMO_KEY_FILE) ? readFileSync(DEMO_KEY_FILE, "utf8").trim() : "";
const demoUp = wpUp && demoKey !== "" && (await up(DEMO + "/v1/health"));
const skipDemo = skip || (demoUp ? false : "Node demo on :8787 not running");

function wpEval(php: string): string {
  return execFileSync("php", [WPCLI, "--path=" + WPPATH, "eval", php], { encoding: "utf8" }).trim();
}
function setMode(o: { payouts: boolean; connection: "test" | "server"; url: string; key?: string }) {
  const php = `$s = toll_gate_settings(); $s['payouts'] = ${o.payouts ? 1 : 0}; $s['connection'] = ${JSON.stringify(o.connection)}; $s['server_url'] = ${JSON.stringify(o.url)}; toll_gate_update_settings($s);` +
    (o.key !== undefined ? ` update_option('toll_gate_server_key', ${JSON.stringify(o.key)}, false);` : "") + " toll_gate_server_down_reset();";
  wpEval(php);
}
const counts = (): Counts => JSON.parse(wpEval("echo wp_json_encode(toll_gate_counters_today());"));
const delta = (a: Counts, b: Counts) => Object.fromEntries(COUNTERS.map((k) => [k, b[k] - a[k]])) as Counts;
const siteKey = () => wpEval("echo toll_gate_site_key();");

let postId = "1";
const FORM = () => ({ comment_post_ID: postId, author: "Agent", email: "agent@example.test" });
const agentComment = (headers: Record<string, string> = { "toll-client": "agent" }) =>
  fetch(WP + "/wp-comments-post.php", { method: "POST", redirect: "manual", headers: { accept: "application/json", ...headers }, body: new URLSearchParams({ ...FORM(), comment: "agent " + Math.random() }) });
const runAgentPay = (writes: number, log = false) =>
  agentPay({ base: WP, issuer: ISSUER, path: "/wp-comments-post.php", form: FORM(), field: "comment", payUrl: DEMO + "/demo/stub-pay", statsBase: DEMO, writes, log: log ? (s) => console.log("  " + s) : undefined });
const demoBalance = async () => (await fetch(DEMO + "/v1/owner/balance", { headers: { authorization: "Bearer " + demoKey } })).json() as Promise<any>;

/** A stand-in payment server: offers and redeem answers are set per test; calls are recorded. */
let fake: Server;
let FAKE = "";
const fakeCalls: { path: string; body: any }[] = [];
let fakeOffers: (body: any) => { status: number; body: any; delay?: number } = () => ({ status: 200, body: { offers: [] } });
let fakeRedeem: (body: any) => { status: number; body: any } = () => ({ status: 401, body: { error: "bad_preimage" } });

let browser: Browser;
let A: Page;

before(async () => {
  if (skip) return;
  const post = await (await fetch(WP + "/wp-json/wp/v2/posts?per_page=1")).json();
  if (Array.isArray(post) && post[0]) postId = String(post[0].id);
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      fakeCalls.push({ path: req.url ?? "", body });
      const r = req.url === "/v1/owner/offers" ? fakeOffers(body) : req.url === "/v1/owner/redeem" ? fakeRedeem(body) : { status: 404, body: { error: "not_found" } };
      setTimeout(() => { res.writeHead(r.status, { "content-type": "application/json" }); res.end(JSON.stringify(r.body)); }, (r as any).delay ?? 0);
    });
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  FAKE = `http://127.0.0.1:${(fake.address() as any).port}`;
  browser = await chromium.launch();
  A = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const pass = /Password: (\S+)/.exec(readFileSync(CREDS, "utf8"))![1];
  await A.goto(WP + "/wp-login.php");
  await A.fill("#user_login", "admin");
  await A.fill("#user_pass", pass);
  await A.click("#wp-submit");
  await A.waitForURL(/wp-admin/, { timeout: 30000 });
});
after(async () => {
  if (skip) return;
  setMode({ payouts: false, connection: "test", url: "" });
  // Drop the comments the agents left on the local site.
  wpEval("foreach (get_comments(['author_email' => 'agent@example.test', 'status' => 'all', 'number' => 0]) as $c) wp_delete_comment($c->comment_ID, true);");
  await browser?.close();
  fake?.closeAllConnections();
  await new Promise((ok) => fake?.close(ok));
});

const OFFER = (id = "off_fake_1") => ({ id, kind: "ln402", amount_msat: 10000, invoice: "inv-opaque-" + id, macaroon: "mac-opaque-" + id, exp: Math.floor(Date.now() / 1000) + 300, display: { usd: "0.0100", label: "per request" } });

// ---- (b) no offers unless payouts + Payment server + address -----------------------------------
test("(b) payouts off, Test mode, or no address: an agent gets the work-only 403 with an inline challenge, never a 402; browsers unchanged", { skip }, async () => {
  for (const m of [
    { payouts: false, connection: "test" as const, url: "" },
    { payouts: true, connection: "test" as const, url: "" },
    { payouts: true, connection: "server" as const, url: "" },
    { payouts: false, connection: "server" as const, url: demoUp ? DEMO : FAKE, key: demoUp ? demoKey : "k" },
  ]) {
    setMode(m);
    const c0 = counts();
    const r = await agentComment();
    assert.equal(r.status, 403, JSON.stringify(m));
    assert.equal(r.headers.get("www-authenticate"), null);
    const j: any = await r.json();
    assert.deepEqual(Object.keys(j), ["error", "challenge"]);
    assert.equal(j.error, "toll_required");
    assert.equal(j.challenge.bound.action, "write");
    assert.equal(j.challenge.bound.path_prefix, "/wp-comments-post.php");
    const q = await fetch(WP + "/wp-comments-post.php?client=agent", { method: "POST", redirect: "manual", body: new URLSearchParams({ ...FORM(), comment: "q " + Math.random() }) });
    assert.equal(q.status, 403, "client=agent in the query works too");
    assert.equal((await q.json() as any).error, "toll_required");
    const d = delta(c0, counts());
    assert.equal(d.offer_shown, 0);
    assert.equal(d.turned_away, 2, "403s count turned_away");
    assert.equal(d.pass_absent, 2);
    assert.equal(d.challenges_minted, 2, "one inline challenge per agent 403");
    // A browser (no agent flag) still gets the no-JavaScript page.
    const b = await fetch(WP + "/wp-comments-post.php", { method: "POST", redirect: "manual", body: new URLSearchParams({ ...FORM(), comment: "b " + Math.random() }) });
    assert.equal(b.status, 403);
    assert.match(await b.text(), /This form needs JavaScript\./);
  }
});

test("(b) Test mode: agent-pay 20 on the comment form is 20/20 accepted by doing the work, 0 paid, no 402", { skip }, async () => {
  setMode({ payouts: true, connection: "test", url: "" });
  const c0 = counts();
  const r = await runAgentPay(20);
  assert.equal(r.accepted, 20);
  assert.equal(r.work, 20);
  assert.equal(r.paid, 0);
  assert.ok(r.writes.every((w) => w.rail === "work"));
  assert.equal(r.replay, null);
  assert.equal(r.ok, true);
  const d = delta(c0, counts());
  assert.deepEqual({ offer_shown: d.offer_shown, paid: d.paid, work_after_402: d.work_after_402, turned_away: d.turned_away, pass_accept: d.pass_accept, challenges_minted: d.challenges_minted }, { offer_shown: 0, paid: 0, work_after_402: 0, turned_away: 20, pass_accept: 20, challenges_minted: 20 });
  console.log(`  Test mode agent-pay: ${r.accepted}/20 accepted (${r.paid} paid, ${r.work} work); WP counters delta ${JSON.stringify(d)}`);
});

// ---- Payment server = Node demo (stub backend) -----------------------------------------------
test("(d) Payment server: an agent gets the Node 402 (WWW-Authenticate relayed, key order error/challenge_url/offers); challenge_url has offers=0 and counts work_after_402; browsers unchanged", { skip: skipDemo }, async () => {
  setMode({ payouts: true, connection: "server", url: DEMO, key: demoKey });
  const c0 = counts();
  const r = await agentComment();
  assert.equal(r.status, 402);
  assert.match(r.headers.get("www-authenticate") ?? "", /^L402 macaroon="[^"]+", invoice="[^"]+"$/);
  assert.match(r.headers.get("access-control-expose-headers") ?? "", /www-authenticate/i);
  assert.match(r.headers.get("cache-control") ?? "", /no-store/);
  const j: any = await r.json();
  assert.deepEqual(Object.keys(j), ["error", "challenge_url", "offers"]);
  assert.equal(j.error, "payment_required");
  assert.equal(j.offers[0].kind, "ln402");
  assert.ok(r.headers.get("www-authenticate")!.includes(j.offers[0].macaroon), "header and body carry the same offer");
  const u = new URL(j.challenge_url, WP);
  assert.equal(u.pathname, "/wp-json/toll/v1/challenge");
  assert.deepEqual(Object.fromEntries(u.searchParams), { site: siteKey(), action: "write", path: "/wp-comments-post.php", client: "agent", offers: "0" });
  const c1 = counts();
  assert.deepEqual({ offer_shown: c1.offer_shown - c0.offer_shown, turned_away: c1.turned_away - c0.turned_away, pass_absent: c1.pass_absent - c0.pass_absent, challenges_minted: c1.challenges_minted - c0.challenges_minted }, { offer_shown: 1, turned_away: 0, pass_absent: 1, challenges_minted: 0 }, "a 402 is not turned_away and mints nothing");
  const cr = await fetch(u, { headers: { "toll-client": "agent" } });
  assert.equal(cr.status, 200);
  const cj: any = await cr.json();
  assert.deepEqual(cj.offers, []);
  assert.equal(cj.challenge.bound.action, "write");
  const c2 = counts();
  assert.equal(c2.work_after_402 - c1.work_after_402, 1);
  assert.equal(c2.challenges_minted - c1.challenges_minted, 1);
  // GET /challenge?client=agent relays offers (no offer_shown there, like Node).
  const oj: any = await (await fetch(ISSUER + "/v1/challenge?action=write&client=agent")).json();
  assert.equal(oj.offers.length, 1);
  assert.equal(counts().offer_shown, c2.offer_shown);
  const b = await fetch(WP + "/wp-comments-post.php", { method: "POST", redirect: "manual", body: new URLSearchParams({ ...FORM(), comment: "b " + Math.random() }) });
  assert.equal(b.status, 403, "no agent flag: the usual no-JavaScript 403");
  // Login form for an agent: the same 402 for the account class.
  const l = await fetch(WP + "/wp-login.php", { method: "POST", redirect: "manual", headers: { "toll-client": "agent", cookie: "wordpress_test_cookie=WP%20Cookie%20check" }, body: new URLSearchParams({ log: "admin", pwd: "wrong" }) });
  assert.equal(l.status, 402);
  const lj: any = await l.json();
  assert.equal(new URL(lj.challenge_url, WP).searchParams.get("action"), "account");
});

test("Payment server: agent-pay 20 on the comment form is 20/20 paid; replay rejected; spent pass refused; WP counters and the balance in WP admin match the payment server", { skip: skipDemo }, async () => {
  setMode({ payouts: true, connection: "server", url: DEMO, key: demoKey });
  const c0 = counts();
  const b0 = await demoBalance();
  const r = await runAgentPay(20);
  assert.equal(r.accepted, 20);
  assert.equal(r.paid, 20);
  assert.ok(r.writes.every((w) => w.via === "paid" && w.rail === "settle" && w.pass_n === 1 && w.pass_ttl_s === 60));
  assert.deepEqual(r.replay, { status: 401, error: "replay", rejected: true });
  assert.equal(r.pass_reuse?.status, 402, "the spent one-use pass gets a fresh 402");
  assert.equal(r.paid_total_msat, 200000);
  assert.equal(r.ledger_delta?.gross_msat, 200000, "the payment server booked every payment once");
  assert.equal(r.ok, true);
  const d = delta(c0, counts());
  assert.deepEqual(d, { pass_accept: 20, pass_reject: 1, pass_absent: 20, turned_away: 0, offer_shown: 21, paid: 20, work_after_402: 0, challenges_minted: 0 });
  const b1 = await demoBalance();
  assert.equal(b1.available_msat - b0.available_msat, 180000, "net of the 10% fee");
  assert.equal(b1.paid_requests - b0.paid_requests, 20, "each payment booked once on the payment server (the replay and the spent pass add nothing)");
  assert.deepEqual(r.balance, { before_msat: b0.available_msat, after_msat: b1.available_msat, delta_msat: 180000, before_usd: b0.available_usd, after_usd: b1.available_usd, delta_usd: "$0.18", usd_rate: 100000 }, "the run log's before/after balance matches the owner API");
  await A.goto(WP + "/wp-admin/options-general.php?page=toll-gate");
  assert.equal(await A.locator(".toll-bal.not-down strong").innerText(), b1.available_usd, "WP admin shows the payment server's balance");
  console.log(`  Payment server agent-pay: ${r.accepted}/20 accepted (${r.paid} paid); replay ${r.replay?.status} ${r.replay?.error}; spent pass ${r.pass_reuse?.status}; WP counters delta ${JSON.stringify(d)}; balance ${b0.available_usd} -> ${b1.available_usd} (${b1.available_msat} msat)`);
});

// ---- (a) relay only ------------------------------------------------------------------------
test("(a) the plugin relays the server's offers as they are and asks the server to check each payment; it mints a pass only on the server's ok", { skip }, async () => {
  setMode({ payouts: true, connection: "server", url: FAKE, key: "fake-key" });
  fakeOffers = (b) => ({ status: 200, body: { offers: [OFFER("off_" + b.action)], www_authenticate: `X-Test offer="off_${b.action}"` } });
  fakeCalls.length = 0;
  const r = await agentComment();
  assert.equal(r.status, 402);
  assert.equal(r.headers.get("www-authenticate"), 'X-Test offer="off_write"', "header value relayed as the server gave it");
  const j: any = await r.json();
  assert.deepEqual(j.offers, [OFFER("off_write")].map((o) => ({ ...o, exp: j.offers[0].exp })), "offers relayed unchanged");
  assert.deepEqual(fakeCalls[0], { path: "/v1/owner/offers", body: { action: "write" } });
  const pay = { offer_id: "off_write", kind: "ln402", preimage: "ab".repeat(32), macaroon: "mac-opaque-off_write" };
  const redeem = (body: object) => fetch(ISSUER + "/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // The server says no: WordPress says no, with the server's reason.
  fakeRedeem = () => ({ status: 401, body: { error: "replay" } });
  const no = await redeem(pay);
  assert.equal(no.status, 401);
  assert.deepEqual(await no.json(), { error: "replay" });
  assert.deepEqual(fakeCalls.at(-1), { path: "/v1/owner/redeem", body: pay }, "the proof is forwarded unchanged");
  // The site's own key refused by the server is the site's problem: 503, not the agent's 401.
  fakeRedeem = () => ({ status: 401, body: { error: "unauthorized" } });
  assert.equal((await redeem(pay)).status, 503);
  // The server says ok: a one-use, 60 s pass from this site.
  const c0 = counts();
  fakeRedeem = () => ({ status: 200, body: { ok: true, cls: "write", amount_msat: 10000, fee_msat: 1000, net_msat: 9000 } });
  const before = fakeCalls.length;
  const ok = await redeem(pay);
  assert.equal(ok.status, 200);
  assert.deepEqual(fakeCalls.slice(before), [{ path: "/v1/owner/redeem", body: pay }], "the pass is minted only after exactly one verify call to the payment server");
  const p: any = await ok.json();
  assert.deepEqual(Object.keys(p), ["pass", "exp", "cls", "rail"]);
  assert.equal(p.rail, "settle");
  const claims = JSON.parse(Buffer.from(p.pass.split(".")[1], "base64url").toString());
  assert.equal(claims.n, 1);
  assert.equal(claims.exp - claims.iat, 60);
  assert.equal(ok.headers.get("set-cookie"), null, "no cookie for agents");
  assert.equal(counts().paid - c0.paid, 1);
  // Missing fields never reach the server.
  const n = fakeCalls.length;
  assert.equal((await redeem({ offer_id: "x" })).status, 400);
  assert.equal(fakeCalls.length, n);
  // Not in Payment server mode: paid redeem unsupported.
  setMode({ payouts: true, connection: "test", url: "" });
  assert.deepEqual(await (await redeem(pay)).json(), { error: "unsupported", detail: "paid redeem is not enabled on this issuer" });
});

test("(a) no payment code in the plugin's PHP: no proof or credential checks, no Settlement verification helper (preimageMatches) anywhere under packages/wp-toll-gate, paid redeem verified only by the payment server; no invoice parsing in packages/wp-toll-gate or packages/server-php (Amendment 1 §F)", { skip: false }, () => {
  const files: string[] = [];
  const walk = (dir: URL) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "vendor" || e.name === "node_modules" || e.name === "assets") continue;
      const u = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
      if (e.isDirectory()) walk(u);
      else if (e.name.endsWith(".php")) files.push(u.pathname);
    }
  };
  walk(PLUGIN);
  const pluginCount = files.length;
  walk(new URL("../packages/server-php/", import.meta.url));
  assert.ok(pluginCount >= 8 && files.length > pluginCount, "both packages scanned");
  // Strip comments so prose about invoices doesn't count; only code is checked.
  const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/^\s*#.*$/gm, "");
  const credential = /preimageMatches|offerAmountMsat|priceMsat|splitFee|hash_hmac|base64_decode|sodium_|openssl_|hash\(\s*['"]sha256/;
  // Invoice formats and decoders: human-readable prefixes, bech32, amount multipliers, and any
  // string function or pattern applied to an invoice value.
  const invoiceFormat = /lnstub|lnbc|lntb|lnbcrt|lnsb|lntbs|bolt11|bech32|payment_request/i;
  const invoiceRead = /\b(preg_match(_all)?|preg_replace|preg_split|substr|explode|strlen|strpos|str_starts_with|str_contains|sscanf|unpack|hex2bin|strtolower|ctype_\w+)\s*\([^;]*\$\w*invoice/i;
  for (const f of files) {
    const c = code(f);
    if (f.startsWith(PLUGIN.pathname)) assert.doesNotMatch(c, credential, f);
    assert.doesNotMatch(c, invoiceFormat, f);
    assert.doesNotMatch(c, invoiceRead, f);
  }
  // Settlement::preimageMatches stays in server-php for the settlement vectors (PM, Oct 1), but the
  // plugin never references it or any other Settlement verification or pricing helper: paid
  // redeems are verified only by the payment server (POST /v1/owner/redeem).
  const settlementSrc = readFileSync(new URL("../packages/server-php/src/Settlement.php", import.meta.url), "utf8");
  const helpers = [...settlementSrc.matchAll(/public static function (\w+)/g)].map((m) => m[1]);
  assert.ok(helpers.includes("preimageMatches"), "the hash check is still in server-php");
  const display = ["feePercent", "fillFee", "usdDisplay", "offerUsd"]; // copy and USD formatting only
  const banned = helpers.filter((h) => !display.includes(h));
  assert.ok(banned.includes("preimageMatches") && banned.length >= 4, banned.join(","));
  const pluginFiles: string[] = [];
  const walkAll = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "vendor" || name === "node_modules") continue;
      const f = dir + "/" + name;
      const st = statSync(f); // follows the assets/widget link too
      if (st.isDirectory()) walkAll(f);
      else if (st.size < 2_000_000) pluginFiles.push(f);
    }
  };
  walkAll(PLUGIN.pathname.replace(/\/$/, ""));
  assert.ok(pluginFiles.length > files.filter((f) => f.startsWith(PLUGIN.pathname)).length, "every file type, not just PHP");
  for (const f of pluginFiles) {
    const raw = readFileSync(f, "utf8"); // comments included: no mention at all
    for (const h of banned) assert.ok(!raw.includes(h), `${f} references Settlement::${h}`);
    for (const m of raw.matchAll(/Settlement::(\w+)/g)) assert.ok(display.includes(m[1]), `${f} calls Settlement::${m[1]}`);
  }
  // The paid redeem goes through the payment server's verify endpoint and nothing else.
  const issuer = code(new URL("includes/issuer.php", PLUGIN).pathname);
  const paidRedeem = issuer.slice(issuer.indexOf("function toll_gate_redeem_paid"), issuer.indexOf("function toll_gate_token_from_request"));
  assert.match(paidRedeem, /toll_gate_relay_redeem\(\$b\)/);
  assert.doesNotMatch(paidRedeem, /Settlement|verify|hash/i);
  // The withdraw path only trims the invoice and hands it to the payment server.
  const payouts = code(new URL("includes/payouts.php", PLUGIN).pathname);
  assert.doesNotMatch(payouts, /function toll_gate_test_invoice_msat|toll_gate_test_invoice_msat\(/);
  assert.match(payouts, /toll_gate_server_call\('POST', '\/v1\/owner\/withdraw', \['invoice' => \$invoice\]\)/);
  const relayRedeem = payouts.slice(payouts.indexOf("function toll_gate_relay_redeem"), payouts.indexOf("function toll_gate_withdraw"));
  assert.match(relayRedeem, /toll_gate_server_call\('POST', '\/v1\/owner\/redeem', \$fwd\)/);
  assert.doesNotMatch(relayRedeem, /Settlement::|hash\(|hash_equals|hex2bin/, "no local check of the proof");
  // The paid path treats invoice and credential as opaque strings: only presence and size checks.
  const paidPath = payouts.slice(payouts.indexOf("function toll_gate_relay_offers"), payouts.indexOf("function toll_gate_withdraw"));
  assert.doesNotMatch(paidPath, /preg_match\([^)]*\$o\[|explode|json_decode|substr|str_starts_with/, "no parsing of offer fields");
});

// ---- (c) server down, slow or broken --------------------------------------------------------
test("(c) Payment server down: no 402, agents do the work (agent-pay 3/3), redeem is 503 not 500; the settings page shows only the existing notice", { skip }, async () => {
  setMode({ payouts: true, connection: "server", url: DEAD, key: "dead-key" });
  const r = await agentComment();
  assert.equal(r.status, 403);
  assert.ok(((await r.json()) as any).challenge);
  const ap = await runAgentPay(3);
  assert.equal(ap.accepted, 3);
  assert.equal(ap.work, 3);
  assert.equal(ap.paid, 0);
  const rd = await fetch(ISSUER + "/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offer_id: "o", kind: "ln402", preimage: "00".repeat(32), macaroon: "m" }) });
  assert.equal(rd.status, 503);
  assert.deepEqual(await rd.json(), { error: "unavailable" });
  assert.deepEqual(((await (await fetch(ISSUER + "/v1/challenge?action=write&client=agent")).json()) as any).offers, []);
  await A.goto(WP + "/wp-admin/options-general.php?page=toll-gate");
  const notices = await A.locator(".notice:visible").allInnerTexts();
  assert.deepEqual(notices, ["The payment server isn't responding. Visitors and clients can still get through with the background check."], "one notice: the existing payment-server warning");
});

test("(c) Payment server slow or broken: agents wait at most ~1.5 s, then work; the outage is remembered so the next agents don't wait; 500s never pass through", { skip }, async () => {
  setMode({ payouts: true, connection: "server", url: FAKE, key: "fake-key" });
  fakeOffers = () => ({ status: 200, body: { offers: [OFFER()], www_authenticate: "X-Test" }, delay: 5000 });
  fakeCalls.length = 0;
  let t = performance.now();
  const r = await agentComment();
  const slow = performance.now() - t;
  assert.equal(r.status, 403);
  assert.ok(((await r.json()) as any).challenge);
  assert.ok(slow < 3000, `answered in ${Math.round(slow)} ms`);
  t = performance.now();
  assert.equal((await agentComment()).status, 403);
  assert.ok(performance.now() - t < 1000, "second agent skips the slow server");
  assert.equal(fakeCalls.filter((c) => c.path === "/v1/owner/offers").length, 1, "remembered as down");
  for (const bad of [{ status: 500, body: { error: "boom" } }, { status: 200, body: { offers: [{ id: 1 }], www_authenticate: "X" } }, { status: 200, body: { offers: [OFFER()], www_authenticate: "a\r\nSet-Cookie: x=1" } }, { status: 401, body: { error: "unauthorized" } }]) {
    setMode({ payouts: true, connection: "server", url: FAKE, key: "fake-key" });
    fakeOffers = () => bad;
    const x = await agentComment();
    assert.equal(x.status, 403, JSON.stringify(bad));
    assert.equal(x.headers.get("set-cookie"), null);
  }
  fakeRedeem = () => ({ status: 500, body: { error: "boom" } });
  assert.equal((await fetch(ISSUER + "/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offer_id: "o", kind: "ln402", preimage: "00".repeat(32), macaroon: "m" }) })).status, 503);
});
