// website/_headers (QA NO-GO, Oct 3): the `_headers` block from section 2 of the deploy plan, word for word, shipped
// at the dist root unchanged. The plan lives outside the repo (it names the domain), so the expected bytes are
// pinned here instead of read from it: this test reads only files inside the repo and works in a fresh clone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore plain JS build script
import { build, SITE_FILES } from "../website/build.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = ROOT + "website/dist/";
const OUT = build(mkdtempSync(join(tmpdir(), "toll-headers-")) + "/", "");

/** The deploy plan's section 2 Content-Security-Policy line, exactly (two-space indent, no trailing space). */
const CSP_LINE = "  Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Demo document CSP (the same policy the local demo sends). The site-wide line above stays. */
const DEMO_CSP = "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** The deploy plan's section 2 block, then the /demo override that unsets that CSP and sets the demo one. */
const EXPECTED = [
  "/*",
  "  Strict-Transport-Security: max-age=31536000",
  CSP_LINE,
  "  X-Content-Type-Options: nosniff",
  "  Referrer-Policy: strict-origin-when-cross-origin",
  "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
  "",
  "/site.css",
  "  Cache-Control: public, max-age=3600",
  "",
  "/home.css",
  "  Cache-Control: public, max-age=3600",
  "",
  "/fonts/*",
  "  Cache-Control: public, max-age=31536000, immutable",
  "",
  "/img/*",
  "  Cache-Control: public, max-age=86400",
  "",
  "/demo",
  "  ! Content-Security-Policy",
  DEMO_CSP,
  "",
  "/demo/*",
  "  ! Content-Security-Policy",
  DEMO_CSP,
].join("\n") + "\n";

test("_headers: the site CSP line is unchanged, and /demo replaces it with the demo policy", () => {
  const src = readFileSync(ROOT + "website/_headers", "utf8");
  assert.equal(src, EXPECTED);
  assert.ok(src.endsWith(DEMO_CSP + "\n") && !src.endsWith("\n\n"), "ends in exactly one newline");
  assert.doesNotMatch(src, /\r|\t|[^\x20-\x7e\n]/, "LF only, no tabs, plain ASCII");
  const lines = src.split("\n");
  assert.equal(lines[2], CSP_LINE, "the /* CSP line is still the deploy plan's, exactly");
  assert.ok(lines.includes("  ! Content-Security-Policy"), "/demo unsets the site CSP before setting its own");
  assert.doesNotMatch(src, /lessspam|https?:|\/\/[a-z0-9]/i, "no domain or URL");
});

test("_headers: a build copies website/_headers into dist/_headers unchanged (fresh build and website/dist)", () => {
  assert.deepEqual(SITE_FILES.filter((f: string) => f === "_headers"), ["_headers"]);
  const src = readFileSync(ROOT + "website/_headers");
  assert.ok(existsSync(OUT + "_headers"), "fresh build has _headers at the dist root");
  assert.ok(readFileSync(OUT + "_headers").equals(src), "fresh build: dist/_headers is byte-identical to website/_headers");
  assert.ok(existsSync(DIST), "website/dist/ is missing: run `npm run build` (or `npm run build:website`) first");
  assert.ok(existsSync(DIST + "_headers"), "website/dist/_headers is missing");
  assert.ok(readFileSync(DIST + "_headers").equals(src), "website/dist/_headers is byte-identical to website/_headers");
  const built = readFileSync(DIST + "_headers", "utf8").split("\n").filter((l) => l.startsWith("  Content-Security-Policy:"));
  assert.equal(built[0], CSP_LINE);
  assert.ok(built.slice(1).every((l) => l === DEMO_CSP));
});
