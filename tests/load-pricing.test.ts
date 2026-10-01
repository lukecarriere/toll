// Load pricing on a WordPress site set to Payment server (be/wp-load-pricing), in process:
//   - the plugin's coarse network equals Node's (docs/net-vectors.json, PHP and Node both read it),
//     and the client address follows TOLL_TRUSTED_PROXIES;
//   - the payment server prices relayed offers and quotes for the site's visitor network with the
//     same policy as its own 402, and relayed paid redeems count toward that network's velocity;
//   - GET /v1/owner/price reports load_pricing only to a site that declares it sends networks (?net=1);
//   - POST /v1/owner/quote needs the owner key and mints and counts nothing;
//   - the network never shows up in logs, error answers, stores or files;
//   - the plugin's discovery code asks with net=1, keeps declared and undeclared answers apart, and
//     uses the quote for /price (base and null when the quote fails).
// The live WordPress legs of the parity check are in wp-load-pricing.test.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { coarseKey, coarseNet, isCoarseNet } from "../packages/protocol/src/index.ts";
import { StubSettler } from "../packages/settlement-ln/src/index.ts";
import { BASE_PRICE_NOTE } from "../packages/server-node/src/manifest.ts";
import { startDemo, PAID_ON, type Running } from "./helpers.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const V = JSON.parse(readFileSync(ROOT + "docs/net-vectors.json", "utf8"));
const KEY = "owner-key-load-pricing-0123456789";
const json = { "content-type": "application/json", accept: "application/json" };

const servers: Running[] = [];
after(async () => { for (const s of servers) await s.close(); });

/** A payment server with the owner API. Velocity steps are low (3 -> x2, 6 -> x4) and the window long, so a few paid redeems raise the price and the test cannot cross a window edge. */
async function paymentServer(velocity: boolean, settler?: StubSettler): Promise<Running> {
  const s = await startDemo({ work: { standard: { cost: 500 }, velocity_steps: [[3, 2], [6, 4]], velocity_window_s: 600 }, adaptive: { velocity }, settlement: { ...PAID_ON.settlement, owner_key: KEY } }, settler ? { settlement: { settler } } : {});
  // Direct requests in this file say which visitor they are with X-Forwarded-For from loopback.
  s.demo.app.set("trust proxy", "loopback");
  servers.push(s);
  return s;
}
const owner = (s: Running, path: string, body?: unknown, key: string | null = KEY) =>
  fetch(`${s.url}/v1/owner/${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...json, ...(key === null ? {} : { authorization: "Bearer " + key }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ownerJson = async (s: Running, path: string, body?: unknown) => { const r = await owner(s, path, body); assert.equal(r.status, 200, path); return r.json() as Promise<any>; };
const pay = async (s: Running, offer: any) => (await (await fetch(s.url + "/demo/stub-pay", { method: "POST", headers: json, body: JSON.stringify({ invoice: offer.invoice }) })).json() as any).preimage as string;
/** One paid write relayed by a site: offers then redeem through the owner API, both with `net` (or without it when undefined). */
async function relayPaid(s: Running, net?: unknown) {
  const o = await ownerJson(s, "offers", { action: "write", ...(net === undefined ? {} : { net }) });
  const offer = o.offers[0];
  const r = await owner(s, "redeem", { offer_id: offer.id, kind: "ln402", preimage: await pay(s, offer), macaroon: offer.macaroon, ...(net === undefined ? {} : { net }) });
  assert.equal(r.status, 200);
  await r.arrayBuffer();
  return offer.amount_msat as number;
}
const relayedAmount = async (s: Running, net?: unknown) => (await ownerJson(s, "offers", { action: "write", ...(net === undefined ? {} : { net }) })).offers[0].amount_msat as number;
const quote = (s: Running, net?: unknown) => ownerJson(s, "quote", { action: "write", ...(net === undefined ? {} : { net }) });
/** The server's own 402 for an agent at `ip`. */
async function own402(s: Running, ip: string) {
  const r = await fetch(s.url + "/comments", { method: "POST", headers: { ...json, "toll-client": "agent", "x-forwarded-for": ip }, body: "{}" });
  assert.equal(r.status, 402);
  return ((await r.json()) as any).offers[0].amount_msat as number;
}
const ownPrice = async (s: Running, ip: string) => (await (await fetch(s.url + "/v1/price?action=write", { headers: { "x-forwarded-for": ip } })).json()) as any;

// ---- shared vectors -------------------------------------------------------------------------------
const php = (args: string[], input?: string) => execFileSync("php", args, { encoding: "utf8", input });

test("vectors: Node coarseNet gives the expected network for every address, and the plugin's PHP gives the same", () => {
  assert.ok(V.coarse_net.length >= 50);
  for (const [ip, want] of V.coarse_net) assert.equal(coarseNet(ip), want, JSON.stringify(ip));
  const out = JSON.parse(php([ROOT + "tests/php/run-net-vectors.php", "--json"]));
  assert.equal(out.coarse_net.length, V.coarse_net.length);
  for (const [i, [ip, got]] of out.coarse_net.entries()) assert.equal(got, coarseNet(V.coarse_net[i][0]), `PHP == Node for ${JSON.stringify(ip)}`);
  // Every kind is covered: IPv4, mapped (both cases), IPv6 compressed, full, uppercase, "::", and junk.
  for (const ip of ["203.0.113.77", "::ffff:203.0.113.77", "::FFFF:198.51.100.9", "2001:db8:abcd:12::1", "2001:0db8:abcd:0012:0000:0000:0000:0001", "2001:DB8:ABCD:12::1", "::", "fe80::1%eth0", "unknown"]) assert.ok(V.coarse_net.some((v: any[]) => v[0] === ip), ip);
});

test("vectors: the PHP runner passes on its own (npm test runs it too)", () => {
  const out = php([ROOT + "tests/php/run-net-vectors.php"]);
  assert.match(out, /: (\d+) passed, 0 failed\n$/);
  assert.equal(Number(/: (\d+) passed/.exec(out)![1]), V.coarse_net.length + V.client_ip.length + 1);
});

test("coarseKey: a network from coarseNet keys the same velocity bucket as any address in it (so a relayed net and the server's own 402 share a count)", () => {
  for (const [ip, net] of V.coarse_net) {
    if (net === null) continue;
    assert.ok(isCoarseNet(net), `${net} is in the accepted form`);
    assert.equal(coarseKey("site_x", ip, "write"), `site_x|${net}|write`, `raw address ${ip}`);
    assert.equal(coarseKey("site_x", net, "write"), coarseKey("site_x", ip, "write"), `network ${net} passes through coarseKey unchanged`);
  }
  assert.equal(coarseKey("s", "203.0.113.0/24", "write"), coarseKey("s", "203.0.113.200", "write"));
  assert.equal(coarseKey("s", "2001:0db8:0001::/48", "account"), coarseKey("s", "2001:db8:1:ffff::9", "account"));
});

test("isCoarseNet: only the exact coarseNet form is accepted as net", () => {
  for (const n of V.net_valid) assert.equal(isCoarseNet(n), true, n);
  for (const n of V.net_invalid) assert.equal(isCoarseNet(n), false, JSON.stringify(n));
});

test("client address (TOLL_TRUSTED_PROXIES): every vector, from the shared fixture, on the plugin's PHP", () => {
  const out = JSON.parse(php([ROOT + "tests/php/run-net-vectors.php", "--json"]));
  assert.equal(out.client_ip.length, V.client_ip.length);
  for (const [i, c] of V.client_ip.entries()) assert.deepEqual(out.client_ip[i], [c.name, c.expect, c.expect_net], c.name);
  const names = V.client_ip.map((c: any) => c.name).join("\n");
  for (const k of ["forged", "trusted proxy: its", "several trusted hops", "stops the walk: the client sends 1.2.3.4, the trusted proxy appends unknown", "with a port", "bracketed IPv6", "empty entry",
    "X-Forwarded-For missing", "X-Forwarded-For empty", "only commas", "every X-Forwarded-For entry a listed proxy", "::ffff:10.0.0.5", "::ffff:10.0.0.7", "::ffff:1.2.3.4", "IPv6 CIDR proxy", "IPv4 CIDR", "IPv6 CIDR"]) assert.ok(names.includes(k), k);
});

test("client address vectors on Node: the net for each expected address is what coarseNet gives (so a mapped IPv4 client is its IPv4 network on both sides)", () => {
  for (const c of V.client_ip) {
    if (c.expect === null) assert.equal(c.expect_net, null, c.name);
    else assert.equal(coarseNet(c.expect), c.expect_net, c.name);
  }
  const em = V.client_ip.find((c: any) => c.xff === "1.2.3.4, unknown");
  assert.ok(em && em.trusted === "127.0.0.1" && em.remote === "127.0.0.1" && em.expect === null && em.expect_net === null, "the client sends 1.2.3.4 and the proxy appends unknown: no net");
  assert.equal(coarseNet("::ffff:1.2.3.4"), "1.2.3.0/24");
});

/** toll_gate_client_ip() and toll_gate_visitor_net() with the constant defined (or not) in wp-config style. */
function withConstant(trusted: string | null, server: Record<string, string>) {
  const code = `<?php declare(strict_types=1); const ABSPATH = '/';` + (trusted === null ? "" : ` define('TOLL_TRUSTED_PROXIES', ${JSON.stringify(trusted)});`) +
    ` require ${JSON.stringify(ROOT + "packages/wp-toll-gate/includes/network.php")}; $_SERVER = ${phpArray(server)};` +
    ` echo json_encode([toll_gate_client_ip(), toll_gate_visitor_net()]);`;
  return JSON.parse(php([], code));
}
const phpArray = (o: Record<string, string>) => "[" + Object.entries(o).map(([k, v]) => `${JSON.stringify(k)} => ${JSON.stringify(v)}`).join(", ") + "]";

test("TOLL_TRUSTED_PROXIES from wp-config: unset or empty reads REMOTE_ADDR only; set, a forged header from elsewhere is ignored and the proxy's is honoured", () => {
  const forged = { REMOTE_ADDR: "198.51.100.20", HTTP_X_FORWARDED_FOR: "203.0.113.9" };
  const proxied = { REMOTE_ADDR: "127.0.0.1", HTTP_X_FORWARDED_FOR: "192.0.2.66, 203.0.113.9" };
  assert.deepEqual(withConstant(null, proxied), ["127.0.0.1", "127.0.0.0/24"], "unset");
  assert.deepEqual(withConstant("", proxied), ["127.0.0.1", "127.0.0.0/24"], "empty");
  assert.deepEqual(withConstant("  ", proxied), ["127.0.0.1", "127.0.0.0/24"], "blank");
  assert.deepEqual(withConstant("127.0.0.1", forged), ["198.51.100.20", "198.51.100.0/24"], "untrusted REMOTE_ADDR: header ignored");
  assert.deepEqual(withConstant("127.0.0.1", proxied), ["203.0.113.9", "203.0.113.0/24"], "trusted proxy: header honoured");
  assert.deepEqual(withConstant("127.0.0.0/8, ::1", { REMOTE_ADDR: "::1", HTTP_X_FORWARDED_FOR: "2001:db8:1::7, 127.0.0.5" }), ["2001:db8:1::7", "2001:0db8:0001::/48"]);
  assert.deepEqual(withConstant("127.0.0.1", { REMOTE_ADDR: "127.0.0.1", HTTP_X_FORWARDED_FOR: "1.2.3.4, unknown" }), [null, null], "the proxy appends unknown: no address, no net, never REMOTE_ADDR or 1.2.3.4");
  assert.deepEqual(withConstant("127.0.0.1", { REMOTE_ADDR: "127.0.0.1" }), [null, null], "from the proxy without X-Forwarded-For: never the proxy's own network");
  assert.deepEqual(withConstant("10.0.0.0/8", { REMOTE_ADDR: "::ffff:10.0.0.5", HTTP_X_FORWARDED_FOR: "::ffff:1.2.3.4, ::ffff:10.0.0.7" }), ["::ffff:1.2.3.4", "1.2.3.0/24"], "mapped IPv4 everywhere");
  assert.deepEqual(withConstant(null, { REMOTE_ADDR: "not an address" }), ["not an address", null], "no network when it cannot be worked out");
  assert.deepEqual(withConstant(null, {}), ["", null]);
});

test("the challenge rate limit still keys on REMOTE_ADDR (toll_gate_ip unchanged); only the network for pricing uses the proxy list", () => {
  const issuer = readFileSync(ROOT + "packages/wp-toll-gate/includes/issuer.php", "utf8");
  assert.match(issuer, /function toll_gate_ip\(\): string\s*\{\s*return \(string\) \(\$_SERVER\['REMOTE_ADDR'\] \?\? '\?'\);\s*\}/);
  assert.match(issuer, /md5\(toll_gate_ip\(\) \. '\|'/);
  const plugin = ["issuer.php", "gate.php", "payouts.php", "discovery.php", "network.php"].map((f) => readFileSync(ROOT + "packages/wp-toll-gate/includes/" + f, "utf8")).join("\n");
  assert.equal((plugin.match(/HTTP_X_FORWARDED_FOR/g) ?? []).length, 1, "X-Forwarded-For is read in one place: toll_gate_client_ip");
});

// ---- payment server -------------------------------------------------------------------------------
test("GET /v1/owner/price: load_pricing true only with ?net=1 and velocity on; an older site (no ?net=1) never gets true", async () => {
  const all = (v: boolean) => ({ search: v, write: v, account: v, admin: v });
  for (const velocity of [false, true]) {
    const s = await paymentServer(velocity);
    for (const q of ["", "?net=1", "?net=0", "?net=yes", "?net="]) {
      const r = await ownerJson(s, "price" + q);
      assert.deepEqual(r.load_pricing, all(velocity && q === "?net=1"), `velocity ${velocity}, query "${q}"`);
      assert.equal(r.prices.write.amount_msat, 10000, "the table is the base price either way");
    }
    assert.equal((await owner(s, "price?net=1", undefined, null)).status, 401);
    s.demo.toll.paid!.setCollecting(false);
    assert.equal((await ownerJson(s, "price?net=1")).load_pricing, null, "no paid offers: nothing to rise");
    s.demo.toll.paid!.setCollecting(true);
  }
});

test("relay prices like the server's own 402: same amount for a network and its addresses, rising with paid redeems relayed with that net; other networks and a missing or bad net stay at the base", async () => {
  const s = await paymentServer(true);
  const A = "203.0.113.0/24";
  const B = "2001:0db8:0001::/48";
  const at = async (net: string, ip: string) => ({ relay: await relayedAmount(s, net), own402: await own402(s, ip), price: (await ownPrice(s, ip)).amount_msat, quote: (await quote(s, net)).amount_msat });
  assert.deepEqual(await at(A, "203.0.113.7"), { relay: 10000, own402: 10000, price: 10000, quote: 10000 }, "x1 at the start");
  // Redeems without a net (an older site) count toward nothing.
  for (let i = 0; i < 3; i++) await relayPaid(s);
  assert.deepEqual(await at(A, "203.0.113.7"), { relay: 10000, own402: 10000, price: 10000, quote: 10000 }, "no net: no velocity hit");
  for (let i = 0; i < 3; i++) await relayPaid(s, A);
  const raised = await at(A, "203.0.113.7");
  assert.deepEqual(raised, { relay: 20000, own402: 20000, price: 20000, quote: 20000 }, "three paid redeems relayed with that net: x2 everywhere");
  assert.equal((await ownPrice(s, "203.0.113.250")).load_multiplier, 2, "any address in the /24");
  assert.equal((await ownPrice(s, "::ffff:203.0.113.9")).load_multiplier, 2, "mapped form too");
  assert.equal((await quote(s, A)).load_multiplier, 2);
  assert.deepEqual(await at(B, "2001:db8:1::7"), { relay: 10000, own402: 10000, price: 10000, quote: 10000 }, "another network stays at x1");
  assert.deepEqual(await at("198.51.100.0/24", "198.51.100.7"), { relay: 10000, own402: 10000, price: 10000, quote: 10000 });
  for (const bad of [undefined, "", "203.0.113.7", "203.0.113.0/16", "203.0.113.5/24", " 203.0.113.0/24", "2001:db8:1::/48", 42, null, ["203.0.113.0/24"], { net: A }]) {
    const label = JSON.stringify(bad) ?? "missing";
    const o = await owner(s, "offers", { action: "write", ...(bad === undefined ? {} : { net: bad }) });
    assert.equal(o.status, 200, `not a 400: ${label}`);
    assert.equal(((await o.json()) as any).offers[0].amount_msat, 10000, `base price: ${label}`);
    const q = await quote(s, bad);
    assert.deepEqual([q.amount_msat, q.load_multiplier], [10000, 1], `quote base: ${label}`);
  }
  // A bad net on a paid redeem books the payment but counts toward no network.
  for (let i = 0; i < 3; i++) await relayPaid(s, "198.51.100.5/24");
  assert.equal((await quote(s, "198.51.100.0/24")).load_multiplier, 1);
  // IPv6 rises the same way.
  for (let i = 0; i < 3; i++) await relayPaid(s, B);
  assert.deepEqual(await at(B, "2001:db8:1:abcd::1"), { relay: 20000, own402: 20000, price: 20000, quote: 20000 });
  // Account class: its own bucket.
  assert.equal((await ownerJson(s, "offers", { action: "account", net: A })).offers[0].amount_msat, 25000);
});

test("velocity off: a valid net changes nothing (base price everywhere)", async () => {
  const s = await paymentServer(false);
  for (let i = 0; i < 4; i++) await relayPaid(s, "203.0.113.0/24");
  assert.equal(await relayedAmount(s, "203.0.113.0/24"), 10000);
  assert.deepEqual([(await quote(s, "203.0.113.0/24")).amount_msat, (await quote(s, "203.0.113.0/24")).load_multiplier], [10000, 1]);
  assert.equal(await own402(s, "203.0.113.7"), 10000);
});

test("POST /v1/owner/quote: owner key required; answer shape; read-only (velocity, ledger, offer store and metrics unchanged after many calls)", async () => {
  const settler = new StubSettler();
  const s = await paymentServer(true, settler);
  const net = "203.0.113.0/24";
  for (const auth of [null, "wrong-key-0123456789abcdef", KEY + "x"]) {
    const r = await owner(s, "quote", { action: "write", net }, auth);
    assert.equal(r.status, 401, String(auth));
    assert.deepEqual(await r.json(), { error: "unauthorized" });
  }
  const basic = await fetch(s.url + "/v1/owner/quote", { method: "POST", headers: { ...json, authorization: "Basic " + KEY }, body: JSON.stringify({ action: "write" }) });
  assert.equal(basic.status, 401, "Bearer only");
  await basic.arrayBuffer();
  const noKey = await paymentServer(true);
  noKey.demo.toll.config.settlement.owner_key = undefined;
  assert.equal((await owner(noKey, "quote", { action: "write" })).status, 404, "owner API off without a key");
  assert.equal((await owner(s, "quote", { action: "read" })).status, 400);
  assert.equal((await owner(s, "quote", { action: "nope", net })).status, 400);
  assert.equal((await owner(s, "quote")).status, 405, "GET is not a quote");
  const q = await quote(s, net);
  assert.deepEqual(q, { status: "test", action: "write", amount_msat: 10000, load_multiplier: 1, fx: { usd_per_btc: 100000, fetched_at: q.fx.fetched_at } });
  // Two paid redeems: one below the first step (3). If a quote counted, the price would rise.
  await relayPaid(s, net);
  await relayPaid(s, net);
  const ledger = () => JSON.stringify(s.demo.toll.paid!.ledger.list(s.demo.toll.config.site_id));
  const offersStored = () => (settler as any).preimages.size as number;
  const before = { lines: s.lines.length, metrics: JSON.stringify(s.demo.toll.metrics.snapshot()), ledger: ledger(), offers: offersStored(), balance: JSON.stringify(s.demo.toll.paid!.balance()) };
  for (let i = 0; i < 40; i++) {
    const r = await quote(s, net);
    assert.deepEqual([r.amount_msat, r.load_multiplier], [10000, 1]);
  }
  for (const k of ["search", "account", "admin"]) await ownerJson(s, "quote", { action: k, net });
  assert.equal(s.lines.length, before.lines, "no log line");
  assert.equal(JSON.stringify(s.demo.toll.metrics.snapshot()), before.metrics, "no counter moved");
  assert.equal(ledger(), before.ledger, "ledger unchanged");
  assert.equal(offersStored(), before.offers, "no offer or invoice minted");
  assert.equal(JSON.stringify(s.demo.toll.paid!.balance()), before.balance);
  assert.equal((await quote(s, net)).load_multiplier, 1, "still below the step after 43 quotes");
  await relayPaid(s, net);
  assert.equal((await quote(s, net)).load_multiplier, 2, "the third paid redeem reaches the step: the count was 2, quotes added nothing");
  s.demo.toll.paid!.setCollecting(false);
  assert.deepEqual(await quote(s, net), { status: "stub", action: "write", amount_msat: null, load_multiplier: null, fx: null }, "no paid offers: no price");
  s.demo.toll.paid!.setCollecting(true);
});

// ---- the network stays out of logs, answers and storage ------------------------------------------
function filesTouchedSince(dir: string, t0: number, depth: number, out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (n === "node_modules" || n === ".git") continue;
    const p = dir + "/" + n;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (depth > 0) filesTouchedSince(p, t0, depth - 1, out); }
    else if (st.isFile() && st.mtimeMs >= t0 && st.size < 5_000_000) out.push(p);
  }
  return out;
}

test("net is never logged, echoed in an error, or stored: offers, redeem and quote with a distinctive network", async () => {
  const t0 = Date.now() - 1000;
  const settler = new StubSettler();
  const s = await paymentServer(true, settler);
  const NETS = ["198.18.207.0/24", "2001:0db8:5ea1::/48"];
  const MARKS = [...NETS, "198.18.207", "db8:5ea1"];
  const seen: string[] = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug, out: process.stdout.write, err: process.stderr.write };
  const grab = (f: (...a: any[]) => any) => (...a: any[]) => { seen.push(a.map(String).join(" ")); return f(...a); };
  console.log = grab(orig.log); console.info = grab(orig.info); console.warn = grab(orig.warn); console.error = grab(orig.error); console.debug = grab(orig.debug);
  process.stdout.write = grab(orig.out.bind(process.stdout)) as any;
  process.stderr.write = grab(orig.err.bind(process.stderr)) as any;
  const answers: string[] = [];
  const record = async (r: Response) => { const t = await r.text(); answers.push(String(r.status) + " " + JSON.stringify([...r.headers]) + " " + t); return t; };
  try {
    for (const net of NETS) {
      for (let i = 0; i < 4; i++) await relayPaid(s, net);
      await record(await owner(s, "offers", { action: "write", net }));
      await record(await owner(s, "quote", { action: "write", net }));
      // Error paths, each carrying the network.
      await record(await owner(s, "offers", { action: "read", net }));
      await record(await owner(s, "offers", { action: { net }, net }));
      await record(await owner(s, "quote", { action: "nope", net }));
      await record(await owner(s, "quote", { action: "write", net }, null));
      await record(await owner(s, "offers", { action: "write", net }, "bad-key-0123456789abcdef"));
      await record(await owner(s, "redeem", { net }));
      await record(await owner(s, "redeem", { offer_id: "off_" + net, kind: "ln402", preimage: "00".repeat(32), macaroon: "m", net }));
      const o = (await ownerJson(s, "offers", { action: "write", net })).offers[0];
      const proof = { offer_id: o.id, kind: "ln402", preimage: await pay(s, o), macaroon: o.macaroon, net };
      await record(await owner(s, "redeem", proof));
      await record(await owner(s, "redeem", proof)); // replay
      await record(await owner(s, "redeem", { ...proof, preimage: "11".repeat(32) }));
      await record(await fetch(s.url + "/v1/owner/quote", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + KEY }, body: `{"action":"write","net":"${net}"` }));
      await record(await fetch(s.url + "/v1/owner/quote", { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer " + KEY }, body: JSON.stringify({ action: "write", net }) }));
      s.demo.toll.metrics.flush?.();
    }
  } finally {
    Object.assign(console, { log: orig.log, info: orig.info, warn: orig.warn, error: orig.error, debug: orig.debug });
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
  }
  assert.ok(answers.length >= 28 && answers.some((a) => a.startsWith("401 ")) && answers.some((a) => a.startsWith("400 ")), "error paths were exercised");
  assert.equal((await quote(s, NETS[0])).load_multiplier, 2, "and the network was used: its price rose");
  const toll = s.demo.toll;
  const stored = JSON.stringify({
    store: [...((toll.store as any).m as Map<string, unknown>).entries()],
    ledger: toll.paid!.ledger.list(toll.config.site_id),
    recent: toll.paid!.recent(),
    offers: [...((settler as any).preimages as Map<string, string>).entries()],
    metrics: { snap: toll.metrics.snapshot(), byTag: toll.metrics.byTag },
  });
  assert.ok(stored.length > 1000, "stores were read");
  const files = filesTouchedSince(ROOT.replace(/\/$/, ""), t0, 6).concat(filesTouchedSince(tmpdir(), t0, 0));
  const fileHits = files.filter((f) => { try { const t = readFileSync(f, "latin1"); return MARKS.some((m) => t.includes(m)); } catch { return false; } }).filter((f) => !f.endsWith("/tests/load-pricing.test.ts"));
  for (const m of MARKS) {
    assert.equal(s.lines.filter((l) => l.includes(m)).length, 0, "metrics lines");
    assert.equal(seen.filter((l) => l.includes(m)).length, 0, "console, stdout and stderr");
    assert.equal(answers.filter((a) => a.includes(m)).length, 0, "answers, error paths included");
    assert.equal(stored.includes(m), false, "replay store, ledger, recent payments, offer store, counters");
  }
  assert.deepEqual(fileHits, [], "no file written during the test holds the network");
});

// ---- plugin discovery and relay code under WordPress stubs ----------------------------------------
type Resp = { status: number; body: unknown } | null;
/** Runs the plugin's network.php, payouts.php and discovery.php with WordPress stubs. HTTP calls to the payment server are recorded and answered from `responses` ("METHOD /path"; missing = no answer). */
function wpPhp(o: { code: string; responses?: Record<string, Resp>; transients?: Record<string, unknown>; server?: Record<string, string>; trusted?: string }) {
  const code = `<?php
declare(strict_types=1);
const ABSPATH = '/';
${o.trusted !== undefined ? `define('TOLL_TRUSTED_PROXIES', ${JSON.stringify(o.trusted)});` : ""}
require ${JSON.stringify(ROOT + "packages/server-php/vendor/autoload.php")};
$GLOBALS['t'] = json_decode(${JSON.stringify(JSON.stringify(o.transients ?? {}))}, true) ?: [];
$GLOBALS['responses'] = json_decode(${JSON.stringify(JSON.stringify(o.responses ?? {}))}, true) ?: [];
$GLOBALS['calls'] = [];
$_SERVER = json_decode(${JSON.stringify(JSON.stringify(o.server ?? { REMOTE_ADDR: "127.0.0.1" }))}, true);
class WP_REST_Response { public function __construct(public array $body, public int $status) {} }
class WP_REST_Request { public function __construct(private array $p) {} public function get_param(string $k) { return $this->p[$k] ?? null; } }
class WP_Error {}
function rest_url(string $p = ''): string { return 'https://wp.test/wp-json/' . $p; }
function untrailingslashit(string $s): string { return rtrim($s, '/'); }
function toll_gate_lib_ok(): bool { return true; }
function toll_gate_settings(): array { return ['payouts' => 1, 'connection' => 'server', 'server_url' => 'http://127.0.0.1:9']; }
function toll_gate_server_key(): string { return 'k'; }
function toll_gate_challenge_url(string $a, string $p): string { return '/wp-json/toll/v1/challenge?action=' . $a; }
function toll_gate_json(array $b, int $s = 200, array $h = []): WP_REST_Response { return new WP_REST_Response($b, $s); }
function get_transient(string $k) { return $GLOBALS['t'][$k] ?? false; }
function set_transient(string $k, $v, int $ttl = 0): bool { $GLOBALS['t'][$k] = $v; return true; }
function delete_transient(string $k): bool { unset($GLOBALS['t'][$k]); return true; }
function wp_json_encode($v) { return json_encode($v); }
function is_wp_error($x): bool { return $x instanceof WP_Error; }
function wp_remote_request(string $url, array $args) {
  $path = substr($url, strlen('http://127.0.0.1:9'));
  $GLOBALS['calls'][] = ['method' => $args['method'], 'path' => $path, 'body' => isset($args['body']) ? json_decode($args['body'], true) : null];
  $r = $GLOBALS['responses'][$args['method'] . ' ' . $path] ?? null;
  return $r === null ? new WP_Error() : $r;
}
function wp_remote_retrieve_response_code($r) { return $r['status']; }
function wp_remote_retrieve_body($r) { return json_encode($r['body']); }
require ${JSON.stringify(ROOT + "packages/wp-toll-gate/includes/network.php")};
require ${JSON.stringify(ROOT + "packages/wp-toll-gate/includes/payouts.php")};
require ${JSON.stringify(ROOT + "packages/wp-toll-gate/includes/discovery.php")};
$out = null;
${o.code}
echo json_encode(['out' => $out, 'calls' => $GLOBALS['calls'], 't' => $GLOBALS['t']], JSON_UNESCAPED_SLASHES);
`;
  return JSON.parse(php([], code));
}
const PRICES = { search: { amount_msat: 2000 }, write: { amount_msat: 10000 }, account: { amount_msat: 25000 }, admin: { amount_msat: 100000 } };
const FX = { usd_per_btc: 100000, fetched_at: Math.floor(Date.now() / 1000) };
const priceAnswer = (load: boolean): Resp => ({ status: 200, body: { status: "test", prices: PRICES, load_pricing: { search: load, write: load, account: load, admin: load }, fx: FX } });
const MANIFEST = "$out = toll_gate_manifest()['tools'][1]['price'];";
const PRICE = "$r = toll_gate_rest_price(new WP_REST_Request(['action' => 'write'])); $out = ['status' => $r->status] + $r->body;";

test("WP manifest: asks GET /v1/owner/price?net=1 and shows the base-price note only when the server reports load_pricing true", () => {
  for (const load of [false, true]) {
    const r = wpPhp({ code: MANIFEST, responses: { "GET /v1/owner/price?net=1": priceAnswer(load) } });
    assert.deepEqual(r.calls.map((c: any) => c.method + " " + c.path), ["GET /v1/owner/price?net=1"]);
    assert.equal(r.out.note ?? null, load ? BASE_PRICE_NOTE : null, `load_pricing ${load}`);
    assert.equal(r.out.basis, "base");
    assert.equal(r.out.amount_msat, 10000);
    assert.deepEqual(Object.keys(r.t), ["toll_gate_price_cache"], "one site-wide cache key");
    assert.equal(r.t.toll_gate_price_cache.net_declared, true);
  }
  // Only true counts: a server that says "yes" or 1 is not load pricing.
  const odd = wpPhp({ code: MANIFEST, responses: { "GET /v1/owner/price?net=1": { status: 200, body: { status: "test", prices: PRICES, load_pricing: { write: 1, account: "yes", admin: null }, fx: FX } } } });
  assert.equal(odd.out.note, undefined);
});

test("WP price cache: an answer cached without the net_declared mark (an older plugin) is asked again, so a declared and an undeclared answer never mix; a marked one is reused", () => {
  const stale = { status: "test", prices: PRICES, load_pricing: { search: true, write: true, account: true, admin: true }, fx: FX };
  const r = wpPhp({ code: MANIFEST, transients: { toll_gate_price_cache: stale }, responses: { "GET /v1/owner/price?net=1": priceAnswer(false) } });
  assert.equal(r.calls.length, 1, "refetched");
  assert.equal(r.out.note, undefined, "the declared answer (false) wins over the stale true");
  const fresh = wpPhp({ code: MANIFEST, transients: { toll_gate_price_cache: { net_declared: true, ...stale } }, responses: {} });
  assert.equal(fresh.calls.length, 0, "a marked answer is reused");
  assert.equal(fresh.out.note, BASE_PRICE_NOTE);
});

test("WP /price: load-priced, it quotes the visitor's network (load_multiplier a number); quote down or wrong: base with null; not load-priced: no quote, x1", () => {
  const server = { REMOTE_ADDR: "127.0.0.1", HTTP_X_FORWARDED_FOR: "203.0.113.9" };
  const quoteAnswer = (b: object): Resp => ({ status: 200, body: { status: "test", action: "write", fx: FX, ...b } });
  const hot = wpPhp({ code: PRICE, server, trusted: "127.0.0.1", responses: { "GET /v1/owner/price?net=1": priceAnswer(true), "POST /v1/owner/quote": quoteAnswer({ amount_msat: 20000, load_multiplier: 2 }) } });
  assert.deepEqual(hot.calls.map((c: any) => [c.method, c.path, c.body]), [["GET", "/v1/owner/price?net=1", null], ["POST", "/v1/owner/quote", { action: "write", net: "203.0.113.0/24" }]]);
  assert.deepEqual([hot.out.status, hot.out.amount_msat, hot.out.usd, hot.out.display, hot.out.basis, hot.out.load_multiplier], [200, 20000, "0.0200", "$0.0200 (test)", "current", 2]);
  assert.ok(!JSON.stringify(hot.t).includes("203.0.113"), "the network is not cached");
  for (const [label, resp] of [["no answer", null], ["500", { status: 500, body: {} }], ["401", { status: 401, body: { error: "unauthorized" } }], ["no multiplier", quoteAnswer({ amount_msat: 20000 })], ["stub", quoteAnswer({ status: "stub", amount_msat: null, load_multiplier: null })], ["multiplier below 1", quoteAnswer({ amount_msat: 5000, load_multiplier: 0.5 })]] as const) {
    const r = wpPhp({ code: PRICE, server, trusted: "127.0.0.1", responses: { "GET /v1/owner/price?net=1": priceAnswer(true), "POST /v1/owner/quote": resp as Resp } });
    assert.deepEqual([r.out.status, r.out.amount_msat, r.out.display, r.out.load_multiplier], [200, 10000, "$0.0100 (test)", null], label);
  }
  const cold = wpPhp({ code: PRICE, server, trusted: "127.0.0.1", responses: { "GET /v1/owner/price?net=1": priceAnswer(false) } });
  assert.deepEqual(cold.calls.map((c: any) => c.path), ["/v1/owner/price?net=1"], "no quote when not load-priced");
  assert.deepEqual([cold.out.amount_msat, cold.out.load_multiplier], [10000, 1]);
  const noNet = wpPhp({ code: PRICE, server: { REMOTE_ADDR: "junk" }, responses: { "GET /v1/owner/price?net=1": priceAnswer(true), "POST /v1/owner/quote": quoteAnswer({ amount_msat: 10000, load_multiplier: 1 }) } });
  assert.deepEqual(noNet.calls[1].body, { action: "write" }, "no network: none sent");
  assert.equal(noNet.out.load_multiplier, 1);
});

test("WP relay: offers and paid redeems carry the visitor's network (from REMOTE_ADDR, or X-Forwarded-For only behind a listed proxy), never the address", () => {
  const offer = { id: "off_1", kind: "ln402", amount_msat: 10000, invoice: "inv-opaque", macaroon: "mac-opaque", exp: 9999999999 };
  const responses = { "POST /v1/owner/offers": { status: 200, body: { offers: [offer], www_authenticate: "X-Test" } }, "POST /v1/owner/redeem": { status: 200, body: { ok: true, cls: "write", amount_msat: 10000, fee_msat: 1000, net_msat: 9000 } } };
  const code = "$out = [toll_gate_relay_offers('write') !== null, toll_gate_relay_redeem(['offer_id' => 'off_1', 'kind' => 'ln402', 'preimage' => str_repeat('ab', 32), 'macaroon' => 'mac-opaque'])[0]];";
  const cases: [string, Record<string, string>, string | undefined, string | null][] = [
    ["REMOTE_ADDR, no proxy list", { REMOTE_ADDR: "198.51.100.20", HTTP_X_FORWARDED_FOR: "203.0.113.9" }, undefined, "198.51.100.0/24"],
    ["forged header from an unlisted address", { REMOTE_ADDR: "198.51.100.20", HTTP_X_FORWARDED_FOR: "203.0.113.9" }, "127.0.0.1", "198.51.100.0/24"],
    ["listed proxy", { REMOTE_ADDR: "127.0.0.1", HTTP_X_FORWARDED_FOR: "203.0.113.9" }, "127.0.0.1", "203.0.113.0/24"],
    ["IPv6 visitor", { REMOTE_ADDR: "127.0.0.1", HTTP_X_FORWARDED_FOR: "2001:db8:1::7" }, "127.0.0.1", "2001:0db8:0001::/48"],
    ["no usable address", { REMOTE_ADDR: "junk" }, undefined, null],
  ];
  for (const [label, server, trusted, net] of cases) {
    const r = wpPhp({ code, server, trusted, responses });
    assert.deepEqual(r.out, [true, 200], label);
    assert.deepEqual(r.calls.map((c: any) => c.path), ["/v1/owner/offers", "/v1/owner/redeem"]);
    assert.deepEqual(r.calls[0].body, net === null ? { action: "write" } : { action: "write", net }, label + ": offers body");
    assert.deepEqual(r.calls[1].body, { offer_id: "off_1", kind: "ln402", preimage: "ab".repeat(32), macaroon: "mac-opaque", ...(net === null ? {} : { net }) }, label + ": redeem body");
    assert.ok(!JSON.stringify(r.calls).includes("203.0.113.9") && !JSON.stringify(r.calls).includes("198.51.100.20"), "never the full address");
    assert.equal(Object.keys(r.t).length, 0, "nothing stored in transients");
  }
});
