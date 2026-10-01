// M10 (Amendment 2): reads stay free on the live local targets. Plain GETs to / and to unmapped
// pages, from a browser-like client and from an agent, get the origin's own answer (200 for pages
// that exist), never a 402 or 403, and no challenge is minted. Skips any target that isn't running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const DEMO = process.env.TOLL_DEMO ?? "http://127.0.0.1:8787";
const WP = process.env.TOLL_WP ?? "http://127.0.0.1:8888";
const EDGE = process.env.TOLL_EDGE ?? "http://127.0.0.1:8789";
const EDGE_LOG = process.env.TOLL_EDGE_LOG ?? "/tmp/edge.log";
const WPCLI = process.env.WP_CLI ?? "/workspace/wp-local/wp-cli.phar";
const WPPATH = process.env.WP_PATH ?? "/workspace/wp-local/site";
const ROUNDS = 20;

async function up(url: string) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}
const demoUp = await up(DEMO + "/v1/health");
const wpUp = (await up(WP + "/wp-json/toll/v1/health")) && existsSync(WPCLI);
const edgeUp = demoUp && (await up(EDGE + "/v1/health"));

const HEADERS = [
  { accept: "text/html", "user-agent": "Mozilla/5.0 (reader)" },
  { accept: "application/json", "toll-client": "agent", "user-agent": "agent/1.0" },
];

/** GET every path ROUNDS times with both clients; returns status counts per path. */
async function hammer(base: string, paths: string[]) {
  const out: Record<string, Record<number, number>> = {};
  for (const p of paths) {
    out[p] = {};
    for (let i = 0; i < ROUNDS; i++) for (const h of HEADERS) {
      const r = await fetch(base + p, { headers: h, redirect: "manual" });
      await r.arrayBuffer();
      assert.notEqual(r.status, 402, `${base}${p} must not ask for payment`);
      assert.notEqual(r.status, 403, `${base}${p} must not challenge`);
      assert.equal(r.headers.get("www-authenticate"), null, `${base}${p}: no payment challenge header`);
      out[p][r.status] = (out[p][r.status] ?? 0) + 1;
    }
  }
  return out;
}
const demoMinted = async () => (await (await fetch(DEMO + "/demo/stats")).json()).paid.challenges_minted as number;
const wpCounters = () => JSON.parse(execFileSync("php", [WPCLI, "--path=" + WPPATH, "eval", "echo json_encode(toll_gate_counters_today());"], { encoding: "utf8" }).trim().split("\n").pop()!);
const edgeEvents = () => existsSync(EDGE_LOG) ? (readFileSync(EDGE_LOG, "utf8").match(/"(?:ev|event)":"(?:challenge_minted|pass_absent|pass_reject)"/g) ?? []).length : null;

test("M10 Node demo: GET / and unmapped pages are free; challenges_minted does not move", { skip: demoUp ? false : "demo not running on " + DEMO }, async () => {
  const before = await demoMinted();
  const r = await hammer(DEMO, ["/", "/hammer", "/blog/some-article", "/feed", "/docs/intro", "/contact", "/search?q=reads"]);
  for (const p of ["/", "/hammer"]) assert.deepEqual(r[p], { 200: ROUNDS * 2 }, p);
  assert.equal(await demoMinted(), before, "no challenge minted for page views");
  console.log("M10 demo", JSON.stringify(r), "challenges_minted", before, "->", await demoMinted());
});

test("M10 WordPress: GET /, posts, feed, login page and unmapped pages are free; counters do not move", { skip: wpUp ? false : "WordPress not running on " + WP }, async () => {
  const post = await (await fetch(WP + "/wp-json/wp/v2/posts?per_page=1")).json();
  const postPath = Array.isArray(post) && post[0] ? new URL(post[0].link).pathname : "/?p=1";
  const before = wpCounters();
  const r = await hammer(WP, ["/", postPath, "/feed/", "/?s=reads", "/wp-login.php", "/blog/some-article/"]);
  for (const p of ["/", postPath, "/feed/", "/?s=reads", "/wp-login.php"]) assert.deepEqual(r[p], { 200: ROUNDS * 2 }, p);
  const after = wpCounters();
  for (const k of ["challenges_minted", "turned_away", "pass_absent", "pass_reject", "offer_shown"]) assert.equal(after[k], before[k], k);
  console.log("M10 wp", JSON.stringify(r), "challenges_minted", before.challenges_minted, "->", after.challenges_minted);
});

test("M10 edge: GETs are proxied before any Toll code, even under write and account prefixes", { skip: edgeUp ? false : "edge worker not running on " + EDGE }, async () => {
  const before = await demoMinted();
  const ev0 = edgeEvents();
  const paths = ["/", "/hammer", "/blog/some-article", "/feed", "/contact", "/api/things", "/wp-login.php"];
  const r = await hammer(EDGE, paths);
  for (const p of paths) {
    const direct = (await fetch(DEMO + p, { redirect: "manual" })).status;
    assert.deepEqual(r[p], { [direct]: ROUNDS * 2 }, `${p}: the origin's own answer (${direct})`);
  }
  assert.equal(await demoMinted(), before, "origin minted nothing");
  if (ev0 !== null) { await new Promise((res) => setTimeout(res, 300)); assert.equal(edgeEvents(), ev0, "edge logged no challenge or gate event"); }
  console.log("M10 edge", JSON.stringify(r), "edge gate events", ev0, "->", edgeEvents());
});
