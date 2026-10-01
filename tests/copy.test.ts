// §19.12 copy lint (full §1 list from docs/copy.md) and "docs/copy.md is the single source".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-ignore plain JS helper
import { lintList, lintRegexes, lintText, readmeTop, widgetStrings, readCopy, isExempt, section } from "../scripts/copy-lib.mjs";
// @ts-ignore plain JS helper
import { runLint } from "../scripts/copy-lint.mjs";
import * as demoStrings from "../demo/strings.ts";
import { COPY, resultsFor } from "../demo/strings.ts";
import { formsPage, hammerPage } from "../demo/pages.ts";

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

test("copy lint passes on every public surface of this repo", async () => {
  const r = await runLint();
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

test("every demo string is backed by docs/copy.md (Demo strings section; noJs from Widget strings)", () => {
  // One group only: nothing outside copy.md is left in demo/strings.ts.
  assert.deepEqual(Object.keys(demoStrings).sort(), ["COPY", "resultsFor"]);
  const demo = section(md, "Demo strings");
  const widget = section(md, "Widget strings");
  const money = section(md, "Money");
  assert.ok(demo.length > 200, "Demo strings section found");
  for (const [k, v] of Object.entries(COPY)) {
    const where = k === "noJs" ? widget : k === "rateUnavailable" ? money : demo;
    assert.ok(where.includes(v), `${k}: "${v}" is not in docs/copy.md`);
  }
  // Results line: copy.md pattern `N result(s) for "query"`, singular at 1.
  assert.ok(demo.includes('N result(s) for "query"') && demo.includes("singular at 1"));
  assert.equal(resultsFor(1, "workshop"), '1 result for "workshop"');
  assert.equal(resultsFor(0, "x"), '0 results for "x"');
  assert.equal(resultsFor(3, "x"), '3 results for "x"');
});

test("demo pages: the action class in each card description is in code style, like the prototype", () => {
  const html = formsPage({ host: "localhost:8787", comments: [] });
  assert.ok(html.includes("A write. Gated as <code>write</code>."));
  assert.ok(html.includes("In-memory thread. Gated as <code>write</code>; your pass covers about 20 comments for 15 minutes."));
  assert.ok(html.includes("A search that POSTs. Gated as <code>search</code> (cheaper than a write)."));
  // Visible text with tags stripped is still the exact copy.md string.
  const text = html.replace(/<[^>]+>/g, "");
  for (const v of [COPY.commentsSub, COPY.searchSub, COPY.introLede, COPY.noPassSub]) assert.ok(text.includes(v), v);
  const hammer = hammerPage({ host: "localhost:8787" }).replace(/<[^>]+>/g, "");
  for (const v of [COPY.hammerTitle, COPY.hammerLede, COPY.runWithoutSub, COPY.runWithSub, COPY.agentSub, COPY.legendPending]) assert.ok(hammer.includes(v), v);
  // Designer: no "phase 2" tag on the Agent hammer card any more.
  assert.doesNotMatch(hammerPage({ host: "localhost:8787" }), /phase 2|class="badge"/);
});

test("demo pages, paid requests on: phase 2 stats and owner block use copy.md strings, USD only, '—' + 'Rate unavailable' when the rate is down", () => {
  const paid = { mode: COPY.modePaymentsOn, requests: 5, collected: "$0.05", available: "$0.04", agentAccepted: 5, feeBps: 1000, collecting: true, replayRejected: 1 };
  const strip = (h: string) => h.replace(/<[^>]+>/g, " ");
  const forms = strip(formsPage({ host: "localhost:8787", comments: [], paid }));
  for (const v of [COPY.modePaymentsOn, COPY.statPaid, COPY.statCollected, COPY.siteOwner, COPY.payoutsLabel, COPY.payoutsHelp, "available to withdraw · after the 10% platform fee", "$0.05", "$0.04"]) assert.ok(forms.includes(v), v);
  assert.ok(!forms.includes("{fee}"));
  // "Site owner" heading sits above the checkbox; the checkbox is a live control, not greyed out.
  const raw = formsPage({ host: "localhost:8787", comments: [], paid });
  assert.ok(raw.indexOf(`<h3>${COPY.siteOwner}</h3>`) < raw.indexOf('id="payouts-toggle"'));
  assert.match(raw, /<input type="checkbox" id="payouts-toggle" checked>/);
  assert.match(formsPage({ host: "localhost:8787", comments: [], paid: { ...paid, collecting: false } }), /<input type="checkbox" id="payouts-toggle">/);
  // {fee} follows fee_bps (copy.md Money).
  assert.ok(strip(formsPage({ host: "localhost:8787", comments: [], paid: { ...paid, feeBps: 750 } })).includes("after the 7.5% platform fee"));
  assert.doesNotMatch(forms, /msat|invoice|preimage|offer|stub|\bsat\b/i);
  assert.ok(!forms.includes(COPY.modeWorkOnly));
  const down = formsPage({ host: "localhost:8787", comments: [], paid: { ...paid, mode: COPY.modePaymentsPaused, collected: null, available: null } });
  assert.match(down, /id="bal-amt">—</);
  assert.match(down, /id="st-coll">—</);
  assert.match(down, new RegExp(`id="bal-rate">${COPY.rateUnavailable}<`));
  assert.ok(down.includes(COPY.modePaymentsPaused));
  const hammer = hammerPage({ host: "localhost:8787", paid });
  assert.ok(!hammer.includes('class="card locked" id="agent"'));
  assert.match(hammer, /aria-label="5 of 20 accepted"/);
  // Agent card counts (copy.md): paid requests · usage value collected · "N ✕" replayed payment(s) rejected.
  const ht = strip(hammer);
  for (const v of [COPY.agentPaid, COPY.agentCollected, "1 ✕", COPY.agentReplayedOne]) assert.ok(ht.includes(v), v);
  assert.ok(!ht.includes(COPY.agentReplayedMany));
  const h2 = strip(hammerPage({ host: "localhost:8787", paid: { ...paid, replayRejected: 2 } }));
  assert.ok(h2.includes("2 ✕") && h2.includes(COPY.agentReplayedMany));
  assert.ok(strip(hammerPage({ host: "localhost:8787", paid: { ...paid, replayRejected: 0 } })).replace(/\s+/g, " ").includes("0 ✕ " + COPY.agentReplayedMany));
  // Paid requests off: phase 1 page, no phase 2 block.
  const off = formsPage({ host: "localhost:8787", comments: [] });
  assert.ok(!off.includes(COPY.payoutsLabel) && off.includes(COPY.modeWorkOnly));
});

test("USD rounding follows the rule confirmed in docs/copy.md 'Money': owner totals round down to the cent, offers round up to $0.0001", async () => {
  const { usdDisplay, offerUsd } = await import("../packages/settlement-ln/src/index.ts");
  const money = section(md, "Money");
  assert.match(money, /owner balances and totals round down to the cent/);
  assert.match(money, /Offer prices round up and show at most four decimals \(\$0\.0001\)/);
  const fx = { usd_per_btc: 100000, fetched_at: 0, source: "test" };
  assert.equal(usdDisplay(45000, fx, 0), "$0.04"); // $0.045 owner total -> down
  assert.equal(usdDisplay(19999, fx, 0), "$0.01"); // $0.019999 -> down
  const fx2 = { usd_per_btc: 63412.57, fetched_at: 0, source: "test" };
  assert.equal(offerUsd(10000, fx2, 0), "0.0064"); // $0.0063412 offer -> up
  assert.equal(offerUsd(10000, fx, 0), "0.0100"); // exact stays exact
});

test("{fee} placeholder (docs/copy.md 'Money'): 1000 -> 10, 750 -> 7.5, 25 -> 0.25; filled in the demo and WordPress templates", async () => {
  const { feePercent, fillFee } = await import("../packages/settlement-ln/src/index.ts");
  assert.equal(feePercent(1000), "10");
  assert.equal(feePercent(750), "7.5");
  assert.equal(feePercent(25), "0.25");
  assert.match(section(md, "Money"), /1000 → "10", 750 → "7\.5", 25 → "0\.25"/);
  const wp = section(md, "WordPress strings");
  for (const [tpl, want] of [
    ["available to withdraw, after the {fee}% platform fee", "available to withdraw, after the 7.5% platform fee"],
    ["{fee}% · recorded on each payment", "7.5% · recorded on each payment"],
  ]) {
    assert.ok(wp.includes(tpl), tpl);
    assert.equal(fillFee(tpl, 750), want);
  }
  assert.equal(fillFee(COPY.balanceCaption, 25), "available to withdraw · after the 0.25% platform fee");
});

test("vendor names (docs/adapters.md list) are caught on public surfaces and allowed only in adapters.md, package.json and licence notices", async () => {
  // @ts-ignore plain JS helper
  const { vendorList, lintVendor, isVendorAllowed } = await import("../scripts/copy-lib.mjs");
  const { exact, any } = vendorList();
  for (const t of ["ALTCHA", "Aperture", "Sentinel", "Cap Cloud", "Turnstile", "reCAPTCHA", "hCaptcha"]) assert.ok(any.includes(t), t);
  assert.deepEqual(exact, ["Cap"]);
  const leak = "Protected by ALTCHA. Powered by Cap. Settled via Aperture. Try Turnstile or hcaptcha.";
  for (const f of ["README.md", "demo/pages.ts", "packages/widget/src/strings.gen.ts", "packages/widget/dist/toll.js", "packages/wp-toll-gate/admin/screen.php", "toll.example.yaml", "commit-subject"]) {
    const terms = lintVendor(f, leak).map((h: any) => h.term).sort();
    assert.deepEqual(terms, ["vendor: ALTCHA", "vendor: Aperture", "vendor: Cap", "vendor: Turnstile", "vendor: hCaptcha"], f);
  }
  for (const f of ["docs/adapters.md", "package.json", "packages/work-adapter/package.json", "packages/server-php/composer.json", "packages/widget/dist/LICENSES.txt"]) {
    assert.ok(isVendorAllowed(f), f);
    assert.deepEqual(lintVendor(f, leak), [], f);
  }
  // Ordinary English "cap" (the 8 s cap, max_units cap) is not the vendor.
  assert.deepEqual(lintVendor("README.md", "after the 8 s cap; worst-case cap per check; caps; capture"), []);
  // The whole repo's public surfaces are clean.
  const all = await runLint();
  assert.equal(all.hits.length, 0, JSON.stringify(all.hits));
});

test("the widget dist names no captcha or risk-score service and loads nothing from a CDN", () => {
  const js = ["toll.js", "toll.worker.js", "toll.worker-argon2id.js"].map((f) => readFileSync(new URL("../packages/widget/dist/" + f, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(js, /turnstile|recaptcha|hcaptcha|sentinel|jsdelivr|unpkg|cdnjs|trycap/i);
  assert.doesNotMatch(js, /https?:\/\/(?!www\.w3\.org)/);
});
