// guardFetch without a peer address (be/xff-trust, EM ruling): one warning per process that says what
// to set (info.remoteAddr or o.remoteAddr()), never an address or a header value. Its own file, so the
// once-per-process flag starts unset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardFetch } from "../packages/server-node/src/http.ts";
import { parseTrustedProxies } from "../packages/protocol/src/index.ts";
import { startDemo } from "./helpers.ts";

test("guardFetch: no peer address -> exactly one warning per process naming info.remoteAddr / o.remoteAddr(), with no address or header value in it", async () => {
  const s = await startDemo();
  s.demo.toll.config.trusted_proxies = parseTrustedProxies("127.0.0.1").ranges;
  const seen: string[] = [];
  const cw = console.warn;
  console.warn = (...a: unknown[]) => seen.push(a.map(String).join(" "));
  try {
    const req = (xff: string) => new Request("http://site.test/comments", { method: "POST", headers: { "toll-client": "agent", "x-forwarded-for": xff, "user-agent": "agent-ua-zz" } });
    const withPeer = guardFetch(s.demo.toll, () => new Response("ok"), { action: "write" });
    for (let i = 0; i < 3; i++) await (await withPeer(req(`198.51.100.${i}`), { remoteAddr: "127.0.0.1" })).arrayBuffer();
    const viaOption = guardFetch(s.demo.toll, () => new Response("ok"), { action: "write", remoteAddr: () => "198.51.100.200" });
    await (await viaOption(req("203.0.113.9"))).arrayBuffer();
    assert.equal(seen.length, 0, "a peer address given: no warning: " + seen.join(" | "));
    const without = guardFetch(s.demo.toll, () => new Response("ok"), { action: "write" });
    const emptyOption = guardFetch(s.demo.toll, () => new Response("ok"), { action: "write", remoteAddr: () => undefined });
    for (let i = 0; i < 5; i++) await (await without(req(`203.0.113.${10 + i}, 192.0.2.${i}`))).arrayBuffer();
    for (let i = 0; i < 3; i++) await (await emptyOption(req(`203.0.113.${40 + i}`), { remoteAddr: "" })).arrayBuffer();
    await (await without(req("2001:db8::77"), {})).arrayBuffer();
    assert.equal(seen.length, 1, "once over 9 requests without a peer address: " + seen.join(" | "));
    assert.match(seen[0], /^\[toll\] guardFetch has no peer address/);
    assert.match(seen[0], /info\.remoteAddr/);
    assert.match(seen[0], /o\.remoteAddr\(/);
    assert.doesNotMatch(seen[0], /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/, "no IPv4 address");
    assert.doesNotMatch(seen[0], /[0-9a-f]{1,4}:[0-9a-f]{0,4}:/i, "no IPv6 address");
    for (const v of ["203.0.113", "192.0.2", "198.51.100", "2001:db8", "agent-ua-zz", "site.test"]) assert.ok(!seen[0].includes(v), "no header value: " + v);
  } finally {
    console.warn = cw;
    await s.close();
  }
});
