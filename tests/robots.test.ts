// robots.txt (QA NO-GO, Oct 3): allow everything, no Sitemap line and no domain (the domain never ships; see
// TOLL_SITE_URL). Exactly "User-agent: *" then "Allow: /", ending in a newline, served at /robots.txt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore plain JS build script
import { build, SITE_FILES } from "../website/build.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = ROOT + "website/dist/";
const EXPECTED = "User-agent: *\nAllow: /\n";

function check(dir: string, label: string) {
  assert.ok(existsSync(dir + "robots.txt"), `${label}: robots.txt at the dist root (served at /robots.txt)`);
  const t = readFileSync(dir + "robots.txt", "utf8");
  assert.equal(t, EXPECTED, label + ": exact content");
  assert.doesNotMatch(t, /lessspam/i, label + ": no domain");
  assert.doesNotMatch(t, /sitemap/i, label + ": no Sitemap line");
  assert.doesNotMatch(t, /https?:|\/\/[a-z0-9]|\.dev\b/i, label + ": no URL or host");
  assert.doesNotMatch(t, /^\s*disallow/im, label + ": nothing disallowed");
}

test("robots.txt: website/robots.txt and the built file allow everything, with no Sitemap line and no domain", () => {
  assert.ok(SITE_FILES.includes("robots.txt"), "build.mjs ships it");
  check(ROOT + "website/", "website/");
  check(build(mkdtempSync(join(tmpdir(), "toll-robots-")) + "/", ""), "fresh build");
  check(build(mkdtempSync(join(tmpdir(), "toll-robots-set-")) + "/", "https://site.example", () => {}), "fresh build with a site root");
  assert.ok(existsSync(DIST), "website/dist/ is missing: run `npm run build` (or `npm run build:website`) first");
  check(DIST, "website/dist");
  assert.ok(readFileSync(DIST + "robots.txt").equals(readFileSync(ROOT + "website/robots.txt")), "copied unchanged");
});
