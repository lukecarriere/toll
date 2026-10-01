// Client address behind trusted proxies (be/xff-trust), Node and the edge:
//   - packages/protocol client-ip.ts runs every ip_bytes and client_ip vector in docs/net-vectors.json
//     natively, and gives the same output as the WordPress plugin's PHP for each (cross-check);
//   - TOLL_TRUSTED_PROXIES is read from the environment; bad entries are ignored and logged once,
//     count only, never the value;
//   - Node (router and guardFetch): unset, the socket address is the client and X-Forwarded-For is
//     ignored; set, the walk applies; a forged leftmost entry changes neither the network, the price
//     nor the rate-limit bucket; no usable client means no network (base price, multiplier 1) and the
//     rate limit keys on the socket address;
//   - the edge reads only CF-Connecting-IP; X-Forwarded-For never picks a rate-limit bucket.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { clientIp, ipBytes, parseTrustedProxies, trustedProxies, coarseNet } from "../packages/protocol/src/index.ts";
import { normalizeConfig } from "../packages/server-node/src/config.ts";
import { guardFetch, requestClient } from "../packages/server-node/src/http.ts";
import { solveWork } from "../packages/work-adapter/src/index.ts";
import { startDemo, PAID_ON, TEST_SECRET, type Running } from "./helpers.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const V = JSON.parse(readFileSync(ROOT + "docs/net-vectors.json", "utf8"));
const KEY = "owner-key-xff-trust-0123456789abcdef";
const json = { "content-type": "application/json", accept: "application/json" };
const hex = (b: Uint8Array | null) => (b ? Buffer.from(b).toString("hex") : null);
const xffOf = (x: any): string | null => (x !== null && typeof x === "object" ? x.repeat.repeat(x.times) + x.then : x);

// ---- shared vectors ------------------------------------------------------------------------------
test("ip_bytes vectors, natively in JS: protocol ipBytes gives the expected packed address (or null) for every entry", () => {
  assert.ok(V.ip_bytes.length >= 50);
  for (const [ip, want] of V.ip_bytes) assert.equal(hex(ipBytes(ip)), want, JSON.stringify(ip));
});

test("client_ip vectors, natively in JS: protocol clientIp gives the expected address and network for every entry (raw list and parsed list)", () => {
  assert.ok(V.client_ip.length >= 44);
  for (const c of V.client_ip) {
    const xff = xffOf(c.xff);
    const got = clientIp({ remoteAddr: c.remote, xff, trusted: c.trusted });
    assert.equal(got, c.expect, c.name);
    assert.equal(coarseNet(got), c.expect_net, c.name + " (net)");
    assert.equal(clientIp({ remoteAddr: c.remote, xff, trusted: parseTrustedProxies(c.trusted).ranges }), c.expect, c.name + " (parsed list)");
  }
  const names = V.client_ip.map((c: any) => c.name).join("\n");
  for (const k of ["multi-hop chain where every hop is inside a CIDR proxy", "exactly 4096 bytes is read", "over 4096 bytes: no address", "the client sends 1.2.3.4, the trusted proxy appends unknown", "every X-Forwarded-For entry a listed proxy"]) assert.ok(names.includes(k), k);
  const long = V.client_ip.find((c: any) => c.name.includes("over 4096"));
  assert.equal(Buffer.byteLength(xffOf(long.xff)!), 4104);
  assert.equal(Buffer.byteLength(xffOf(V.client_ip.find((c: any) => c.name.includes("exactly 4096")).xff)!), 4096);
});

test("cross-check: the plugin's PHP gives the same ip_bytes and client_ip output as protocol, entry by entry", () => {
  const out = JSON.parse(execFileSync("php", [ROOT + "tests/php/run-net-vectors.php", "--json"], { encoding: "utf8" }));
  assert.equal(out.ip_bytes.length, V.ip_bytes.length);
  for (const [i, [ip, got]] of out.ip_bytes.entries()) assert.equal(got, hex(ipBytes(V.ip_bytes[i][0])), `PHP == JS for ${JSON.stringify(ip)}`);
  assert.equal(out.client_ip.length, V.client_ip.length);
  for (const [i, c] of V.client_ip.entries()) {
    const js = clientIp({ remoteAddr: c.remote, xff: xffOf(c.xff), trusted: c.trusted });
    assert.deepEqual(out.client_ip[i], [c.name, js, coarseNet(js)], c.name);
  }
});

// ---- TOLL_TRUSTED_PROXIES ------------------------------------------------------------------------
test("TOLL_TRUSTED_PROXIES: read from the environment; bad entries ignored and logged once per value with the count only", () => {
  const seen: string[] = [];
  const raw = "10.0.0.0/8, bogus-entry-zz, 300.1.1.1, 2001:db8::/33, 2001:db8::/129, [::1]";
  const r = trustedProxies(raw, (m) => seen.push(m));
  assert.equal(r.length, 2);
  assert.equal(trustedProxies(raw, (m) => seen.push(m)).length, 2);
  assert.equal(seen.length, 1, "logged once: " + seen.join(" | "));
  assert.match(seen[0], /^\[toll\] TOLL_TRUSTED_PROXIES: 4 entries are not an IPv4\/IPv6 address or CIDR range and are ignored$/);
  for (const v of ["bogus-entry-zz", "300.1.1.1", "/129", "[::1]", "10.0.0.0"]) assert.ok(!seen[0].includes(v), "the value is not logged: " + v);
  assert.deepEqual(trustedProxies(undefined, (m) => seen.push(m)), []);
  assert.deepEqual(trustedProxies("", (m) => seen.push(m)), []);
  assert.deepEqual(trustedProxies("127.0.0.1, ::1", (m) => seen.push(m)).length, 2);
  assert.equal(seen.length, 1, "valid, unset and empty log nothing");
  const base = { site_id: "s", secret: TEST_SECRET };
  assert.deepEqual(normalizeConfig(base, {}).trusted_proxies, [], "unset: no proxies");
  assert.equal(normalizeConfig(base, { TOLL_TRUSTED_PROXIES: "127.0.0.1, 10.0.0.0/8" }).trusted_proxies.length, 2);
});

test("requestClient: unset, the socket address even with a forged header; set, the walk; no usable client -> ip null and the rate limit on the socket address", () => {
  const toll = (trusted: string) => ({ config: { trusted_proxies: parseTrustedProxies(trusted).ranges } }) as any;
  assert.deepEqual(requestClient(toll(""), "198.51.100.20", "203.0.113.41"), { ip: "198.51.100.20", limit: "198.51.100.20" });
  assert.deepEqual(requestClient(toll("10.0.0.0/8"), "198.51.100.20", "203.0.113.41"), { ip: "198.51.100.20", limit: "198.51.100.20" }, "socket not a listed proxy");
  assert.deepEqual(requestClient(toll("127.0.0.1"), "127.0.0.1", "192.0.2.66, 203.0.113.41"), { ip: "203.0.113.41", limit: "203.0.113.41" });
  assert.deepEqual(requestClient(toll("127.0.0.1"), "::ffff:127.0.0.1", ["192.0.2.66", "203.0.113.41"]), { ip: "203.0.113.41", limit: "203.0.113.41" }, "repeated header lines are joined");
  assert.deepEqual(requestClient(toll("127.0.0.1"), "127.0.0.1", "203.0.113.41, unknown"), { ip: null, limit: "127.0.0.1" });
  assert.deepEqual(requestClient(toll("127.0.0.1"), "127.0.0.1", undefined), { ip: null, limit: "127.0.0.1" });
  assert.deepEqual(requestClient(toll("127.0.0.1"), undefined, "203.0.113.41"), { ip: null, limit: "?" }, "no peer address (guardFetch without one)");
  assert.deepEqual(requestClient(toll(""), undefined, "203.0.113.41"), { ip: null, limit: "?" });
});

// ---- Node issuer ---------------------------------------------------------------------------------
const servers: Running[] = [];
after(async () => { for (const s of servers) await s.close(); });

/** Paid offers on, velocity on with low steps (3 -> x2, 6 -> x4) and a long window, owner API on. */
async function server(o: { trusted?: string; viaEnv?: boolean; perMin?: number } = {}): Promise<Running> {
  const over = { work: { standard: { cost: 500 }, velocity_steps: [[3, 2], [6, 4]], velocity_window_s: 600 }, adaptive: { velocity: true }, settlement: { ...PAID_ON.settlement, owner_key: KEY }, rate_limit: { challenge_per_min: o.perMin ?? 1000 } };
  let s: Running;
  if (o.viaEnv) {
    const prev = process.env.TOLL_TRUSTED_PROXIES;
    process.env.TOLL_TRUSTED_PROXIES = o.trusted;
    try { s = await startDemo(over); } finally { if (prev === undefined) delete process.env.TOLL_TRUSTED_PROXIES; else process.env.TOLL_TRUSTED_PROXIES = prev; }
  } else {
    s = await startDemo(over);
    s.demo.toll.config.trusted_proxies = parseTrustedProxies(o.trusted ?? "").ranges;
  }
  servers.push(s);
  return s;
}
const ownerJson = async (s: Running, path: string, body: unknown) => {
  const r = await fetch(`${s.url}/v1/owner/${path}`, { method: "POST", headers: { ...json, authorization: "Bearer " + KEY }, body: JSON.stringify(body) });
  assert.equal(r.status, 200, path);
  return r.json() as Promise<any>;
};
/** Raise a network's velocity with paid redeems relayed for it (n = 3 -> x2). */
async function raise(s: Running, net: string, n = 3) {
  for (let i = 0; i < n; i++) {
    const offer = (await ownerJson(s, "offers", { action: "write", net })).offers[0];
    const pre = (await (await fetch(s.url + "/demo/stub-pay", { method: "POST", headers: json, body: JSON.stringify({ invoice: offer.invoice }) })).json() as any).preimage;
    await ownerJson(s, "redeem", { offer_id: offer.id, kind: "ln402", preimage: pre, macaroon: offer.macaroon, net });
  }
}
/** The server's own 402 amount and /v1/price for an agent, with this X-Forwarded-For (or none). */
async function seen(s: Running, xff?: string) {
  const h: Record<string, string> = xff === undefined ? {} : { "x-forwarded-for": xff };
  const r = await fetch(s.url + "/comments", { method: "POST", headers: { ...json, "toll-client": "agent", ...h }, body: "{}" });
  assert.equal(r.status, 402);
  const amount = ((await r.json()) as any).offers[0].amount_msat as number;
  const p = (await (await fetch(s.url + "/v1/price?action=write", { headers: h })).json()) as any;
  return [amount, p.amount_msat, p.load_multiplier];
}
const challenge = async (s: Running, xff: string) => (await fetch(s.url + "/v1/challenge?action=write", { headers: { "x-forwarded-for": xff } }).then(async (r) => { await r.arrayBuffer(); return r.status; }));
const X2 = [20000, 20000, 2];
const X1 = [10000, 10000, 1];

test("Node, TOLL_TRUSTED_PROXIES unset: the socket's network prices the request; a forged X-Forwarded-For changes neither price nor rate-limit bucket", async () => {
  const s = await server({ viaEnv: true, trusted: "" });
  await raise(s, "127.0.0.0/24");
  await raise(s, "203.0.113.0/24", 6);
  assert.deepEqual(await seen(s), X2, "the socket's own network, raised");
  assert.deepEqual(await seen(s, "198.51.100.7"), X2, "forged fresh network: still the socket's");
  assert.deepEqual(await seen(s, "203.0.113.41"), X2, "forged hot network (x4): still the socket's x2");
  const lim = await server({ viaEnv: true, trusted: "", perMin: 3 });
  const codes = [];
  for (let i = 1; i <= 4; i++) codes.push(await challenge(lim, `198.51.100.${i}`));
  assert.deepEqual(codes, [200, 200, 200, 429], "one bucket for the socket whatever the header says");
});

test("Node, socket not a listed proxy (TOLL_TRUSTED_PROXIES=10.0.0.0/8): X-Forwarded-For from it is ignored", async () => {
  const s = await server({ viaEnv: true, trusted: "10.0.0.0/8" });
  await raise(s, "203.0.113.0/24");
  assert.deepEqual(await seen(s, "203.0.113.41"), X1, "the forged hot network is not taken");
  assert.deepEqual(await seen(s, "10.1.2.3, 203.0.113.41"), X1);
  const lim = await server({ trusted: "10.0.0.0/8", perMin: 2 });
  assert.deepEqual([await challenge(lim, "203.0.113.1"), await challenge(lim, "203.0.113.2"), await challenge(lim, "192.0.2.3")], [200, 200, 429]);
});

test("Node, behind a listed proxy (TOLL_TRUSTED_PROXIES from the environment): the walk picks the client; a forged leftmost entry changes nothing; no usable client gets the base and the socket's bucket", async () => {
  const s = await server({ viaEnv: true, trusted: "127.0.0.1, ::1" });
  assert.equal(s.demo.toll.config.trusted_proxies.length, 2, "read from TOLL_TRUSTED_PROXIES");
  await raise(s, "203.0.113.0/24");
  await raise(s, "127.0.0.0/24", 6);
  assert.deepEqual(await seen(s, "203.0.113.41"), X2, "client A, raised");
  assert.deepEqual(await seen(s, "198.51.100.7, 203.0.113.41"), X2, "forged leftmost (fresh network): still A");
  assert.deepEqual(await seen(s, "192.0.2.1, 203.0.113.41"), X2, "another forged leftmost: still A");
  assert.deepEqual(await seen(s, "198.51.100.7"), X1, "client C at x1");
  assert.deepEqual(await seen(s, "203.0.113.41, unknown"), X1, "walk stopped: no network, base price, never A");
  assert.deepEqual(await seen(s), X1, "no header from the proxy: base price, never the proxy's own (raised x4) network");
  assert.deepEqual(await seen(s, "::ffff:203.0.113.41"), X2, "mapped client: A's IPv4 network");

  const lim = await server({ trusted: "127.0.0.1, ::1", perMin: 3 });
  const a = [];
  for (const x of ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"]) a.push(await challenge(lim, `${x}, 203.0.113.41`));
  assert.deepEqual(a, [200, 200, 200, 429], "forged leftmost entries all land in A's bucket");
  assert.equal(await challenge(lim, "198.51.100.9"), 200, "client C has its own bucket");
  const none = [];
  for (const x of ["203.0.113.50, unknown", "203.0.113.51, [::1]:443", ", ,", "203.0.113.52, unknown"]) none.push(await challenge(lim, x));
  assert.deepEqual(none, [200, 200, 200, 429], "no usable client: the socket's bucket, shared");
});

test("guardFetch: X-Forwarded-For only from a listed peer; a forged leftmost entry or a header from an unlisted peer does not pick the network or the bucket; no peer address means no network", async () => {
  const s = await server();
  await raise(s, "203.0.113.0/24");
  const gate = guardFetch(s.demo.toll, () => new Response("ok"), { action: "write" });
  const ask = async (xff: string | null, remoteAddr?: string) => {
    const r = await gate(new Request("http://site.test/comments", { method: "POST", headers: { "toll-client": "agent", ...(xff === null ? {} : { "x-forwarded-for": xff }) } }), remoteAddr === undefined ? undefined : { remoteAddr });
    const b = (await r.json()) as any;
    return r.status === 402 ? b.offers[0].amount_msat : r.status;
  };
  assert.equal(await ask("203.0.113.41", "198.51.100.20"), 10000, "unset list: the peer's network, not the header's");
  assert.equal(await ask("203.0.113.41"), 10000, "no peer address: no network");
  s.demo.toll.config.trusted_proxies = parseTrustedProxies("127.0.0.1").ranges;
  assert.equal(await ask("203.0.113.41", "127.0.0.1"), 20000, "listed peer: client A");
  assert.equal(await ask("198.51.100.7, 203.0.113.41", "127.0.0.1"), 20000, "forged leftmost: still A");
  assert.equal(await ask("203.0.113.41, unknown", "127.0.0.1"), 10000, "walk stopped: base");
  assert.equal(await ask("203.0.113.41", "198.51.100.20"), 10000, "unlisted peer: header ignored");
  const viaOption = guardFetch(s.demo.toll, () => new Response("ok"), { action: "write", remoteAddr: () => "127.0.0.1" });
  const r = await viaOption(new Request("http://site.test/comments", { method: "POST", headers: { "toll-client": "agent", "x-forwarded-for": "198.51.100.7, 203.0.113.41" } }));
  assert.equal(((await r.json()) as any).offers[0].amount_msat, 20000, "o.remoteAddr");

  const lim = await server({ perMin: 3 });
  const g2 = guardFetch(lim.demo.toll, () => new Response("ok"), { action: "write" });
  const codes = [];
  for (let i = 1; i <= 4; i++) {
    const res = await g2(new Request("http://site.test/comments", { method: "POST", headers: { "toll-client": "agent", "x-forwarded-for": `192.0.2.${i}` } }), { remoteAddr: "198.51.100.20" });
    await res.arrayBuffer();
    codes.push(res.status);
  }
  assert.deepEqual(codes, [402, 402, 402, 403], "one bucket for the peer, whatever the header says");
});

test("SDK calls that omit ip behave exactly like null: no network, base price, no velocity key and no velocity count, after many paid and work redeems", async () => {
  const s = await server();
  const toll = s.demo.toll;
  const payRedeem = async (ip?: string | null) => {
    const input = ip === undefined ? { action: "write" as const, client: "agent" as const } : { action: "write" as const, client: "agent" as const, ip };
    const offer = (await toll.offersFor(input))[0];
    const pre = (await (await fetch(s.url + "/demo/stub-pay", { method: "POST", headers: json, body: JSON.stringify({ invoice: offer.invoice }) })).json() as any).preimage;
    await (ip === undefined ? toll.redeemPaid({ offer_id: offer.id, kind: "ln402", preimage: pre, macaroon: offer.macaroon }) : toll.redeemPaid({ offer_id: offer.id, kind: "ln402", preimage: pre, macaroon: offer.macaroon }, { ip }));
    return offer.amount_msat as number;
  };
  const workRedeem = async () => {
    const challenge = await toll.issueChallenge({ action: "write" });
    const sol = (await solveWork(challenge.work))!;
    await toll.verifySolution(challenge, { work: { counter: sol.counter, derivedKey: sol.derivedKey } });
  };
  const amounts = [];
  for (let i = 0; i < 8; i++) amounts.push(await payRedeem());
  for (let i = 0; i < 4; i++) await workRedeem();
  assert.deepEqual(amounts, Array(8).fill(10000), "every offer at the base price");
  assert.equal(toll.currentPrice({ action: "write" })!.load_multiplier, 1, "omitted: x1 after 12 redeems (steps 3 -> x2, 6 -> x4)");
  assert.equal(toll.currentPrice({ action: "write", ip: null })!.load_multiplier, 1, "null: x1");
  assert.equal((await toll.offersFor({ action: "write", client: "agent" }))[0].amount_msat, 10000);
  const minted = s.events.filter((e) => e.event === "challenge_minted").map((e) => e.velocity_mult);
  assert.ok(minted.length >= 4 && minted.every((m) => m === 1), "work challenges without an ip stay at x1: " + minted.join(","));
  // The same config does rise for an address, so the x1 above is not a quiet config.
  for (let i = 0; i < 3; i++) await payRedeem("203.0.113.41");
  assert.equal(toll.currentPrice({ action: "write", ip: "203.0.113.41" })!.load_multiplier, 2);
  assert.equal(toll.currentPrice({ action: "write" })!.load_multiplier, 1, "and omitted is still x1");
});

// ---- edge ----------------------------------------------------------------------------------------
async function freshWorker() {
  return (await import(pathToFileURL(ROOT + "packages/edge-cf/dist/worker.js").href + "?t=" + Date.now() + Math.random())).default;
}
const EDGE_ENV = { SITE_ID: "site_edge", SITE_SECRET: "edge-test-secret-do-not-use-000001", ORIGIN: "http://127.0.0.1:9" };

test("edge: only CF-Connecting-IP is read; a forged X-Forwarded-For alongside it, or without it, never picks a rate-limit bucket", async () => {
  execFileSync(process.execPath, [ROOT + "packages/edge-cf/build.mjs"], { stdio: ["ignore", "ignore", "inherit"] });
  assert.ok(!/x-forwarded-for/i.test(readFileSync(ROOT + "packages/edge-cf/src/worker.ts", "utf8").replace(/^\s*(\/\/|\*).*$/gm, "")), "the Worker's code never reads X-Forwarded-For");
  const log = console.log;
  console.log = () => {};
  try {
    const hit = async (w: any, h: Record<string, string>) => { const r: Response = await w.fetch(new Request("http://edge.test/v1/challenge?action=write", { headers: h }), EDGE_ENV); await r.arrayBuffer(); return r.status; };
    // Without CF-Connecting-IP (local dev): one shared bucket, whatever X-Forwarded-For says.
    const w1 = await freshWorker();
    const a = [];
    for (let i = 0; i < 61; i++) a.push(await hit(w1, { "x-forwarded-for": `198.51.${100 + (i >> 8)}.${i & 255}` }));
    assert.deepEqual([a.slice(0, 60).every((c) => c === 200), a[60]], [true, 429], "the 61st request is limited");
    // With CF-Connecting-IP: its bucket, whatever X-Forwarded-For says.
    const w2 = await freshWorker();
    const b = [];
    for (let i = 0; i < 61; i++) b.push(await hit(w2, { "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": `198.51.100.${i}` }));
    assert.deepEqual([b.slice(0, 60).every((c) => c === 200), b[60]], [true, 429]);
    assert.equal(await hit(w2, { "cf-connecting-ip": "198.51.100.5", "x-forwarded-for": "203.0.113.5" }), 200, "another client has its own bucket");
    assert.equal(await hit(w2, { "cf-connecting-ip": "not-an-address", "x-forwarded-for": "198.51.100.77" }), 200, "a bad CF-Connecting-IP counts as missing: the shared bucket (empty here)");
  } finally {
    console.log = log;
  }
});
