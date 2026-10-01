// Amendment 3 (agent discovery), in process: manifest copy and shape, prices from the same function
// as the 402 offer, free with no challenge, the MCP tool list, the end-to-end MCP flow with a test
// payment, and the discovery lint rule. Live targets (Node, WordPress, edge) are in discovery-live.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startDemo, PAID_ON, TEST_SECRET, type Running } from "./helpers.ts";
import { McpClient } from "./mcp-client.ts";
import { MCP_COUNTERS } from "../packages/mcp/src/server.ts";
import { TOOLS, MANIFEST_DESCRIPTION, NOT_FOR, INPUT_SCHEMAS, buildManifest } from "../packages/server-node/src/manifest.ts";
// @ts-ignore plain JS helper
import { lintDiscovery } from "../scripts/copy-lib.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const COPY = readFileSync(ROOT + "docs/copy.md", "utf8");
const WP_DISCOVERY = readFileSync(ROOT + "packages/wp-toll-gate/includes/discovery.php", "utf8");

let paid: Running;
let off: Running;
let mcp: McpClient;
before(async () => {
  paid = await startDemo({ work: { standard: { cost: 500 } }, ...PAID_ON });
  off = await startDemo({ work: { standard: { cost: 500 } } });
  mcp = new McpClient();
  await mcp.init();
});
after(async () => { mcp?.close(); await paid?.close(); await off?.close(); });

const minted = (r: Running) => r.events.filter((e) => e.event === "challenge_minted").length;
const agentPost = (r: Running, path: string) => fetch(r.url + path, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent" }, body: "{}" });

test("copy: tool names and descriptions, the 147-character seed and not_for are docs/copy.md verbatim, in Node and WordPress", () => {
  assert.equal(MANIFEST_DESCRIPTION.length, 147);
  assert.ok(COPY.includes(`(147 characters): "${MANIFEST_DESCRIPTION}"`));
  for (const t of TOOLS) {
    assert.ok(COPY.includes("`" + t.name + "`: \"" + t.description + "\""), t.name);
    assert.ok(WP_DISCOVERY.includes(t.description.replace(/'/g, "'")), "WordPress carries " + t.name + " verbatim");
  }
  assert.deepEqual(TOOLS.map((t) => t.name), ["price_write_action", "gate_form_write", "verify_write_pass"]);
  assert.ok(COPY.includes('`not_for`, exact: ["page views", "crawler blocking", "citation licensing"]'));
  assert.deepEqual([...NOT_FOR], ["page views", "crawler blocking", "citation licensing"]);
  assert.ok(WP_DISCOVERY.includes(MANIFEST_DESCRIPTION));
});

test("GET /.well-known/toll.json and agents.json: 200, no pass, no challenge, challenges_minted unchanged, counted", async () => {
  const before = minted(paid);
  const m = await fetch(paid.url + "/.well-known/toll.json");
  assert.equal(m.status, 200);
  assert.equal(m.headers.get("access-control-allow-origin"), "*");
  const doc: any = await m.json();
  assert.equal(doc.name, "Toll");
  assert.equal(doc.description, MANIFEST_DESCRIPTION);
  assert.equal(doc.reads_free, true);
  assert.deepEqual(doc.not_for, [...NOT_FOR]);
  assert.equal(doc.api, paid.url + "/v1");
  assert.deepEqual(doc.tools.map((t: any) => [t.name, t.description]), TOOLS.map((t) => [t.name, t.description]));
  for (const t of doc.tools) assert.deepEqual(t.input_schema, INPUT_SCHEMAS[t.name as keyof typeof INPUT_SCHEMAS]);
  const p = await fetch(paid.url + "/.well-known/agents.json");
  assert.equal(p.status, 200);
  assert.deepEqual(await p.json(), { manifest: paid.url + "/.well-known/toll.json" }, "a pointer only, no second description");
  assert.equal(minted(paid), before, "no challenge minted");
  const snap = paid.demo.toll.metrics.snapshot();
  assert.equal(snap.manifest_fetch, 1);
  assert.equal(snap.agents_json_fetch, 1);
  assert.ok(paid.events.some((e) => e.event === "manifest_fetch" && Object.keys(e).sort().join() === "event,ts"), "event line with no visitor fields");
});

test("prices: manifest, /v1/price and MCP price_write_action equal the live 402 offer (write $0.0100, search $0.0020, both (test))", async () => {
  const doc: any = await (await fetch(paid.url + "/.well-known/toll.json")).json();
  const gate = doc.tools.find((t: any) => t.name === "gate_form_write");
  for (const [action, path, display] of [["write", "/comments", "$0.0100 (test)"], ["search", "/search", "$0.0020 (test)"]] as const) {
    const r = await agentPost(paid, path);
    assert.equal(r.status, 402);
    const offer = (await r.json()).offers[0];
    const fromManifest = gate.price.by_action[action];
    const fromMcp = (await mcp.call("price_write_action", { site: paid.url, action })).price;
    for (const p of [fromManifest, fromMcp]) {
      assert.equal(p.amount_msat, offer.amount_msat, action);
      assert.equal(p.usd, offer.display.usd, action);
      assert.equal(p.status, "test");
      assert.equal(p.display, display);
    }
  }
  assert.equal(gate.price.display, "$0.0100 (test)", "the tool's headline price is a write");
  for (const t of doc.tools) for (const v of JSON.stringify(t.price).match(/"display":"[^"]*"/g) ?? []) assert.match(v, /\((test|stub)\)"$/, "never a bare number");
  assert.equal(doc.tools.find((t: any) => t.name === "price_write_action").price.display, "$0.0000 (test)");
});

test("settlement off: prices are null with status stub, payment lists no method, x402 stub", async () => {
  const doc: any = await (await fetch(off.url + "/.well-known/toll.json")).json();
  const gate = doc.tools.find((t: any) => t.name === "gate_form_write");
  assert.deepEqual(gate.price.by_action.write, { amount_msat: null, usd: null, status: "stub", display: null });
  assert.deepEqual(gate.payment, { status: "stub", protocol: "none", methods: [], x402: { status: "stub" } });
  const pr: any = await (await fetch(off.url + "/v1/price?action=write")).json();
  assert.equal(pr.status, "stub");
  assert.equal(pr.amount_msat, null);
  assert.match(pr.work.challenge_url, /offers=0/);
  assert.equal((await fetch(off.url + "/v1/price?action=read")).status, 400, "reads are never priced");
  const paidDoc: any = await (await fetch(paid.url + "/.well-known/toll.json")).json();
  assert.deepEqual(paidDoc.tools[1].payment, { status: "stub", protocol: "HTTP 402", methods: [{ kind: "ln402", status: "test" }], x402: { status: "stub" } });
});

test("MCP tools/list: exactly the three tools with the exact copy and input schemas", async () => {
  const r = await mcp.request("tools/list");
  assert.deepEqual(r.result.tools.map((t: any) => t.name), ["price_write_action", "gate_form_write", "verify_write_pass"]);
  for (const t of r.result.tools) {
    const c = TOOLS.find((x) => x.name === t.name)!;
    assert.equal(t.description, c.description);
    assert.deepEqual(t.inputSchema, INPUT_SCHEMAS[c.name]);
  }
  assert.ok(r.result.tools.find((t: any) => t.name === "price_write_action").description.includes("Not for page views"));
});

test("MCP end to end with a test payment: offer -> pay (test backend) -> pass -> write accepted -> verify_write_pass", async () => {
  const before = mcp.counters();
  const g = await mcp.call("gate_form_write", { site: paid.url, action: "write", path: "/comments" });
  assert.equal(g.offers.length, 1);
  assert.ok(g.challenge?.id, "and a work challenge");
  const pay = async (offer: any) => (await (await fetch(paid.url + "/demo/stub-pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invoice: offer.invoice }) })).json()).preimage;
  const offer = g.offers[0];
  const passed = await mcp.call("gate_form_write", { site: paid.url, action: "write", payment: { offer_id: offer.id, kind: offer.kind, preimage: await pay(offer), macaroon: offer.macaroon } });
  assert.equal(passed.paid, true);
  const w = await fetch(paid.url + "/comments", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: "Toll " + passed.pass, "toll-client": "agent" }, body: "name=mcp&comment=paid+write" });
  assert.ok(w.status < 400, "the write went through: " + w.status);
  // A second paid pass, checked by the site's own server.
  const g2 = await mcp.call("gate_form_write", { site: paid.url, action: "write", path: "/comments" });
  const o2 = g2.offers[0];
  const p2 = await mcp.call("gate_form_write", { site: paid.url, action: "write", payment: { offer_id: o2.id, kind: o2.kind, preimage: await pay(o2), macaroon: o2.macaroon } });
  assert.deepEqual(await mcp.call("verify_write_pass", { site: paid.url, secret: TEST_SECRET, pass: p2.pass, action: "write" }), { valid: true, action: "write", hostname: new URL(paid.url).hostname });
  const again = await mcp.call("verify_write_pass", { site: paid.url, secret: TEST_SECRET, pass: p2.pass, action: "write" });
  assert.equal(again.valid, false, "unused: a one-use pass verifies once");
  assert.equal((await mcp.call("verify_write_pass", { site: paid.url, secret: "wrong", pass: p2.pass })).reason, "invalid-input-secret");
  const replay = await mcp.call("gate_form_write", { site: paid.url, action: "write", payment: { offer_id: o2.id, kind: o2.kind, preimage: "0".repeat(64), macaroon: o2.macaroon } });
  assert.equal(replay.paid, false);
  const c = mcp.counters();
  assert.equal(c.mcp_call_gate_form_write - (before.mcp_call_gate_form_write ?? 0), 5);
  assert.equal(c.mcp_offer_returned - (before.mcp_offer_returned ?? 0), 2);
  assert.equal(c.mcp_paid - (before.mcp_paid ?? 0), 2);
  assert.equal(c.mcp_call_verify_write_pass - (before.mcp_call_verify_write_pass ?? 0), 3);
  assert.equal(c.timezone, "UTC");
  assert.equal(c.day, new Date().toISOString().slice(0, 10));
  const allowed = ["ts", "event", "day", "timezone", ...MCP_COUNTERS].sort().join();
  for (const l of mcp.stderr) assert.equal(Object.keys(JSON.parse(l)).sort().join(), allowed, "counter lines carry only the day and the counts: no ids, no secrets");
});

test("MCP adds no reads gating: GET / stays 200 and mints nothing while the tools are in use", async () => {
  const before = minted(paid);
  await mcp.call("price_write_action", { site: paid.url, action: "write" });
  assert.equal((await fetch(paid.url + "/")).status, 200);
  assert.equal(minted(paid), before, "price lookup and page view mint nothing");
});

test("lint: only payment objects may name the payment method; descriptions stay under the full list", () => {
  const doc = buildManifest({ api: "https://x.test/v1", docs: null, status: "test", prices: null });
  assert.deepEqual(lintDiscovery(doc), []);
  const bad = structuredClone(doc) as any;
  bad.tools[0].description += " Pay with lightning.";
  bad.tools[1].payment.methods.push({ kind: "lightning" });
  const hits = lintDiscovery(bad);
  assert.ok(hits.some((h: any) => h.path === "tools[0].description"), "description is linted");
  assert.ok(!hits.some((h: any) => h.path.includes("payment")), "payment objects may name the method");
  bad.description = "Invisible check, ln402 inside";
  assert.ok(lintDiscovery(bad).some((h: any) => h.path === "description" && /payment method/.test(h.term)));
});
