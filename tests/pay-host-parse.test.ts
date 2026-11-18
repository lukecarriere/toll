// Pay-address host checks: IP literal parsing and range tests on the helper itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { embeddedIPv4, normalizeHost, parseIPv4, parseIPv6, publicPayHost } from "../packages/settlement-ln/src/pay-host.ts";

const hex = (b: Uint8Array | null) => (b ? Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("") : null);

test("IPv6 literals parse to bytes: compressed, full, bracketed and with a dotted tail", () => {
  assert.equal(hex(parseIPv6("::1")), "00000000000000000000000000000001");
  assert.equal(hex(parseIPv6("::")), "00000000000000000000000000000000");
  assert.equal(hex(parseIPv6("[::ffff:7f00:1]")), "00000000000000000000ffff7f000001");
  assert.equal(hex(parseIPv6("::ffff:127.0.0.1")), "00000000000000000000ffff7f000001");
  assert.equal(hex(parseIPv6("0:0:0:0:0:FFFF:7F00:0001")), "00000000000000000000ffff7f000001");
  assert.equal(hex(parseIPv6("2001:db8::")), "20010db8000000000000000000000000");
  assert.equal(hex(parseIPv6("64:ff9b::10.0.0.1")), "0064ff9b00000000000000000a000001");
  assert.equal(hex(parseIPv6("1:2:3:4:5:6:7::")), "00010002000300040005000600070000");
});

test("malformed IPv6 literals do not parse", () => {
  for (const bad of ["", ":::", "1::2::3", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7", "12345::", "::ffff:1.2.3", "::ffff:1.2.3.256",
    "1.2.3.4::", "fe80::1%eth0", "::g", "1:2:3:4:5:6:7:8::", "::1.2.3.4:5"]) {
    assert.equal(parseIPv6(bad), null, bad);
  }
});

test("IPv4 dotted quads parse; other forms do not", () => {
  assert.equal(hex(parseIPv4("127.0.0.1")), "7f000001");
  assert.equal(hex(parseIPv4("255.255.255.255")), "ffffffff");
  for (const bad of ["127.1", "1.2.3.4.5", "256.0.0.1", "0x7f.0.0.1", "1.2.3.", "a.b.c.d"]) assert.equal(parseIPv4(bad), null, bad);
});

test("embedded IPv4 is found in mapped, translated, compatible, NAT64 and 6to4 forms", () => {
  for (const [v6, v4] of [["::ffff:7f00:1", "7f000001"], ["::ffff:0:a00:1", "0a000001"], ["::a9fe:a9fe", "a9fea9fe"],
    ["64:ff9b::c0a8:1", "c0a80001"], ["2002:7f00:1::", "7f000001"]] as const) {
    assert.equal(hex(embeddedIPv4(parseIPv6(v6)!)), v4, v6);
  }
  assert.equal(embeddedIPv4(parseIPv6("2606:4700::1")!), null);
});

test("host names are lowercased, repeated dots collapsed and trailing dots dropped", () => {
  assert.equal(normalizeHost("LocalHost.."), "localhost");
  assert.equal(normalizeHost("pay..example.com."), "pay.example.com");
  assert.equal(normalizeHost("[::FFFF:7F00:1]"), "::ffff:7f00:1");
});

test("an unparseable IPv6 literal is refused", () => {
  for (const bad of ["[::ffff:7f00:1:2:3:4:5]", "[fe80::1%25eth0]", "[1::2::3]", "[::zz]"]) assert.equal(publicPayHost(bad), false, bad);
});
