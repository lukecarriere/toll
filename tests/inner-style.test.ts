// Inner pages style pass (design/HANDOFF-INNER-PAGES.md, CD approved Oct 3, 2026, 6:11 PM CT). One production file
// changes: website/site.css becomes design/inner-pages/site.css, byte for byte. Everything else the site ships must
// stay exactly as released at 34e46d6: the five pages' HTML, home.css, _headers (and so the CSP), robots.txt, the
// icons, the photo and the fonts. The pins below are QA's dist.sha256 for the 34e46d6 release build
// (TOLL_SITE_URL set to the working domain). The domain is read from docs/copy.md "## Naming" at run time, so this
// file never names it (tests/no-hardcoded-domains.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
// @ts-ignore plain JS build script
import { build } from "../website/build.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const HANDOFF_CSS = ROOT + "design/inner-pages/site.css";
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** sha256 of design/inner-pages/site.css as approved for the inner pages (Oct 3, 2026). */
const HANDOFF_CSS_SHA256 = "2ebe7ea9386497fed5f1a3e54ac0531e7ad104bd340a7907a2f99e306896ec1b";

/** QA's dist.sha256 for the 34e46d6 release build: all 18 files. */
const RELEASE_34E46D6: Record<string, string> = {
  "_headers": "382decc3aeb7f6c0a8b2f8cc616130a60111aa78001402d604f6d4248a3a50cb",
  "apple-touch-icon.png": "2b4ebf40ac562aa0ed92de4709948bd04557b8909ae49e43de1dae6961aed255",
  "ecosystem.html": "a96177395ccc549092dc91796f1ebc77d5d7794074929d236457a84bc8ca2650",
  "favicon.ico": "7bbba17d8e7a8aafd8a26701bd7494df64e524fcc94b3347aedbe914cf9d3c15",
  "favicon.svg": "4e0aa2fdf156bbdb75a8d29fb4b895a1a0f1aaf2cf1fe650e7bd766890e7b18c",
  "fonts/arvo/Arvo-Bold.woff2": "446a3a8caa25bcc0d272251c7dd6e282fb4201ffcb1e15f05a4acba53c061bea",
  "fonts/arvo/LICENSE.txt": "359671bf16c00cae69cb66d041296b2adc7a4becd73a463cb8c5e101d97c7986",
  "fonts/public-sans/LICENSE.txt": "157a9e77f7580246e97c769490e2e977ae94399f9d30f4556015c41fe8c28bac",
  "fonts/public-sans/PublicSans-Latin.woff2": "02a4d23e9e44b76a4415c133127d71f3c31b8edc503cab1cdcc68bfea5cc55a1",
  "home.css": "63e61d0f78bf58cf7ea76292e74f964f66bd680fb0c46e3f1fc3beaf088eff49",
  "img/forest-road-1280.jpg": "0372778d2530e5fe47a46e0c2361ba6554b50a05aeac5d70ef368527cdb76fa6",
  "img/forest-road-2560.jpg": "4a6237d691ed6d387d1ab8769434aff83b14a3f26c76dd38c67222dd986022a0",
  "index.html": "62fbc54f3178a17ca6083d29847560ec2280df7581c34f61002f3b0017df5954",
  "mission.html": "6c36bdf9104ad2949241607856442798b5f4f0a6b18a4b45d6b568490929d39a",
  "robots.txt": "16ceb5ee3e0dc13aa9adf31a3ebbe45a1d965b8c2b9f72eaf84e5911e140ed95",
  "site.css": "eacfaeadfc4374bb31cd3da3f3cae0af2b99e50b673cfe7259263ca42bbe14b7",
  "values.html": "249b8143c550bfcf8a0e8626b62e70b6d6001d81bd5819f1719cb65a22b67d27",
  "vision.html": "83633c385a65cd625f5a2053252bdf8425707d111bdb01456af5b96e427849b5",
};
const PAGES_HTML = ["ecosystem.html", "index.html", "mission.html", "values.html", "vision.html"];

/** The working domain from docs/copy.md "## Naming", `Domain: \`...\`` (the one place it is recorded). */
function workingDomain() {
  const md = readFileSync(ROOT + "docs/copy.md", "utf8");
  const naming = md.slice(md.indexOf("\n## Naming"), md.indexOf("\n## ", md.indexOf("\n## Naming") + 1));
  const m = /Domain: `([^`]+)`/.exec(naming);
  assert.ok(m, 'docs/copy.md "## Naming" records the domain');
  return m[1];
}

function walk(dir: string, at = dir): string[] {
  return readdirSync(at).flatMap((f) => statSync(join(at, f)).isDirectory() ? walk(dir, join(at, f)) : [relative(dir, join(at, f))]).sort();
}

/** A release build, as QA builds it: TOLL_SITE_URL is https:// plus the working domain. */
const OUT = build(mkdtempSync(join(tmpdir(), "toll-inner-style-")) + "/", "https://" + workingDomain());
const hashes = (files: string[]) => Object.fromEntries(files.map((f) => [f, sha256(readFileSync(OUT + f))]));

test("release pin: the five built pages are the 34e46d6 release HTML byte for byte (QA's dist.sha256)", () => {
  assert.deepEqual(hashes(PAGES_HTML), Object.fromEntries(PAGES_HTML.map((f) => [f, RELEASE_34E46D6[f]])));
});

test("release pin: the build is still the release's 18 files and only site.css differs from 34e46d6", () => {
  const files = walk(OUT);
  assert.deepEqual(files, Object.keys(RELEASE_34E46D6).sort(), "the same 18 files, nothing added or dropped");
  const got = hashes(files);
  const changed = files.filter((f) => got[f] !== RELEASE_34E46D6[f]);
  assert.deepEqual(changed, ["site.css"], "only site.css changes hash");
  assert.equal(got["site.css"], HANDOFF_CSS_SHA256, "dist site.css is the handoff file");
  // The sources the build copies, for the files the handoff says must not move.
  for (const f of ["home.css", "_headers", "robots.txt", "fonts/arvo/Arvo-Bold.woff2", "fonts/public-sans/PublicSans-Latin.woff2"]) {
    assert.equal(sha256(readFileSync(ROOT + "website/" + f)), RELEASE_34E46D6[f], "website/" + f + " is unchanged");
  }
});

test("site.css: website/site.css is the CD-approved design/inner-pages/site.css byte for byte (pinned hash)", () => {
  const src = readFileSync(ROOT + "website/site.css");
  assert.equal(sha256(src), HANDOFF_CSS_SHA256, "website/site.css");
  assert.deepEqual(readFileSync(OUT + "site.css"), src, "the build copies it unchanged");
  // Self-contained, and it fetches only fonts that ship: no @import, no remote URL, every url() a file in website/.
  const css = src.toString("utf8");
  assert.doesNotMatch(css, /@import|https?:|\/\/[a-z0-9]/i);
  const urls = [...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(urls, ["/fonts/arvo/Arvo-Bold.woff2", "/fonts/public-sans/PublicSans-Latin.woff2"]);
  for (const u of urls) assert.ok(existsSync(ROOT + "website" + u), u + " is in website/fonts/");
  // CD calls (Oct 3): the h1 stays Toll Sans 700 (not the Slab variant) and the amber dash stays.
  assert.match(css, /\bh1\{font:700 52px\/1\.02 "Toll Sans"/);
  assert.match(css, /\bh1:before\{content:"";[^}]*background:var\(--amber\)/);
});

test("site.css: byte for byte the live handoff file in design/inner-pages/", { skip: existsSync(HANDOFF_CSS) ? false : "design/ not present (gitignored)" }, () => {
  assert.equal(sha256(readFileSync(HANDOFF_CSS)), HANDOFF_CSS_SHA256, "the pinned hash is the handoff file's");
  assert.deepEqual(readFileSync(ROOT + "website/site.css"), readFileSync(HANDOFF_CSS));
});
