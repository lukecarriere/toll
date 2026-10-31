// The generated plugin readme is what WordPress.org shows. It has to name every call the
// plugin makes to the owner's payment server, and link terms and privacy (directory guidelines 6 and 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync("dist-release/toll-gate/readme.txt", "utf8");
const section = readme.split("== External services ==")[1]?.split(/^== /m)[0] ?? "";

test("readme External services names each payment-server call and the terms and privacy links", () => {
  assert.ok(section.length > 0, "External services section missing");
  for (const path of [
    "GET /v1/owner/balance",
    "POST /v1/owner/withdraw",
    "GET /v1/owner/price?net=1",
    "POST /v1/owner/quote",
    "POST /v1/owner/offers",
    "POST /v1/owner/redeem",
    "POST /v1/owner/cashu",
  ]) {
    assert.ok(section.includes(path), path);
  }
  assert.match(section, /\/\.well-known\/toll\.json/);
  assert.match(section, /\/wp-json\/toll\/v1\/price/);
  assert.match(section, /203\.0\.113\.0\/24/);
  assert.match(section, /https:\/\/lessspam\.dev\/terms/);
  assert.match(section, /https:\/\/lessspam\.dev\/privacy/);
  assert.doesNotMatch(section, /to get a price and payment offers/);
});
