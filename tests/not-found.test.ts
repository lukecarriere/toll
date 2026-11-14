// Unknown site URLs must return HTTP 404 with a branded HTML page (issue #59).
// API paths under /v1/ keep their JSON errors. The page is built as website/dist/404.html
// and served by Workers assets (`not_found_handling = "404-page"`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore plain JS build script
import { build, discoveryFiles, pagePath, sitemapXml } from "../website/build.mjs";
// @ts-ignore plain JS helper
import { lintText, lintVendor } from "../scripts/copy-lib.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = build(mkdtempSync(join(tmpdir(), "toll-404-")) + "/", "");
const SET = build(mkdtempSync(join(tmpdir(), "toll-404-set-")) + "/", "https://lessspam.dev", () => {});

test("wrangler serves a 404 page for unknown paths, not an empty body", () => {
  const toml = readFileSync(ROOT + "wrangler.toml", "utf8");
  assert.match(toml, /^not_found_handling = "404-page"$/m);
  assert.match(toml, /^html_handling = "drop-trailing-slash"$/m);
});

test("the built 404 page is branded HTML with a title, lang, message, and a link home", () => {
  const file = OUT + "404.html";
  assert.ok(existsSync(file), "website/dist/404.html is missing from the build");
  const html = readFileSync(file, "utf8");
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Page not found · Toll<\/title>/);
  assert.match(html, /<meta name="description" content="This page isn't on Toll.">/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<h1>Page not found<\/h1>/);
  assert.match(html, /This page isn't on Toll\./);
  const home = [...html.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].filter((m) => m[2] === "Back to home");
  assert.equal(home.length, 1, "one Back to home link");
  assert.match(home[0][1], /\shref="\/"/);
  assert.match(html, /<a class="mark" href="\/">Toll<\/a>/);
  assert.doesNotMatch(html, /<script|<style|\sstyle=|\son[a-z]+\s*=|javascript:/i);
  assert.doesNotMatch(html, /rel="canonical"|property="og:/);
  assert.deepEqual([...lintText("website/dist/404.html", html), ...lintVendor("website/dist/404.html", html)], []);
});

test("a site-root build still ships the 404 page, and it stays out of the sitemap", () => {
  assert.ok(existsSync(SET + "404.html"));
  const html = readFileSync(SET + "404.html", "utf8");
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(html, /rel="canonical"|property="og:/);
  const sm = sitemapXml("https://lessspam.dev");
  assert.doesNotMatch(sm, /404/);
  assert.ok(!discoveryFiles().includes("404"));
  assert.ok(discoveryFiles().includes("index"));
  assert.equal(pagePath("index"), "/");
});
