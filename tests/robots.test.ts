// robots.txt allows everything. The source file and a build with an explicit empty site root name no host
// and have no Sitemap line. A build with a site root appends one Sitemap line for that root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore plain JS build script
import { build, cliSiteRaw, SITE_FILES } from "../website/build.mjs";
import { parseSiteUrl } from "../packages/protocol/src/site-url.ts";

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

test("robots.txt: the source and an empty site root allow everything, with no Sitemap line and no domain", () => {
  assert.ok(SITE_FILES.includes("robots.txt"), "build.mjs ships it");
  check(ROOT + "website/", "website/");
  check(build(mkdtempSync(join(tmpdir(), "toll-robots-")) + "/", ""), "fresh build");
  assert.ok(readFileSync(build(mkdtempSync(join(tmpdir(), "toll-robots-")) + "/", "") + "robots.txt").equals(readFileSync(ROOT + "website/robots.txt")), "empty site root copies the source");
});

test("robots.txt: a site root adds one Sitemap line and nothing else", () => {
  const site = "https://site.example";
  const dir = build(mkdtempSync(join(tmpdir(), "toll-robots-set-")) + "/", site, () => {});
  const t = readFileSync(dir + "robots.txt", "utf8");
  assert.equal(t, EXPECTED + `Sitemap: ${site}/sitemap.xml\n`);
  assert.doesNotMatch(t, /^\s*disallow/im);
  const base = parseSiteUrl(cliSiteRaw()).url;
  assert.ok(base, "the CLI build has a site root");
  assert.ok(existsSync(DIST + "robots.txt"), "website/dist/robots.txt");
  assert.equal(readFileSync(DIST + "robots.txt", "utf8"), EXPECTED + `Sitemap: ${base}/sitemap.xml\n`);
});
