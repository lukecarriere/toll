// toll-gate on a local WordPress (packages/wp-toll-gate/README.md): REST issuer, comment gate,
// counters and CSV export, the Settings → Toll states, the comment form at 390 and 1440, and copy
// scans (no coin words, no vendor names) on the plugin's screens and the comment form.
// Needs the local site from packages/wp-toll-gate/dev/setup-local-wp.sh; skipped when it isn't
// running. The "Payment server" states use the Node demo on :8787 (stub backend) when it is up.
// TOLL_RENDERS=<dir> also saves screenshots of each state there.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { solveWork } from "../packages/work-adapter/src/index.ts";

// @ts-ignore plain JS helper
const { lintRegexes, vendorRegexes } = await import("../scripts/copy-lib.mjs");
const WP = (process.env.WP_URL ?? "http://127.0.0.1:8888").replace(/\/$/, "");
const CREDS = process.env.WP_ADMIN_CREDENTIALS ?? "/workspace/wp-local/ADMIN_CREDENTIALS.txt";
const DEMO = process.env.TOLL_DEMO_URL ?? "http://127.0.0.1:8787";
const DEMO_KEY_FILE = new URL("../demo/.owner-key", import.meta.url);
const DEAD = "http://127.0.0.1:8799"; // nothing listens here: the "server down" state
const RENDERS = process.env.TOLL_RENDERS;
const COUNTERS = ["pass_accept", "pass_reject", "pass_absent", "turned_away", "offer_shown", "paid", "work_after_402"];

async function up(url: string) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}
const wpUp = (await up(WP + "/wp-json/toll/v1/health")) && existsSync(CREDS);
const skip = wpUp ? false : `local WordPress not running at ${WP} (run packages/wp-toll-gate/dev/setup-local-wp.sh)`;
const demoKey = existsSync(DEMO_KEY_FILE) ? readFileSync(DEMO_KEY_FILE, "utf8").trim() : "";
const demoUp = wpUp && demoKey !== "" && (await up(DEMO + "/v1/health"));

let browser: Browser;
let admin: BrowserContext;
let A: Page;
let postPath = "/hello-world/";
let postId = "1";

before(async () => {
  if (skip) return;
  if (RENDERS) mkdirSync(RENDERS, { recursive: true });
  browser = await chromium.launch();
  admin = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  A = await admin.newPage();
  const pass = /Password: (\S+)/.exec(readFileSync(CREDS, "utf8"))![1];
  // The login form itself is protected (account class): the widget solves before it submits.
  await A.goto(WP + "/wp-login.php");
  await A.fill("#user_login", "admin");
  await A.fill("#user_pass", pass);
  await A.click("#wp-submit");
  await A.waitForURL(/wp-admin/, { timeout: 30000 });
  await setSettings({ payouts: false, connection: "test", url: "" });
  const post = await (await fetch(WP + "/wp-json/wp/v2/posts?per_page=1")).json();
  if (Array.isArray(post) && post[0]) { postId = String(post[0].id); postPath = new URL(post[0].link).pathname; }
});
after(async () => {
  if (skip) return;
  await setSettings({ payouts: false, connection: "test", url: "" }).catch(() => {});
  await browser?.close();
});

// ---- helpers --------------------------------------------------------------------------------
const SETTINGS = WP + "/wp-admin/options-general.php?page=toll-gate";

async function setSettings(o: { payouts: boolean; connection: "test" | "server"; url: string; key?: string }) {
  await A.goto(SETTINGS);
  await A.setChecked("#toll-payouts", o.payouts);
  await A.click("details.toll-adv > summary");
  await A.selectOption("#toll-connection", o.connection);
  if (o.connection === "server") {
    await A.fill("#toll-server-url", o.url);
    if (o.key) await A.fill("#toll-server-key", o.key);
  }
  await A.click("button.button-primary");
  await A.waitForURL(/page=toll-gate/);
  await A.getByText("Settings saved.").waitFor();
}

const CSV_COLUMNS = ["date", "timezone", ...COUNTERS, "challenges_minted", "since", "exported_at"];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
type CsvExport = { rows: Record<string, string>[]; today: Record<string, number> };

/** Download the owner's CSV, check its shape, and return the rows plus today's (UTC) counts. */
async function exportCsvFull(): Promise<CsvExport> {
  await A.goto(SETTINGS);
  const href = await A.getAttribute("#toll-export", "href");
  const r = await admin.request.get(href!);
  assert.equal(r.status(), 200);
  assert.match(r.headers()["content-type"], /^text\/csv/);
  assert.match(r.headers()["content-disposition"], /attachment; filename="toll-counters.csv"/);
  const [head, ...lines] = (await r.text()).trim().split(/\r\n/);
  assert.equal(head, CSV_COLUMNS.join(","), "date, timezone, the Node counter names, challenges_minted, since, exported_at");
  const rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [CSV_COLUMNS[i], v])));
  const last = rows[rows.length - 1];
  assert.equal(last.date, new Date().toISOString().slice(0, 10), "last row is today in UTC");
  const today = Object.fromEntries([...COUNTERS, "challenges_minted"].map((k) => [k, Number(last[k])]));
  return { rows, today };
}
async function exportCsv(): Promise<Record<string, number>> {
  return (await exportCsvFull()).today;
}

async function getPass(action = "write") {
  const c = (await (await fetch(`${WP}/wp-json/toll/v1/challenge?action=${action}&path=/wp-comments-post.php`)).json()).challenge;
  const s = await solveWork(c.work);
  const r = await fetch(WP + "/wp-json/toll/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id: c.id, challenge: c, solution: { work: { counter: s!.counter, derivedKey: s!.derivedKey } } }) });
  return { c, s, r, j: await r.json() };
}

const postComment = (fields: Record<string, string>) =>
  fetch(WP + "/wp-comments-post.php", { method: "POST", redirect: "manual", body: new URLSearchParams({ comment: "hello " + Math.random(), author: "Ann", email: "ann@example.test", comment_post_ID: postId, ...fields }) });

/** Coin words and vendor names in text, as "term: match". */
function scanText(text: string): string[] {
  const hits: string[] = [];
  for (const { re, term } of [...lintRegexes(), ...vendorRegexes()] as { re: RegExp; term: string }[]) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) hits.push(`${term}: "${m[0]}"`);
  }
  return hits;
}

/** The plugin screen's own text: rendered text plus placeholders, labels and values. */
const settingsText = (p: Page) => p.evaluate(() => {
  const root = document.getElementById("toll-gate-settings")!;
  const attrs = Array.from(root.querySelectorAll("[placeholder],[aria-label],[title],option,input[type=submit],button")).map((e: any) => [e.getAttribute("placeholder"), e.getAttribute("aria-label"), e.getAttribute("title"), e.textContent].filter(Boolean).join(" "));
  return root.innerText + "\n" + attrs.join("\n");
});

const visible = (p: Page, sel: string) => p.locator(sel).first().isVisible();

/** Admin screens: grow the viewport to the page height so the fixed admin bar and menu draw once. */
async function shot(p: Page, name: string, full = true) {
  if (!RENDERS) return;
  if (!full) return void (await p.screenshot({ path: `${RENDERS}/${name}.png` }));
  // Reload so the one-time "Settings saved." notice is gone, keeping Advanced open if it was.
  const open = await p.locator("details.toll-adv").evaluate((d: HTMLDetailsElement) => d.open);
  await p.reload();
  if (open) await p.click("details.toll-adv > summary");
  const vp = p.viewportSize()!;
  const h = await p.evaluate(() => document.documentElement.scrollHeight);
  await p.setViewportSize({ width: vp.width, height: h });
  await p.screenshot({ path: `${RENDERS}/${name}.png` });
  await p.setViewportSize(vp);
}

// ---- REST issuer and the comment gate --------------------------------------------------------
test("WP issuer: health, challenge, redeem -> 900 s / 20-use pass + HttpOnly cookie, replay refused, paid redeem refused", { skip }, async () => {
  const h = await (await fetch(WP + "/wp-json/toll/v1/health")).json();
  assert.deepEqual(h, { ok: true, v: "1.0.0", settlement: "off" });
  const ch = await (await fetch(WP + "/wp-json/toll/v1/challenge?action=write")).json();
  assert.deepEqual(ch.offers, [], "WordPress takes no payments: never an offer");
  assert.equal(ch.challenge.alg, "pbkdf2-sha256");
  assert.equal(ch.challenge.bound.action, "write");
  assert.equal((await fetch(WP + "/wp-json/toll/v1/challenge?action=read")).status, 400);
  const { c, s, r, j } = await getPass();
  assert.equal(r.status, 200);
  assert.equal(j.cls, "write");
  assert.equal(j.rail, "work");
  assert.equal(j.exp - c.iat >= 899 && j.exp - c.iat <= 905, true, "pass lives 900 s");
  const cookie = r.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^toll_pass=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  const st = await (await fetch(WP + "/wp-json/toll/v1/status", { headers: { authorization: "Toll " + j.pass } })).json();
  assert.deepEqual([st.ok, st.cls, st.n], [true, "write", 20]);
  const again = await fetch(WP + "/wp-json/toll/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id: c.id, challenge: c, solution: { work: { counter: s!.counter, derivedKey: s!.derivedKey } } }) });
  assert.deepEqual([again.status, await again.json()], [401, { error: "replay" }]);
  const paid = await fetch(WP + "/wp-json/toll/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offer_id: "x", kind: "ln402", preimage: "00", macaroon: "x" }) });
  assert.equal(paid.status, 400);
});

test("comments fail closed: accepted with a pass (one use spent), 403 with none or a bad one; counters move with the same names as Node", { skip }, async () => {
  const before = await exportCsv();
  const { j } = await getPass();
  const ok = await postComment({ "toll-pass": j.pass });
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get("location") ?? "", /#comment-\d+/);
  const st = await (await fetch(WP + "/wp-json/toll/v1/status", { headers: { authorization: "Toll " + j.pass } })).json();
  assert.equal(st.n, 19);
  const none = await postComment({});
  assert.equal(none.status, 403);
  assert.match(await none.text(), /This form needs JavaScript\./);
  assert.equal((await postComment({ "toll-pass": "not-a-pass" })).status, 403);
  // The pass cookie works as well as the hidden field.
  assert.equal((await fetch(WP + "/wp-comments-post.php", { method: "POST", redirect: "manual", headers: { cookie: "toll_pass=" + j.pass }, body: new URLSearchParams({ comment: "cookie " + Math.random(), author: "Ann", email: "ann@example.test", comment_post_ID: postId }) })).status, 302);
  const after = await exportCsv();
  const d = Object.fromEntries(COUNTERS.map((k) => [k, after[k] - before[k]]));
  assert.deepEqual(d, { pass_accept: 2, pass_reject: 1, pass_absent: 1, turned_away: 2, offer_shown: 0, paid: 0, work_after_402: 0 });
});

test("login is gated (account class): a write pass does not cover it; no pass -> error, the password is never checked", { skip }, async () => {
  const { j } = await getPass("write");
  for (const pass of [undefined, j.pass]) {
    const r = await fetch(WP + "/wp-login.php", { method: "POST", redirect: "manual", headers: { cookie: "wordpress_test_cookie=WP%20Cookie%20check" }, body: new URLSearchParams({ log: "admin", pwd: "wrong", ...(pass ? { "toll-pass": pass } : {}) }) });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /This form needs JavaScript\./);
    assert.doesNotMatch(html, /password you entered/i, "authentication stops before the password check");
  }
});

test("siteverify mirrors Node: success with the site secret, invalid-input-secret otherwise; 20 uses per pass, even under a race", { skip }, async () => {
  await A.goto(SETTINGS);
  const secret = await A.inputValue("#toll-secret");
  const { j } = await getPass();
  const sv = (body: Record<string, string>) => fetch(WP + "/wp-json/toll/v1/siteverify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) }).then((r) => r.json());
  assert.deepEqual(await sv({ secret: "wrong", response: j.pass }), { success: false, "error-codes": ["invalid-input-secret"] });
  const ok = await sv({ secret, response: j.pass, action: "write" });
  assert.equal(ok.success, true);
  assert.equal(ok.action, "write");
  assert.equal(ok.hostname, "127.0.0.1");
  assert.deepEqual(await sv({ secret, response: "garbage" }), { success: false, "error-codes": ["invalid-input-response"] });
  // 20 uses per pass: one was spent above, 19 more succeed in parallel, then it is used up.
  const rs = await Promise.all(Array.from({ length: 22 }, () => sv({ secret, response: j.pass })));
  assert.equal(rs.filter((r) => r.success).length, 19, "exactly the remaining uses, even when requests race");
  assert.deepEqual(rs.find((r) => !r.success), { success: false, "error-codes": ["timeout-or-duplicate"] });
});

test("Export counters: plain link on the 'Challenges issued today' line with the help line; owner-only (login + nonce)", { skip }, async () => {
  await A.goto(SETTINGS);
  const line = await A.locator(".toll-stat").innerText();
  assert.match(line, /^Challenges issued today: [\d,]+ · Export counters$/);
  assert.equal(await A.locator(".toll-export-help").innerText(), "Downloads the counts as a CSV file. Nothing is sent anywhere.");
  const href = (await A.getAttribute("#toll-export", "href"))!;
  assert.match(href, /admin-post\.php\?action=toll_gate_export&_wpnonce=/);
  const anon = await fetch(href, { redirect: "manual" });
  assert.notEqual(anon.headers.get("content-type")?.startsWith("text/csv"), true, "logged out: no CSV");
  const noNonce = await admin.request.get(WP + "/wp-admin/admin-post.php?action=toll_gate_export", { maxRedirects: 0 });
  assert.notEqual(noNonce.headers()["content-type"]?.startsWith("text/csv"), true, "no nonce: no CSV");
  const c = await exportCsv();
  assert.ok(c.pass_accept >= 1);
});

test("CSV: one row per UTC day for the last 30 days, oldest first; timezone column; since and exported_at in ISO UTC; challenges_minted counts each challenge and drives 'Challenges issued today'", { skip }, async () => {
  const a = await exportCsvFull();
  assert.equal(a.rows.length, 30);
  const day = (i: number) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
  assert.deepEqual(a.rows.map((r) => r.date), Array.from({ length: 30 }, (_, i) => day(29 - i)));
  for (const r of a.rows) {
    assert.equal(r.timezone, "UTC");
    assert.match(r.since, ISO_UTC);
    assert.match(r.exported_at, ISO_UTC);
    for (const k of [...COUNTERS, "challenges_minted"]) assert.match(r[k], /^\d+$/, k);
  }
  assert.ok(Math.abs(Date.parse(a.rows[0].exported_at) - Date.now()) < 120000, "exported_at is now");
  assert.ok(Date.parse(a.rows[0].since) <= Date.now());
  for (let i = 0; i < 3; i++) await fetch(`${WP}/wp-json/toll/v1/challenge?action=write&path=/wp-comments-post.php`);
  const b = await exportCsvFull();
  assert.equal(b.today.challenges_minted - a.today.challenges_minted, 3, "each issued challenge is counted");
  assert.equal(b.rows[0].since, a.rows[0].since, "since does not move");
  await A.goto(SETTINGS);
  const shown = /Challenges issued today: ([\d,]+)/.exec(await A.locator(".toll-stat").innerText())![1].replace(/,/g, "");
  assert.equal(Number(shown), b.today.challenges_minted, "the admin line is today's UTC challenges_minted");
});

test("site key field is a text input styled like the other fields, so the underscore in site_… is not clipped", { skip }, async () => {
  await A.goto(SETTINGS);
  await A.click("details.toll-adv > summary");
  const key = A.locator("#toll-site-key");
  assert.equal(await key.getAttribute("type"), "text");
  assert.match(await key.inputValue(), /^site_[0-9a-f]+$/);
  const box = (sel: string) => A.locator(sel).evaluate((el) => { const s = getComputedStyle(el); return { minHeight: s.minHeight, lineHeight: s.lineHeight, padding: s.padding }; });
  assert.deepEqual(await box("#toll-site-key"), await box("#toll-server-url"), "same box as the Payment server address field");
  // The underscore sits below the baseline: a line box of 'normal' height clips it at 1x.
  const lh = await key.evaluate((el) => { const s = getComputedStyle(el); return parseFloat(s.lineHeight) / parseFloat(s.fontSize); });
  assert.ok(lh >= 1.75, `line-height ${lh}x leaves room for the underscore`);
});

// ---- Settings → Toll states (design/proto/wp-settings.html) ----------------------------------
test("settings default: payouts off, no Balance row, Advanced collapsed, Test mode selected; copy matches docs/copy.md", { skip }, async () => {
  await setSettings({ payouts: false, connection: "test", url: "" });
  await A.goto(SETTINGS);
  assert.equal(await A.isChecked("#toll-payouts"), false);
  assert.equal(await visible(A, "tr.has-addr"), false);
  assert.equal(await visible(A, "tr.needs-noaddr"), false);
  assert.equal(await A.locator("details.toll-adv").getAttribute("open"), null, "collapsed on every load");
  for (const t of ["Protect these forms", "Visitors get an invisible check. Forms that skip it are rejected.", "Comments", "Login", "Registration", "Lost password", "Visible check", "Off by default. Most sites don't need it.", "Longest check", "Keys", "Created when you installed the plugin.", "Usage payouts", "Collect usage payouts", "High-volume clients can pay per request. You withdraw from the dashboard."]) {
    assert.ok(await A.getByText(t, { exact: true }).first().count(), t);
  }
  assert.equal(await A.inputValue("#toll-longest"), "8");
  assert.deepEqual(await A.locator("#toll-connection option").allTextContents(), ["Test mode (no real money)", "Payment server"]);
  await shot(A, "wp-settings-default");
});

test("settings test mode: Balance $0.00 with the fee line, never the no-address warning; address and key rows hidden; withdraw checks the balance", { skip }, async () => {
  await setSettings({ payouts: true, connection: "test", url: "" });
  await A.click("details.toll-adv > summary");
  assert.equal(await visible(A, "tr.needs-noaddr"), false);
  assert.equal(await A.locator(".toll-bal.not-down strong").innerText(), "$0.00");
  assert.equal(await A.locator(".toll-bal.not-down span").innerText(), "available to withdraw, after the 10% platform fee");
  assert.ok(await visible(A, "text=To withdraw, open Advanced settlement below."));
  assert.ok(await visible(A, "text=Test mode lets clients pay with test funds so you can try payouts safely."));
  assert.equal(await visible(A, "#toll-server-url"), false);
  assert.equal(await visible(A, "#toll-server-key"), false);
  assert.equal(await A.locator("#toll-invoice").getAttribute("placeholder"), "Paste a payout invoice for up to $0.00");
  assert.equal(await A.isEnabled("#toll-withdraw"), true);
  await shot(A, "wp-settings-test-mode");
  await A.fill("#toll-invoice", "lnstub11000m1" + "a".repeat(64) + "b".repeat(16));
  await A.click("#toll-withdraw");
  await A.getByText("That invoice is for more than your available balance.").waitFor();
  await A.click("details.toll-adv > summary");
  await A.fill("#toll-invoice", "not an invoice");
  await A.click("#toll-withdraw");
  await A.getByText("That invoice couldn't be paid. Check the amount and try again.").waitFor();
});

test("settings Payment server, no address: inline warning in the Balance row, Withdraw disabled; typing an address clears it before saving", { skip }, async () => {
  await setSettings({ payouts: true, connection: "server", url: "" });
  await A.click("details.toll-adv > summary");
  const warn = A.locator("tr.needs-noaddr .notice.notice-warning.inline");
  assert.ok(await warn.isVisible());
  assert.equal(await warn.innerText(), "Payouts start once a payment server address is added.");
  assert.equal(await visible(A, "tr.has-addr"), false, "no balance shown that the plugin can't back up");
  assert.equal(await A.isDisabled("#toll-withdraw"), true);
  assert.equal(await A.isDisabled("#toll-invoice"), true);
  assert.equal(await A.locator("#toll-server-url").getAttribute("placeholder"), "https://pay.example.com");
  assert.ok(await visible(A, "text=Payouts need a server that can take payments. Paste its address here. Protection keeps working on this site without it."));
  assert.ok(await visible(A, "text=Stored on this server only. Never sent to visitors' browsers."));
  assert.equal(await visible(A, "text=Test mode lets clients pay with test funds so you can try payouts safely."), false);
  await shot(A, "wp-settings-no-address");
  await A.fill("#toll-server-url", "https://pay.example.com");
  assert.equal(await warn.isVisible(), false);
  assert.equal(await A.isEnabled("#toll-withdraw"), true);
  // Back to Test mode: the warning never shows there.
  await A.fill("#toll-server-url", "");
  await A.selectOption("#toll-connection", "test");
  assert.equal(await warn.isVisible(), false);
});

test("settings Payment server down: notice-warning at the top, '—' over 'Balance will show again shortly', Withdraw disabled", { skip }, async () => {
  await setSettings({ payouts: true, connection: "server", url: DEAD, key: "dead-server-key-0123456789" });
  await A.click("details.toll-adv > summary");
  const n = A.locator(".notice.notice-warning.toll-top.needs-down");
  assert.ok(await n.isVisible());
  assert.equal(await n.innerText(), "The payment server isn't responding. Visitors and clients can still get through with the background check.");
  const box = A.locator(".toll-bal.needs-down");
  assert.ok(await box.isVisible());
  assert.equal(await box.locator("strong").innerText(), "—");
  assert.equal(await box.locator("span").innerText(), "Balance will show again shortly");
  assert.equal(await visible(A, ".toll-bal.not-down"), false);
  assert.equal(await A.isDisabled("#toll-withdraw"), true);
  assert.equal(await A.isDisabled("#toll-invoice"), true);
  assert.equal(await A.locator("#toll-invoice").getAttribute("placeholder"), null, "no amount the plugin can't back up");
  assert.doesNotMatch(await A.content(), /dead-server-key-0123456789/, "the key is never printed into the page");
  await shot(A, "wp-settings-server-down");
});

test("settings Payment server connected (local Node issuer, stub backend): balance and fee come from the server; withdraw over the balance refused", { skip: skip || (demoUp ? false : "Node demo on :8787 not running") }, async () => {
  await setSettings({ payouts: true, connection: "server", url: DEMO, key: demoKey });
  await A.click("details.toll-adv > summary");
  const b = await (await fetch(DEMO + "/v1/owner/balance", { headers: { authorization: "Bearer " + demoKey } })).json();
  assert.equal(await visible(A, ".notice.toll-top.needs-down"), false);
  assert.equal(await A.locator(".toll-bal.not-down strong").innerText(), b.available_usd);
  assert.equal(await A.locator(".toll-bal.not-down span").innerText(), `available to withdraw, after the ${b.fee_bps / 100}% platform fee`);
  assert.equal(await A.isEnabled("#toll-withdraw"), true);
  assert.doesNotMatch(await A.content(), new RegExp(demoKey), "the key is never printed into the page");
  await shot(A, "wp-settings-connected");
  await A.fill("#toll-invoice", `lnstub1${b.available_msat + 1000}m1` + "c".repeat(64) + "d".repeat(16));
  await A.click("#toll-withdraw");
  await A.getByText("That invoice is for more than your available balance.").waitFor();
});

test("copy lint on the plugin's screens: no coin words or vendor names on Settings → Toll (every state) or the Plugins row", { skip }, async () => {
  const hits: string[] = [];
  for (const s of [{ payouts: false, connection: "test" as const, url: "" }, { payouts: true, connection: "test" as const, url: "" }, { payouts: true, connection: "server" as const, url: "" }, { payouts: true, connection: "server" as const, url: DEAD }]) {
    await setSettings(s);
    await A.click("details.toll-adv > summary");
    hits.push(...scanText(await settingsText(A)).map((h) => JSON.stringify(s) + " " + h));
  }
  await A.goto(WP + "/wp-admin/plugins.php");
  hits.push(...scanText(await A.locator('tr[data-plugin="toll-gate/toll-gate.php"]').innerText()).map((h) => "plugins row " + h));
  assert.deepEqual(hits, []);
  // The scanner itself catches a leak.
  assert.ok(scanText("Pay with sats").length && scanText("Protected by ALTCHA").length);
  await setSettings({ payouts: false, connection: "test", url: "" });
});

// ---- the comment form in a browser ----------------------------------------------------------
for (const width of [390, 1440]) {
  test(`comment form at ${width}px: posts after the invisible check; no coin or vendor words; hidden widget parts take no space; no third-party requests`, { skip }, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width === 390, userAgent: width === 390 ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" : undefined });
    const page = await ctx.newPage();
    const foreign: string[] = [];
    const errors: string[] = [];
    page.on("request", (q) => { const u = new URL(q.url()); if (u.origin !== WP && !["data:", "blob:"].includes(u.protocol)) foreign.push(q.url()); });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(WP + postPath);
    const form = page.locator("#commentform");
    await form.scrollIntoViewIfNeeded();
    assert.equal(await page.locator("#commentform toll-gate[action=write]").count(), 1);
    const text = `Comment from ${width}px ${Math.random().toString(36).slice(2, 8)}`;
    await page.fill("#comment", text);
    await page.fill("#author", "Ann");
    await page.fill("#email", "ann@example.test");
    // Widget parts that are hidden must have no box (the zero-size button rule).
    const hiddenBad = await page.evaluate(() => {
      const g = document.querySelector("toll-gate") as any;
      const bad: string[] = [];
      const gr = g.getBoundingClientRect();
      if (g.hidden && (gr.width || gr.height)) bad.push("toll-gate " + gr.width + "x" + gr.height);
      for (const el of Array.from((g.shadowRoot?.querySelectorAll("[hidden]") ?? []) as HTMLElement[])) { const r = el.getBoundingClientRect(); if (r.width || r.height) bad.push(el.className + " " + r.width + "x" + r.height); }
      for (const b of Array.from(document.querySelectorAll("#commentform button, #commentform input[type=submit]")) as HTMLElement[]) { const r = b.getBoundingClientRect(); if (getComputedStyle(b).display !== "none" && (r.width === 0 || r.height === 0)) bad.push("visible zero-size " + b.outerHTML.slice(0, 60)); }
      return bad;
    });
    assert.deepEqual(hiddenBad, []);
    const scan = await page.evaluate(() => { const g = document.querySelector("toll-gate") as any; return [document.body.innerText, g.outerHTML, g.shadowRoot?.innerHTML ?? "", g.shadowRoot?.textContent ?? ""].join("\n"); });
    assert.deepEqual(scanText(scan), []);
    await shot(page, `wp-comment-form-${width}`, false);
    await page.click("#commentform [type=submit]");
    await page.waitForURL(/#comment-\d+/, { timeout: 30000 });
    assert.ok(await page.getByText(text).first().isVisible());
    await page.getByText(text).first().scrollIntoViewIfNeeded();
    assert.deepEqual(foreign, []);
    assert.deepEqual(errors, []);
    await shot(page, `wp-comment-posted-${width}`, false);
    await ctx.close();
  });
}

test("no JavaScript: the comment form shows the note and the POST is rejected", { skip }, async () => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto(WP + postPath);
  // (Playwright's text locators skip <noscript>, so read the rendered text directly.)
  assert.match(await page.evaluate(() => document.body.innerText), /This form needs JavaScript\./);
  await page.fill("#comment", "no js " + Math.random());
  await page.fill("#author", "Ann");
  await page.fill("#email", "ann@example.test");
  const [resp] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/wp-comments-post.php")), page.click("#commentform [type=submit]")]);
  assert.equal(resp.status(), 403);
  await ctx.close();
});
