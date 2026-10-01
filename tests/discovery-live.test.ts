// Amendment 3 acceptance on the live local targets: Node demo :8787, WordPress :8888 (Payment server
// = the demo, test backend), edge :8789 (work only). Per target: the manifest and pointer are 200
// with no challenge and don't move challenges_minted; MCP tools/list has the exact copy; the manifest
// price and MCP price_write_action equal the live 402 offer for the same action (the edge has no
// paid offer: all three say so); an MCP flow runs end to end (test payment, or work at the edge).
// Skips any target that isn't running.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { McpClient } from "./mcp-client.ts";
import { TOOLS, INPUT_SCHEMAS } from "../packages/server-node/src/manifest.ts";
import { solveWork } from "../packages/work-adapter/src/index.ts";

const DEMO = process.env.TOLL_DEMO ?? "http://127.0.0.1:8787";
const WP = process.env.TOLL_WP ?? "http://127.0.0.1:8888";
const EDGE = process.env.TOLL_EDGE ?? "http://127.0.0.1:8789";
const EDGE_LOG = process.env.TOLL_EDGE_LOG ?? "/tmp/edge.log";
const EDGE_VARS = new URL("../packages/edge-cf/.dev.vars", import.meta.url);
const WPCLI = process.env.WP_CLI ?? "/workspace/wp-local/wp-cli.phar";
const WPPATH = process.env.WP_PATH ?? "/workspace/wp-local/site";
const DEMO_KEY_FILE = new URL("../demo/.owner-key", import.meta.url);

async function up(url: string) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}
const demoUp = await up(DEMO + "/v1/health");
const demoKey = existsSync(DEMO_KEY_FILE) ? readFileSync(DEMO_KEY_FILE, "utf8").trim() : "";
const wpUp = demoUp && demoKey !== "" && (await up(WP + "/wp-json/toll/v1/health")) && existsSync(WPCLI);
const edgeUp = (await up(EDGE + "/v1/health")) && existsSync(EDGE_VARS);

const mcp = new McpClient();
await mcp.init();
after(() => mcp.close());
const results: Record<string, unknown> = {};
after(() => console.log("A3 acceptance " + JSON.stringify(results)));

const wpEval = (php: string) => execFileSync("php", [WPCLI, "--path=" + WPPATH, "eval", php], { encoding: "utf8" }).trim().split("\n").pop()!;
const wpCounters = () => JSON.parse(wpEval("echo wp_json_encode(toll_gate_counters_today());"));
function wpMode(server: boolean) {
  wpEval(`$s = toll_gate_settings(); $s['payouts'] = ${server ? 1 : 0}; $s['connection'] = '${server ? "server" : "test"}'; $s['server_url'] = '${server ? DEMO : ""}'; toll_gate_update_settings($s);` + (server ? ` update_option('toll_gate_server_key', ${JSON.stringify(demoKey)}, false);` : "") + " toll_gate_server_down_reset(); delete_transient('toll_gate_price_cache');");
}
const demoMinted = async () => (await (await fetch(DEMO + "/demo/stats")).json()).paid.challenges_minted as number;
const demoCounter = async (k: string) => Number(new RegExp(`<th>${k}</th><td>(\\d+)</td>`).exec(await (await fetch(DEMO + "/v1/health", { headers: { accept: "text/html" } })).text())![1]);
const edgeLines = (ev: string) => (existsSync(EDGE_LOG) ? readFileSync(EDGE_LOG, "utf8").match(new RegExp(`"event":"${ev}"`, "g")) ?? [] : []).length;
const settle = () => new Promise((r) => setTimeout(r, 300));
const agentPost = (url: string, form: Record<string, string> = { x: "1" }) => fetch(url, { method: "POST", redirect: "manual", headers: { accept: "application/json", "toll-client": "agent", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
const pay = async (offer: any) => (await (await fetch(DEMO + "/demo/stub-pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invoice: offer.invoice }) })).json()).preimage as string;

async function fetchDiscovery(base: string) {
  const m = await fetch(base + "/.well-known/toll.json");
  const p = await fetch(base + "/.well-known/agents.json");
  assert.equal(m.status, 200);
  assert.equal(p.status, 200);
  for (const r of [m, p]) assert.equal(r.headers.get("www-authenticate"), null);
  const doc: any = await m.json();
  assert.deepEqual(await p.json(), { manifest: base + "/.well-known/toll.json" });
  assert.deepEqual(doc.tools.map((t: any) => [t.name, t.description]), TOOLS.map((t) => [t.name, t.description]));
  for (const t of doc.tools) assert.deepEqual(t.input_schema, INPUT_SCHEMAS[t.name as keyof typeof INPUT_SCHEMAS], t.name);
  assert.equal(doc.reads_free, true);
  assert.deepEqual(doc.not_for, ["page views", "crawler blocking", "citation licensing"]);
  return doc;
}
/** Manifest price, MCP price and the live 402 offer for one action must agree. */
async function parity(base: string, doc: any, action: string, offer: any) {
  const m = doc.tools.find((t: any) => t.name === "gate_form_write").price.by_action[action];
  const p = (await mcp.call("price_write_action", { site: base, action })).price;
  for (const x of [m, p]) {
    assert.equal(x.amount_msat, offer.amount_msat, `${base} ${action} amount`);
    assert.equal(x.usd, offer.display.usd, `${base} ${action} usd`);
    assert.equal(x.display, `$${offer.display.usd} (test)`);
  }
  return m.display;
}

test("MCP tools/list returns exactly the three tools with the exact copy", async () => {
  const r = await mcp.request("tools/list");
  assert.deepEqual(r.result.tools.map((t: any) => [t.name, t.description]), TOOLS.map((t) => [t.name, t.description]));
});

test("A3 Node demo: manifest free, prices equal the live 402, MCP flow with a test payment", { skip: demoUp ? false : "demo not running" }, async () => {
  const m0 = await demoMinted();
  const f0 = await demoCounter("manifest_fetch");
  const a0 = await demoCounter("agents_json_fetch");
  const doc = await fetchDiscovery(DEMO);
  const m1 = await demoMinted();
  assert.equal(m1, m0, "manifest mints no challenge");
  assert.equal(await demoCounter("manifest_fetch"), f0 + 1);
  assert.equal(await demoCounter("agents_json_fetch"), a0 + 1);
  const shown: Record<string, string> = {};
  for (const [action, path] of [["write", "/comments"], ["search", "/search"]]) {
    const r = await agentPost(DEMO + path);
    assert.equal(r.status, 402);
    shown[action] = await parity(DEMO, doc, action, (await r.json()).offers[0]);
  }
  assert.deepEqual(shown, { write: "$0.0100 (test)", search: "$0.0020 (test)" });
  const g = await mcp.call("gate_form_write", { site: DEMO, action: "write", path: "/comments" });
  const o = g.offers[0];
  const p = await mcp.call("gate_form_write", { site: DEMO, action: "write", payment: { offer_id: o.id, kind: o.kind, preimage: await pay(o), macaroon: o.macaroon } });
  assert.equal(p.paid, true);
  const w = await fetch(DEMO + "/comments", { method: "POST", redirect: "manual", headers: { authorization: "Toll " + p.pass, "toll-client": "agent", accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: "name=mcp&comment=paid+via+mcp" });
  assert.ok(w.status < 400, "paid write accepted: " + w.status);
  // The live demo's site secret is random per run, so only the refusal path is checkable here (the valid path is in discovery.test.ts).
  assert.equal((await mcp.call("verify_write_pass", { site: DEMO, secret: "not-the-secret", pass: p.pass })).reason, "invalid-input-secret");
  results.node = { manifest: 200, agents_json: 200, challenges_minted: [m0, m1], prices: shown, mcp_paid_write: w.status };
});

test("A3 WordPress (Payment server = demo, test backend): manifest free, prices equal the live 402, MCP flow with a test payment", { skip: wpUp ? false : "WordPress or the demo not running" }, async () => {
  wpMode(true);
  try {
    const c0 = wpCounters();
    const doc = await fetchDiscovery(WP);
    const c1 = wpCounters();
    assert.equal(c1.challenges_minted, c0.challenges_minted, "manifest mints no challenge");
    assert.equal(c1.manifest_fetch, c0.manifest_fetch + 1);
    assert.equal(c1.agents_json_fetch, c0.agents_json_fetch + 1);
    assert.equal(doc.api, WP + "/wp-json/toll/v1");
    const post = await (await fetch(WP + "/wp-json/wp/v2/posts?per_page=1")).json();
    const shown: Record<string, string> = {};
    const w = await agentPost(WP + "/wp-comments-post.php", { comment_post_ID: String(post[0]?.id ?? 1), author: "Agent", email: "agent@example.test", comment: "price check" });
    assert.equal(w.status, 402);
    shown.write = await parity(WP, doc, "write", (await w.json()).offers[0]);
    const l = await agentPost(WP + "/wp-login.php", { log: "nobody", pwd: "x" });
    assert.equal(l.status, 402);
    shown.account = await parity(WP, doc, "account", (await l.json()).offers[0]);
    assert.deepEqual(shown, { write: "$0.0100 (test)", account: "$0.0250 (test)" });
    const g = await mcp.call("gate_form_write", { site: WP, action: "write", path: "/wp-comments-post.php" });
    assert.equal(g.offers.length, 1, "offer relayed from the payment server");
    const o = g.offers[0];
    const p = await mcp.call("gate_form_write", { site: WP, action: "write", payment: { offer_id: o.id, kind: o.kind, preimage: await pay(o), macaroon: o.macaroon } });
    assert.equal(p.paid, true);
    const secret = wpEval("echo toll_gate_secret();");
    assert.equal((await mcp.call("verify_write_pass", { site: WP, secret, pass: p.pass, action: "write" })).valid, true);
    assert.equal((await mcp.call("verify_write_pass", { site: WP, secret, pass: p.pass, action: "write" })).valid, false, "one use");
    results.wp = { manifest: 200, agents_json: 200, challenges_minted: [c0.challenges_minted, c1.challenges_minted], manifest_fetch: [c0.manifest_fetch, c1.manifest_fetch], prices: shown, mcp_verify: "valid once" };
  } finally {
    wpMode(false);
  }
  const doc = await fetchDiscovery(WP);
  assert.equal(doc.tools[1].price.status, "stub", "Test mode: no paid offer, status stub");
});

test("A3 edge (work only): manifest free, no paid price anywhere (manifest, MCP, live answer), MCP flow with the work check", { skip: edgeUp ? false : "edge worker not running" }, async () => {
  const mf0 = edgeLines("manifest_fetch");
  const cm0 = edgeLines("challenge_minted");
  const doc = await fetchDiscovery(EDGE);
  await settle();
  assert.equal(edgeLines("manifest_fetch"), mf0 + 1);
  assert.equal(edgeLines("challenge_minted"), cm0, "manifest mints no challenge");
  const m = doc.tools[1].price.by_action.write;
  const p = (await mcp.call("price_write_action", { site: EDGE, action: "write" })).price;
  const live = await agentPost(EDGE + "/contact");
  const body: any = await live.json();
  assert.equal(live.status, 403, "the edge answers agents with the work check, never a 402");
  assert.equal(body.offers, undefined);
  for (const x of [m, p]) assert.deepEqual(x, { amount_msat: null, usd: null, status: "stub", display: null });
  const g = await mcp.call("gate_form_write", { site: EDGE, action: "write", path: "/contact" });
  assert.deepEqual(g.offers, []);
  const s = await solveWork(g.challenge.work);
  const r = await fetch(g.redeem_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id: g.challenge.id, challenge: g.challenge, client: "agent", solution: { work: { counter: s!.counter, derivedKey: s!.derivedKey }, took_ms: Math.round(s!.time) } }) });
  const pass = (await r.json()).pass;
  assert.ok(pass, "work redeemed for a pass");
  // The edge's local test secret (.dev.vars, gitignored): verify_write_pass is the site's own server's tool.
  const secret = /^SITE_SECRET=(.+)$/m.exec(readFileSync(EDGE_VARS, "utf8"))![1].trim().replace(/^"(.*)"$/, "$1");
  assert.equal((await mcp.call("verify_write_pass", { site: EDGE, secret, pass, action: "write" })).valid, true);
  results.edge = { manifest: 200, agents_json: 200, challenge_minted_lines: [cm0, cm0], price: "null (stub), live answer 403 work check", mcp_flow: "work -> pass -> valid" };
});

test("M11: MCP counters per UTC day for tools/list, each tool call, offers and paid calls", { skip: demoUp ? false : "demo not running" }, () => {
  const c = mcp.counters();
  assert.equal(c.day, new Date().toISOString().slice(0, 10));
  for (const k of ["mcp_tools_list", "mcp_call_price_write_action", "mcp_call_gate_form_write", "mcp_call_verify_write_pass", "mcp_offer_returned", "mcp_paid"]) assert.ok(c[k] >= 1, k);
  results.mcp_counters = c;
});
