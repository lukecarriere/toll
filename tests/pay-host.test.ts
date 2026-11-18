// Pay-address host checks, end to end through resolveLightningAddress: a refused host is never
// fetched (neither the pay-address host nor its callback host), and a public host still is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLightningAddress } from "../packages/settlement-ln/src/cashu-melt.ts";

const INTERNAL = "." + "internal";

/** A fake pay server: the well-known document names `callback`; the callback answers with no invoice. */
function server(callback: string) {
  const seen: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const href = String(url);
    seen.push(href);
    if (href.includes("/.well-known/lnurlp/")) return new Response(JSON.stringify({ tag: "payRequest", callback, minSendable: 1000, maxSendable: 1_000_000_000, metadata: "[]" }));
    return new Response(JSON.stringify({ pr: "not-an-invoice" }));
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const refusedCallbackHosts = [
  // IPv6 forms that carry a refused IPv4 address, written the way URL parsing leaves them and not
  "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:10.0.0.1]", "[::ffff:a00:1]",
  "[::ffff:169.254.169.254]", "[::ffff:a9fe:a9fe]", "[::ffff:192.168.0.1]", "[::ffff:100.64.0.1]",
  "[::ffff:198.18.0.1]", "[0:0:0:0:0:ffff:7f00:1]", "[::7f00:1]", "[::127.0.0.1]", "[::a00:1]",
  "[::ffff:0:7f00:1]", "[::ffff:0:127.0.0.1]", "[::ffff:0:a9fe:a9fe]",
  "[64:ff9b::7f00:1]", "[64:ff9b::127.0.0.1]", "[64:ff9b::a9fe:a9fe]", "[64:ff9b:1::a00:1]",
  "[2002:7f00:1::]", "[2002:a9fe:a9fe::1]", "[2002:c0a8:1::1]",
  // IPv6 ranges
  "[::]", "[::1]", "[0:0:0:0:0:0:0:1]", "[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[febf::1]",
  "[ff02::1]", "[ff0e::1]", "[2001:db8::1]", "[2001:0:4136:e378:8000:63bf:3fff:fdd2]", "[100::1]",
  // IPv4 ranges
  "127.0.0.1", "127.255.255.254", "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255",
  "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255", "100.64.0.1", "100.127.255.255",
  "169.254.169.254", "169.254.0.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
  "192.0.2.1", "198.51.100.7", "203.0.113.9", "198.18.0.1", "198.19.255.255", "192.0.0.8",
  // IPv4 written in forms URL parsing turns into a dotted quad
  "2130706433", "0x7f000001", "0177.0.0.1", "127.1", "0x7f.1",
  // names
  "localhost", "localhost.", "localhost..", "LOCALHOST", "Localhost.", "a.localhost", "a.b.localhost.",
  "localhost.localdomain", "localhost.localdomain.", "localhost..localdomain", "LocalHost.LocalDomain",
  "pay.local", "pay.local.", "pay..local", "PAY.LOCAL", "pay" + INTERNAL, "pay" + INTERNAL + ".",
  "pay." + INTERNAL + "..", "pay",
];

for (const host of refusedCallbackHosts) {
  test("pay-address callback host is refused and not fetched: " + host, async () => {
    const { seen, fetchImpl } = server(`https://${host}/cb`);
    await assert.rejects(resolveLightningAddress("owner@pay.example.com", 21, fetchImpl), /malformed/);
    assert.equal(seen.length, 1, "only the well-known document was fetched; the callback was not: " + seen.join(" "));
  });
}

const refusedAddressHosts = ["localhost.localdomain", "a.localhost", "pay.local", "pay" + INTERNAL, "localhost"];

for (const host of refusedAddressHosts) {
  test("pay-address host is refused before any fetch: owner@" + host, async () => {
    const { seen, fetchImpl } = server("https://pay.example.com/cb");
    await assert.rejects(resolveLightningAddress("owner@" + host, 21, fetchImpl), /malformed/);
    assert.equal(seen.length, 0, "nothing was fetched: " + seen.join(" "));
  });
}

const publicCallbackHosts = [
  "pay.example.com", "pay.example.com.", "8.8.8.8", "1.1.1.1", "11.0.0.1", "172.32.0.1", "100.128.0.1",
  "198.20.0.1", "192.169.0.1", "[2606:4700:4700::1111]", "[2a00:1450:4001:80b::200e]",
  "[::ffff:8.8.8.8]", "[64:ff9b::808:808]", "[2002:808:808::1]",
];

for (const host of publicCallbackHosts) {
  test("pay-address callback on a public host is still fetched: " + host, async () => {
    const { seen, fetchImpl } = server(`https://${host}/cb`);
    // The callback answers without an invoice, so the call still fails, but only after the fetch.
    await assert.rejects(resolveLightningAddress("owner@pay.example.com", 21, fetchImpl), /malformed/);
    assert.equal(seen.length, 2, "the callback was fetched");
    assert.equal(new URL(seen[1]).hostname, new URL(`https://${host}/cb`).hostname);
  });
}
