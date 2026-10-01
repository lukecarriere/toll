// Batched counter writes on the WordPress plugin (packages/wp-toll-gate/includes/counters.php).
//   - a request writes its counters once, at shutdown, in one statement (never more than one write);
//   - reads write nothing and move no counter (M10);
//   - the add happens in the database, so concurrent requests and processes never lose a count;
//   - the 30-day CSV keeps its exact shape.
// A test-only must-use plugin is dropped into the local site for the duration of this file: it counts
// the INSERT/UPDATE/DELETE statements that touch counter rows, per HTTP request, and appends one JSON
// line per request to a log. It is removed in after(). Every response body in this file is read to the
// end: PHP's built-in server closes the connection after each response, and an unread body there can
// crash Node's fetch (undici "assert(!this.paused)"); reading it also means the request, shutdown hooks
// included, has finished on the server before the test looks at the log or the counters. Needs the local site from
// packages/wp-toll-gate/dev/setup-local-wp.sh; skipped when it isn't running.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { agentPay } from "../packages/agent/src/agent-pay.ts";

const WP = (process.env.WP_URL ?? "http://127.0.0.1:8888").replace(/\/$/, "");
const WPCLI = process.env.WP_CLI ?? "/workspace/wp-local/wp-cli.phar";
const WPPATH = process.env.WP_PATH ?? "/workspace/wp-local/site";
const DEMO = process.env.TOLL_DEMO_URL ?? "http://127.0.0.1:8787";
const ISSUER = WP + "/wp-json/toll";
const MU = WPPATH + "/wp-content/mu-plugins/zz-toll-test-counter-writes.php";
// One log per site, not per run, so the must-use plugin's source is the same on every run. PHP's built-in
// server caches compiled scripts (opcache) and rechecks a file only every opcache.revalidate_freq
// seconds (2 s by default): a plugin with this process's pid baked in kept running in its previous version,
// writing to the previous run's log, for up to 2 s after before() rewrote it (M10: 43 of 60 reads).
const LOG = "/tmp/toll-counter-writes-" + createHash("sha256").update(WPPATH).digest("hex").slice(0, 12) + ".jsonl";
const run = promisify(execFile);

async function up(url: string) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); await r.arrayBuffer(); return r.ok; } catch { return false; }
}
const skip = (await up(WP + "/wp-json/toll/v1/health")) && existsSync(WPCLI) ? false : `local WordPress not running at ${WP}`;

const wpEval = (php: string) => execFileSync("php", [WPCLI, "--path=" + WPPATH, "eval", php], { encoding: "utf8" }).trim();
const counts = (): Record<string, number> => JSON.parse(wpEval("echo wp_json_encode(toll_gate_counters_today());"));
type Line = { method: string; uri: string; writes: number; sql: string[] };
const lines = (): Line[] => existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const resetLog = () => rmSync(LOG, { force: true });

before(() => {
  if (skip) return;
  mkdirSync(WPPATH + "/wp-content/mu-plugins", { recursive: true });
  writeFileSync(MU, `<?php
// Test-only (tests/wp-counters.test.ts): counts counter-row writes per HTTP request. Removed after the run.
if (PHP_SAPI === 'cli') return;
$GLOBALS['toll_test_cw'] = [];
add_filter('query', function ($q) {
    if (preg_match('/^\\s*(INSERT|UPDATE|DELETE|REPLACE)\\b/i', $q) && preg_match('/toll_gate_n_|toll_gate_counting_since/', $q)) $GLOBALS['toll_test_cw'][] = substr($q, 0, 300);
    return $q;
}, PHP_INT_MAX);
add_action('shutdown', function () {
    file_put_contents(${JSON.stringify(LOG)}, json_encode(['method' => $_SERVER['REQUEST_METHOD'] ?? '', 'uri' => $_SERVER['REQUEST_URI'] ?? '', 'writes' => count($GLOBALS['toll_test_cw']), 'sql' => $GLOBALS['toll_test_cw']]) . "\\n", FILE_APPEND | LOCK_EX);
}, PHP_INT_MAX);
`);
});
after(() => { rmSync(MU, { force: true }); resetLog(); });

test("unit: count() touches no table; flush() is one statement for many rows and adds to what is stored", { skip }, () => {
  const out = JSON.parse(wpEval(`
    global $wpdb; $w = 0;
    add_filter('query', function ($q) use (&$w) { if (preg_match('/^\\s*(INSERT|UPDATE|DELETE|REPLACE)\\b/i', $q)) $w++; return $q; });
    $before = toll_gate_counters_today();
    toll_gate_count('pass_absent'); toll_gate_count('turned_away', 2); toll_gate_count('pass_absent'); toll_gate_count('not_a_counter'); toll_gate_count('paid', 0);
    $afterCount = $w;
    $n = toll_gate_counters_flush();
    $again = toll_gate_counters_flush();
    $after = toll_gate_counters_today();
    echo wp_json_encode(['writes_before_flush' => $afterCount, 'statements' => $n, 'second_flush' => $again, 'writes' => $w,
      'd_pass_absent' => $after['pass_absent'] - $before['pass_absent'], 'd_turned_away' => $after['turned_away'] - $before['turned_away'], 'd_paid' => $after['paid'] - $before['paid'],
      'since' => toll_gate_counting_since()]);`).split("\n").pop()!);
  assert.equal(out.writes_before_flush, 0, "counting alone writes nothing");
  assert.equal(out.statements, 1);
  assert.equal(out.second_flush, 0, "an empty buffer is not written");
  assert.equal(out.writes, 1, "three counter rows plus counting_since in one write");
  assert.deepEqual([out.d_pass_absent, out.d_turned_away, out.d_paid], [2, 2, 0]);
  assert.match(out.since, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "counting_since kept as before");
});

test("unit: counting_since is set by the first flush and never moved by later ones", { skip }, () => {
  const out = JSON.parse(wpEval(`
    $keep = get_option('toll_gate_counting_since');
    delete_option('toll_gate_counting_since');
    toll_gate_count('pass_absent'); toll_gate_counters_flush();
    wp_cache_delete('toll_gate_counting_since', 'options'); $first = get_option('toll_gate_counting_since');
    $wpdb = $GLOBALS['wpdb']; $wpdb->update($wpdb->options, ['option_value' => '1000000000'], ['option_name' => 'toll_gate_counting_since']);
    toll_gate_count('pass_absent'); toll_gate_counters_flush();
    wp_cache_delete('toll_gate_counting_since', 'options'); $second = get_option('toll_gate_counting_since');
    update_option('toll_gate_counting_since', $keep, false);
    echo wp_json_encode(['first' => $first, 'second' => $second, 'now' => time()]);`).split("\n").pop()!);
  assert.ok(Math.abs(Number(out.first) - out.now) < 30, "first flush seeds counting_since with the current time");
  assert.equal(out.second, "1000000000", "a later flush leaves counting_since alone");
});

test("unit: a failed flush returns 0, logs one error line and moves no counter (counts are dropped, not retried)", { skip }, () => {
  const out = JSON.parse(wpEval(`
    global $wpdb; $log = tempnam(sys_get_temp_dir(), 'toll-flush-'); ini_set('error_log', $log);
    $before = toll_gate_counters_today();
    toll_gate_count('pass_absent');
    $keep = $wpdb->options; $wpdb->options = $wpdb->prefix . 'toll_no_such_table';
    $n = toll_gate_counters_flush();
    $wpdb->options = $keep;
    $again = toll_gate_counters_flush();
    $after = toll_gate_counters_today();
    $lines = array_values(array_filter(explode("\\n", (string) file_get_contents($log)))); unlink($log);
    echo wp_json_encode(['n' => $n, 'again' => $again, 'd' => $after['pass_absent'] - $before['pass_absent'], 'lines' => $lines]);`).split("\n").pop()!);
  assert.equal(out.n, 0, "a failed write is not reported as written");
  assert.equal(out.again, 0, "the buffer was emptied; nothing is retried");
  assert.equal(out.d, 0);
  assert.equal(out.lines.length, 1, "exactly one error_log line: " + JSON.stringify(out.lines));
  assert.match(out.lines[0], /Toll: counter flush failed: \S.*(doesn't exist|not found)/);
});

test("M10 reads: 0 counter writes and no counter moves on /, a post, the feed, search, the login page and the price lookup", { skip }, async () => {
  const post = await (await fetch(WP + "/wp-json/wp/v2/posts?per_page=1")).json();
  const postPath = Array.isArray(post) && post[0] ? new URL(post[0].link).pathname : "/?p=1";
  const paths = ["/", postPath, "/feed/", "/?s=reads", "/wp-login.php", "/wp-json/toll/v1/price?action=write"];
  const c0 = counts();
  resetLog();
  for (const p of paths) for (const h of [{ accept: "text/html" }, { accept: "application/json", "toll-client": "agent" }] as Record<string, string>[]) {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(WP + p, { headers: h, redirect: "manual" });
      await r.arrayBuffer();
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get("www-authenticate"), null, p);
    }
  }
  const l = lines();
  assert.equal(l.length, paths.length * 10, "every read was logged: " + JSON.stringify(l.reduce((m, x) => ({ ...m, [x.uri]: (m[x.uri] ?? 0) + 1 }), {} as Record<string, number>)));
  assert.deepEqual(l.filter((x) => x.writes !== 0), [], "reads write no counter rows");
  assert.deepEqual(counts(), c0, "no counter moved");
  console.log(`  M10 reads: ${l.length} GETs, ${l.reduce((a, x) => a + x.writes, 0)} counter writes`);
});

test("discovery GETs keep their existing counts (manifest_fetch, agents_json_fetch) with exactly 1 write each", { skip }, async () => {
  const c0 = counts();
  resetLog();
  for (let i = 0; i < 5; i++) for (const p of ["/.well-known/toll.json", "/.well-known/agents.json"]) {
    const r = await fetch(WP + p);
    await r.arrayBuffer();
    assert.equal(r.status, 200);
  }
  const c1 = counts();
  assert.equal(c1.manifest_fetch - c0.manifest_fetch, 5);
  assert.equal(c1.agents_json_fetch - c0.agents_json_fetch, 5);
  assert.deepEqual([...new Set(lines().map((x) => x.writes))], [1]);
});

test("Test mode agent-pay 20: same deltas as before, every write request makes at most 1 counter write", { skip }, async () => {
  wpEval("$s = toll_gate_settings(); $s['payouts'] = 0; $s['connection'] = 'test'; $s['server_url'] = ''; toll_gate_update_settings($s);");
  const post = await (await fetch(WP + "/wp-json/wp/v2/posts?per_page=1")).json();
  const postId = Array.isArray(post) && post[0] ? String(post[0].id) : "1";
  const c0 = counts();
  resetLog();
  const r = await agentPay({ base: WP, issuer: ISSUER, path: "/wp-comments-post.php", form: { comment_post_ID: postId, author: "Agent", email: "agent@example.test" }, field: "comment", payUrl: DEMO + "/demo/stub-pay", statsBase: DEMO, writes: 20 });
  assert.equal(r.accepted, 20);
  const c1 = counts();
  const d = Object.fromEntries(Object.keys(c0).map((k) => [k, c1[k] - c0[k]]));
  // Same expectations as tests/wp-agent.test.ts "(b) Test mode: agent-pay 20", which held before batching.
  assert.deepEqual({ offer_shown: d.offer_shown, paid: d.paid, work_after_402: d.work_after_402, turned_away: d.turned_away, pass_accept: d.pass_accept, challenges_minted: d.challenges_minted }, { offer_shown: 0, paid: 0, work_after_402: 0, turned_away: 20, pass_accept: 20, challenges_minted: 20 });
  const l = lines();
  const max = Math.max(...l.map((x) => x.writes));
  const total = l.reduce((a, x) => a + x.writes, 0);
  assert.ok(max <= 1, "no request made more than one counter write: " + JSON.stringify(l.filter((x) => x.writes > 1)));
  const counted = Object.values(d).reduce((a, n) => a + n, 0);
  console.log(`  agent-pay 20: ${l.length} requests, ${total} counter writes (max ${max} per request) for ${counted} counts; deltas ${JSON.stringify(d)}`);
  wpEval("foreach (get_comments(['author_email' => 'agent@example.test', 'status' => 'all', 'number' => 0]) as $c) wp_delete_comment($c->comment_ID, true);");
});

test("concurrency: 60 parallel challenge requests land exactly +60 challenges_minted", { skip }, async () => {
  const c0 = counts();
  const rs = await Promise.all(Array.from({ length: 60 }, () => fetch(WP + "/wp-json/toll/v1/challenge?action=write&path=/wp-comments-post.php").then(async (r) => { await r.arrayBuffer(); return r.status; })));
  assert.deepEqual([...new Set(rs)], [200]);
  assert.equal(counts().challenges_minted - c0.challenges_minted, 60);
});

test("concurrency: 24 parallel processes x 50 flushes on the same rows lose nothing", { skip }, async () => {
  const c0 = counts();
  const php = "for ($i = 0; $i < 50; $i++) { toll_gate_count('pass_reject'); toll_gate_count('work_after_402', 3); toll_gate_counters_flush(); }";
  await Promise.all(Array.from({ length: 24 }, () => run("php", [WPCLI, "--path=" + WPPATH, "eval", php])));
  const c1 = counts();
  assert.equal(c1.pass_reject - c0.pass_reject, 24 * 50);
  assert.equal(c1.work_after_402 - c0.work_after_402, 24 * 50 * 3);
  // Put the local site's counts back where they were.
  wpEval(`global $wpdb; $d = toll_gate_counter_day(); foreach (['pass_reject' => ${24 * 50}, 'work_after_402' => ${24 * 50 * 3}] as $k => $n) $wpdb->query($wpdb->prepare("UPDATE {$wpdb->options} SET option_value = option_value - %d WHERE option_name = %s", $n, "toll_gate_n_{$d}_$k"));`);
});

test("CSV: header, 30 day rows oldest first, values read back the same as before batching", { skip }, () => {
  const now = Math.floor(Date.now() / 1000);
  const csv = wpEval(`echo toll_gate_counters_csv(${now});`);
  const rows = csv.trim().split("\r\n");
  assert.equal(rows[0], "date,timezone,pass_accept,pass_reject,pass_absent,turned_away,offer_shown,paid,work_after_402,challenges_minted,page_view_gate_confirmed,manifest_fetch,agents_json_fetch,since,exported_at");
  assert.equal(rows.length, 31);
  const today = rows[30].split(",");
  const c = counts();
  assert.deepEqual(today.slice(2, 13).map(Number), ["pass_accept", "pass_reject", "pass_absent", "turned_away", "offer_shown", "paid", "work_after_402", "challenges_minted", "page_view_gate_confirmed", "manifest_fetch", "agents_json_fetch"].map((k) => c[k]));
});
