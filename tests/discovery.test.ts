// Amendment 3 (agent discovery), in process: manifest copy and shape, prices from the same function
// as the 402 offer, free with no challenge, the MCP tool list, the end-to-end MCP flow with a test
// payment, and the discovery lint rule. Live targets (Node, WordPress, edge) are in discovery-live.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startDemo, PAID_ON, TEST_SECRET, type Running } from "./helpers.ts";
import { McpClient } from "./mcp-client.ts";
import { MCP_COUNTERS } from "../packages/mcp/src/server.ts";
import { TOOLS, MANIFEST_DESCRIPTION, NOT_FOR, INPUT_SCHEMAS, BASE_PRICE_NOTE, buildManifest } from "../packages/server-node/src/manifest.ts";
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

test("prices at load multiplier 1: manifest (base), /v1/price and MCP price_write_action (current) equal the live 402 offer (write $0.0100, search $0.0020, both (test))", async () => {
  // Pinned to x1: this demo has velocity off, and each side's multiplier is asserted, so load cannot make it flaky.
  assert.equal(paid.demo.toll.config.adaptive.velocity, false, "parity runs at load multiplier 1");
  const doc: any = await (await fetch(paid.url + "/.well-known/toll.json")).json();
  const gate = doc.tools.find((t: any) => t.name === "gate_form_write");
  for (const [action, path, display] of [["write", "/comments", "$0.0100 (test)"], ["search", "/search", "$0.0020 (test)"]] as const) {
    const r = await agentPost(paid, path);
    assert.equal(r.status, 402);
    const offer = (await r.json()).offers[0];
    const fromManifest = gate.price.by_action[action];
    const fromMcp = (await mcp.call("price_write_action", { site: paid.url, action })).price;
    assert.equal(fromManifest.basis, "base");
    assert.equal(fromMcp.basis, "current");
    assert.equal(fromMcp.load_multiplier, 1);
    for (const p of [fromManifest, fromMcp]) {
      assert.equal(p.amount_msat, offer.amount_msat, action);
      assert.equal(p.usd, offer.display.usd, action);
      assert.equal(p.status, "test");
      assert.equal(p.display, display);
    }
  }
  // docs/copy.md "Base price label": the manifest price is labelled base. Velocity is off here, so this
  // site's offers cannot rise and the note is omitted (PM option a: no promise the site cannot keep).
  assert.ok(COPY.includes(`carries this exact note: "${BASE_PRICE_NOTE}"`));
  assert.ok(WP_DISCOVERY.includes(BASE_PRICE_NOTE), "WordPress carries the note verbatim");
  assert.equal(gate.price.basis, "base");
  for (const t of doc.tools) assert.equal(t.price.basis, "base", t.name);
  for (const t of doc.tools) assert.equal(t.price.note, undefined, t.name + ": Node with velocity off, no base-price note");
  assert.equal(gate.price.display, "$0.0100 (test)", "the tool's headline price is a write");
  for (const t of doc.tools) for (const v of JSON.stringify(t.price).match(/"display":"[^"]*"/g) ?? []) assert.match(v, /\((test|stub)\)"$/, "never a bare number");
  assert.equal(doc.tools.find((t: any) => t.name === "price_write_action").price.display, "$0.0000 (test)");
});

test("settlement off: prices are null with status stub, payment lists no method, x402 stub", async () => {
  const doc: any = await (await fetch(off.url + "/.well-known/toll.json")).json();
  const gate = doc.tools.find((t: any) => t.name === "gate_form_write");
  assert.deepEqual(gate.price.by_action.write, { amount_msat: null, usd: null, status: "stub", display: null, basis: "base" });
  assert.equal(gate.price.note, undefined, "no paid price, so no base-price note");
  assert.deepEqual(gate.payment, { status: "stub", protocol: "none", methods: [], x402: { status: "stub" } });
  const pr: any = await (await fetch(off.url + "/v1/price?action=write")).json();
  assert.equal(pr.status, "stub");
  assert.equal(pr.amount_msat, null);
  assert.equal(pr.basis, "current");
  assert.equal(pr.load_multiplier, null);
  assert.match(pr.work.challenge_url, /offers=0/);
  assert.equal((await fetch(off.url + "/v1/price?action=read")).status, 400, "reads are never priced");
  const paidDoc: any = await (await fetch(paid.url + "/.well-known/toll.json")).json();
  assert.deepEqual(paidDoc.tools[1].payment, { status: "stub", protocol: "HTTP 402", methods: [{ kind: "ln402", status: "test" }], x402: { status: "stub" } });
});

test("load raised: MCP price_write_action returns the price that applies now and matches a live 402 at the raised price; the manifest stays the base", async () => {
  // Velocity on, with low steps so a few paid writes from this caller raise the multiplier: 2 -> x2, 4 -> x4.
  const hot = await startDemo({ work: { standard: { cost: 500 }, velocity_steps: [[2, 2], [4, 4]] }, adaptive: { velocity: true }, ...PAID_ON });
  try {
    const pay = async (offer: any) => (await (await fetch(hot.url + "/demo/stub-pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invoice: offer.invoice }) })).json()).preimage;
    const paidWrite = async () => {
      const g = await mcp.call("gate_form_write", { site: hot.url, action: "write", path: "/comments" });
      const o = g.offers[0];
      const r = await mcp.call("gate_form_write", { site: hot.url, action: "write", payment: { offer_id: o.id, kind: o.kind, preimage: await pay(o), macaroon: o.macaroon } });
      assert.equal(r.paid, true);
    };
    const live402 = async () => {
      const r = await agentPost(hot, "/comments");
      assert.equal(r.status, 402);
      return (await r.json()).offers[0];
    };
    const at1 = (await mcp.call("price_write_action", { site: hot.url, action: "write" })).price;
    const o1 = await live402();
    assert.deepEqual([at1.load_multiplier, at1.amount_msat, at1.display], [1, o1.amount_msat, "$0.0100 (test)"]);
    for (const [mult, msat, display] of [[2, 20000, "$0.0200 (test)"], [4, 40000, "$0.0400 (test)"]] as const) {
      await paidWrite();
      await paidWrite();
      const now = (await mcp.call("price_write_action", { site: hot.url, action: "write" })).price;
      const offer = await live402();
      const direct: any = await (await fetch(hot.url + "/v1/price?action=write")).json();
      assert.equal(now.basis, "current");
      assert.equal(now.load_multiplier, mult);
      assert.equal(offer.amount_msat, msat, "the live 402 went up with load");
      assert.equal(now.amount_msat, offer.amount_msat);
      assert.equal(now.usd, offer.display.usd);
      assert.equal(now.display, display);
      assert.deepEqual([direct.amount_msat, direct.display, direct.load_multiplier], [msat, display, mult], "/v1/price agrees");
    }
    const doc: any = await (await fetch(hot.url + "/.well-known/toll.json")).json();
    const gate = doc.tools.find((t: any) => t.name === "gate_form_write");
    assert.deepEqual([gate.price.amount_msat, gate.price.display, gate.price.basis, gate.price.note], [10000, "$0.0100 (test)", "base", BASE_PRICE_NOTE], "Node with velocity on: the manifest stays the base price, with the note");
    for (const t of doc.tools.filter((t: any) => t.name !== "gate_form_write")) assert.equal(t.price.note, undefined, t.name + " is free, so not a priced tool");
  } finally {
    await hot.close();
  }
});

test("base-price note follows load pricing: present only when a priced action's offers can rise", async () => {
  const prices = { write: { amount_msat: 10000, usd: "0.0100" }, search: { amount_msat: 2000, usd: "0.0020" }, account: { amount_msat: 25000, usd: "0.0250" }, admin: { amount_msat: 100000, usd: "0.1000" } };
  const note = (o: Parameters<typeof buildManifest>[0]) => buildManifest(o).tools.map((t: any) => t.price.note ?? null);
  const at = { api: "https://x.test/v1", docs: null, status: "test" as const };
  assert.deepEqual(note({ ...at, prices }), [null, null, null], "no load pricing reported: no note");
  assert.deepEqual(note({ ...at, prices, loadPricing: { write: false, search: false, account: false, admin: false } }), [null, null, null]);
  assert.deepEqual(note({ ...at, prices, loadPricing: { search: true } }), [null, BASE_PRICE_NOTE, null], "one priced action that can rise is enough");
  assert.deepEqual(note({ ...at, status: "stub", prices: null, loadPricing: { write: true } }), [null, null, null], "no paid price, no note");
  for (const doc of [buildManifest({ ...at, prices }), buildManifest({ ...at, prices, loadPricing: { write: true } })]) for (const t of doc.tools) assert.equal(t.price.basis, "base");
  // The payment server tells a WordPress site whether its relayed offers can rise. The relay applies no
  // load multiplier today, so it reports false for every class even with velocity on.
  const KEY = "owner-key-for-tests-0123456789";
  const srv = await startDemo({ work: { standard: { cost: 500 } }, adaptive: { velocity: true }, settlement: { ...PAID_ON.settlement, owner_key: KEY } });
  try {
    const own: any = await (await fetch(srv.url + "/v1/owner/price", { headers: { authorization: "Bearer " + KEY } })).json();
    assert.deepEqual(own.load_pricing, { search: false, write: false, account: false, admin: false });
    const doc: any = await (await fetch(srv.url + "/.well-known/toll.json")).json();
    assert.equal(doc.tools[1].price.note, BASE_PRICE_NOTE, "this issuer's own 402 does rise with velocity on");
  } finally {
    await srv.close();
  }
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
