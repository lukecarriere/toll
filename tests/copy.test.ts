// §19.12 copy lint (full §1 list from docs/copy.md) and "docs/copy.md is the single source".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-ignore plain JS helper
import { lintList, lintRegexes, lintText, readmeTop, widgetStrings, readCopy, isExempt } from "../scripts/copy-lib.mjs";
// @ts-ignore plain JS helper
import { runLint } from "../scripts/copy-lint.mjs";
import { COPY } from "../demo/strings.ts";

const md = readCopy();

test("lint list is read from docs/copy.md, including sats and on-chain", () => {
  const { terms, pctWords } = lintList(md);
  for (const t of ["bitcoin", "btc", "satoshi", "lightning", "l402", "wallet", "sats", "on-chain", "seed phrase", "we detect ai"]) assert.ok(terms.includes(t), t);
  assert.deepEqual(pctWords.map((w: string) => w.toLowerCase()), ["human", "bot", "ai"]);
  // A word added to the copy file is picked up with no code change.
  const extended = md.replace("we detect ai.", "we detect ai, moonbeam.");
  assert.ok(lintList(extended).terms.includes("moonbeam"));
});

test("'sats' and 'on-chain' are caught on a public surface and ignored in exempt paths", () => {
  const text = "Pay 10 sats per request, settled on-chain.";
  const pub = lintText("README.md", text).map((h: any) => h.term);
  assert.deepEqual(pub.sort(), ["on-chain", "sats"]);
  assert.equal(lintText("demo/pages.ts", "ON-CHAIN and SATS").length, 2, "case-insensitive");
  assert.deepEqual(lintText("docs/settlement.md", text), []);
  assert.deepEqual(lintText("packages/settlement-ln/src/offer.ts", text), []);
  assert.deepEqual(lintText("docs/settlement-vectors.json", text), []);
  assert.equal(isExempt("docs/protocol.md"), false);
});

test("whole words only: no false hits inside other words; phrases and risk-score percentages caught", () => {
  assert.deepEqual(lintText("README.md", "Saturday satisfied amount_msat Lightningale wallets"), []);
  assert.equal(lintText("README.md", "Your seed  phrase").length, 1);
  assert.equal(lintText("README.md", "Visitor is 12% human").length, 1);
  assert.equal(lintText("README.md", "bot: 97%").length, 1);
  assert.equal(lintText("README.md", "a 10% platform fee").length, 0);
});

test("copy lint passes on every public surface of this repo", () => {
  const r = runLint();
  assert.deepEqual(r.hits, []);
  assert.ok(r.files > 10);
});

test("README starts with the exact block from docs/copy.md", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const top = readmeTop(md).split("\n");
  const lines = readme.split("\n");
  assert.equal(lines[0], "# " + top[0]);
  assert.equal(lines[2], top[1]);
  assert.equal(lines[3], top[2]);
});

test("widget strings come from docs/copy.md and are the only visible text in toll.js", () => {
  const s = widgetStrings(md);
  assert.deepEqual(s, { checking: "Checking…", verified: "Verified", verify: "Verify before sending", error: "Couldn't check this form.", retry: "Try again", nojs: "This form needs JavaScript." });
  const dist = readFileSync(new URL("../packages/widget/dist/toll.js", import.meta.url), "utf8");
  // esbuild writes non-ASCII as \uXXXX escapes (charset=ascii), so accept either form.
  const esc = (v: string) => v.replace(/[^\x00-\x7f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  for (const v of [s.checking, s.verified, s.verify, s.error, s.retry]) assert.ok(dist.includes(v) || dist.includes(esc(v)) || dist.includes(esc(v.replace("'", "\\'"))), v);
  for (const banned of ["I am not a robot", "human", "robot"]) assert.ok(!dist.toLowerCase().includes(banned.toLowerCase()), banned);
});

test("demo strings marked COPY appear verbatim in docs/copy.md", () => {
  for (const [k, v] of Object.entries(COPY)) assert.ok(md.includes(v), `${k}: "${v}"`);
});
