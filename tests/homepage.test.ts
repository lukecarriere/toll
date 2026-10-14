// The homepage (design/HANDOFF-HOMEPAGE.md, merged direction D) and the EM's rulings of Oct 2:
//   - "/" is the homepage: website/dist/index.html with its own home.css;
//   - every link is root-relative with no extension ("/", "/mission", ...), so no ".html" href ships;
//   - each page canonicals to itself under TOLL_SITE_URL (validated by @toll/protocol/site-url),
//     and with TOLL_SITE_URL unset or invalid there is no canonical tag at all.
// Words come from docs/copy.md verbatim. No scripts, no inline styles, no external requests, so the
// page works under the CSP `default-src 'self'`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { chromium } from "playwright";
// @ts-ignore plain JS build script
import { build, PAGES, HOME, HOME_ASSETS, ICON_FILES, SITE_FILES } from "../website/build.mjs";
// @ts-ignore plain JS helper
import { section, lintText } from "../scripts/copy-lib.mjs";
import { parseSiteUrl } from "../packages/protocol/src/site-url.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = ROOT + "website/dist/";
const SITE = "https://site.example";
const tmp = () => mkdtempSync(join(tmpdir(), "toll-home-")) + "/";
const OUT = build(tmp(), "");
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const FILES = ["index", ...PAGES.map((p: any) => p.file)];

/** Every file under `dir`, relative to it, sorted. */
function walk(dir: string, at = dir): string[] {
  return readdirSync(at).flatMap((f) => statSync(join(at, f)).isDirectory() ? walk(dir, join(at, f)) : [relative(dir, join(at, f))]).sort();
}
const hrefs = (h: string) => [...h.matchAll(/\shref="([^"]*)"/gi)].map((m) => m[1]);
const canonicals = (h: string) => [...h.matchAll(/<link\b[^>]*rel="canonical"[^>]*>/gi)].map((m) => m[0]);

/** Build checks on a dist folder: the homepage is there and no link anywhere points at a .html file. */
function checkDist(dir: string) {
  assert.ok(existsSync(dir + "index.html"), dir + "index.html is missing: the homepage must be built");
  const html = walk(dir).filter((f) => f.endsWith(".html"));
  assert.ok(html.length >= 5, "the homepage and the four pages: " + html.join(", "));
  for (const f of html) {
    const bad = hrefs(readFileSync(dir + f, "utf8")).filter((u) => /\.html?(?:[?#]|$)/i.test(u));
    assert.deepEqual(bad, [], `${f}: no .html href (links are root-relative with no extension)`);
  }
}

test("build: website/dist/index.html exists and no .html href is left in website/dist (run `npm run build` first)", () => {
  assert.ok(existsSync(DIST), "website/dist/ is missing: run `npm run build` (or `npm run build:website`) first");
  checkDist(DIST);
});

test("build: a fresh build has the homepage, ships exactly its files, and has no .html href", () => {
  checkDist(OUT);
  assert.deepEqual(walk(OUT), ["demo.css", "demo.html", "demo.js", "ecosystem.html", "index.html", "mission.html", "site.css", "values.html", "vision.html", ...HOME_ASSETS, ...ICON_FILES, ...SITE_FILES].sort());
  for (const f of HOME_ASSETS) assert.deepEqual(readFileSync(OUT + f), readFileSync(ROOT + "website/" + f), f + " is copied unchanged");
  // Every shipped path and text file passes the copy lint list from docs/copy.md, which bans the photo's
  // tree species ("Never name the tree species in alt text, captions, or file names that ship").
  for (const f of walk(OUT)) assert.deepEqual(lintText("website/dist/" + f, f.replace(/[/._-]/g, " ")), [], "path: " + f);
  for (const f of walk(OUT).filter((f) => /\.(html|css|txt)$/.test(f))) assert.deepEqual(lintText("website/dist/" + f, readFileSync(OUT + f, "utf8")), [], f);
});

interface Ref { file: string; kind: string; url: string; canonical: boolean }
/**
 * Every URL reference on the five pages: src, each srcset/imagesrcset entry, href, poster, action, data,
 * and every CSS url() in the HTML (inline styles, if any ever appear) and in every dist .css file.
 */
function urlRefs(dir: string): Ref[] {
  const out: Ref[] = [];
  const cssUrls = (file: string, text: string) => {
    for (const m of text.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) out.push({ file, kind: "url()", url: m[2].trim(), canonical: false });
  };
  for (const f of FILES) {
    const h = readFileSync(dir + f + ".html", "utf8");
    for (const m of h.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
      const attrs = m[2];
      const canonical = m[1].toLowerCase() === "link" && /\srel="canonical"/i.test(attrs);
      for (const a of attrs.matchAll(/\s(href|src|srcset|imagesrcset|poster|action|data)="([^"]*)"/gi)) {
        const kind = a[1].toLowerCase();
        const vals = kind.endsWith("srcset") ? a[2].split(",").map((c) => c.trim().split(/\s+/)[0]).filter(Boolean) : [a[2]];
        for (const v of vals) out.push({ file: f + ".html", kind, url: decode(v), canonical });
      }
    }
    cssUrls(f + ".html", h);
  }
  for (const f of walk(dir).filter((f) => f.endsWith(".css"))) cssUrls(f, readFileSync(dir + f, "utf8"));
  return out;
}
/** "#fragment"-only and data: references: allowed, and listed so they are noticed. */
const isFragmentOrData = (u: string) => u.startsWith("#") || /^data:/i.test(u);
/**
 * References that break the root-relative rule: anything not starting with a single "/" (relative paths,
 * "//host" and absolute http(s) URLs alike). The one exception is the canonical, and only when a site
 * root is set, pointing under it.
 */
function badRefs(dir: string, site: string | null): string[] {
  return urlRefs(dir).filter((r) => {
    if (isFragmentOrData(r.url)) return false;
    if (r.canonical) return !(site !== null && /^https:\/\//.test(r.url) && (r.url + "/").startsWith(site + "/"));
    return !/^\/(?!\/)/.test(r.url);
  }).map((r) => `${r.file} ${r.kind} ${JSON.stringify(r.url)}${r.canonical ? " (canonical)" : ""}`);
}

test("root-relative: every src, srcset entry, href and CSS url() on the five pages starts with '/' (canonical aside)", () => {
  // website/dist as built (with whatever TOLL_SITE_URL the build saw), a fresh build without a site root, and one with it.
  const builtSite = parseSiteUrl(process.env.TOLL_SITE_URL).url;
  assert.deepEqual(badRefs(DIST, builtSite), [], "website/dist");
  assert.deepEqual(badRefs(OUT, null), [], "fresh build, TOLL_SITE_URL unset");
  const refs = urlRefs(OUT);
  assert.deepEqual(refs.filter((r) => r.canonical), [], "no canonical without a site root");
  assert.ok(refs.length >= 30, "the scan sees the pages' references: " + refs.length);
  for (const k of ["href", "src", "srcset", "url()"]) assert.ok(refs.some((r) => r.kind === k), "the scan sees " + k);
  assert.ok(refs.some((r) => r.file === "home.css" && r.kind === "url()"), "the scan reads the dist stylesheets");
  // Fragment-only and data: references are allowed but there are none today; this lists any that appear.
  assert.deepEqual(refs.filter((r) => isFragmentOrData(r.url)).map((r) => `${r.file} ${r.url}`), [], "fragment or data: references (allowed; none expected)");
  const set = build(tmp(), SITE, () => {});
  assert.deepEqual(badRefs(set, SITE), [], "fresh build, TOLL_SITE_URL set");
  assert.deepEqual(urlRefs(set).filter((r) => /^https?:/i.test(r.url)).map((r) => r.canonical), [true, true, true, true, true], "the only absolute URLs are the five canonicals");
  // The checker itself: the same canonicals are flagged when no site root allows them.
  assert.deepEqual(badRefs(set, null).length, 5, "a canonical without a site root is flagged");
});

test("links: wordmark '/', pages '/mission', '/vision', '/values', '/ecosystem' on the homepage and on every page", () => {
  const home = readFileSync(OUT + "index.html", "utf8");
  assert.match(home, /<a class="sign" href="\/" aria-current="page">Toll<\/a>/, "homepage wordmark is the current page");
  const nav = /<nav aria-label="Main">([\s\S]*?)<\/nav>/.exec(home)![1];
  assert.deepEqual([...nav.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], decode(m[2])]),
    [["/mission", "Mission"], ["/vision", "Vision"], ["/values", "Values"], ["/ecosystem", "Where Toll fits"]]);
  for (const p of PAGES) {
    const h = readFileSync(OUT + p.file + ".html", "utf8");
    assert.match(h, /<a class="mark" href="\/">Toll<\/a>/, p.file);
    for (const u of hrefs(h)) assert.match(u, /^\/(mission|vision|values|ecosystem)?$|^\/(site\.css|favicon\.ico|favicon\.svg|apple-touch-icon\.png)$/, p.file + ": " + u);
  }
});

test("canonical: TOLL_SITE_URL unset (null), empty or invalid means no canonical tag on any page", () => {
  for (const raw of [null, "", "   ", "http://site.example", "garbage", "https://user@site.example", "https://site.example?x=1"]) {
    const warned: string[] = [];
    const dir = build(tmp(), raw as any, (m: string) => warned.push(m));
    for (const f of FILES) {
      const h = readFileSync(dir + f + ".html", "utf8");
      assert.deepEqual(canonicals(h), [], `${JSON.stringify(raw)}: ${f} has no canonical`);
      assert.equal(h, readFileSync(OUT + f + ".html", "utf8"), `${JSON.stringify(raw)}: ${f} is byte-identical to a build without TOLL_SITE_URL`);
      assert.doesNotMatch(h, /https?:|\/\/[a-z0-9]/i, `${f}: no absolute URL`);
    }
    if (raw !== null && raw.trim() !== "") {
      assert.equal(warned.length, 1, JSON.stringify(raw) + " is reported once");
      assert.ok(!warned[0].includes(raw), "the value itself is not logged");
    } else assert.deepEqual(warned, []);
  }
});

test("canonical: TOLL_SITE_URL=https://site.example gives each page a canonical to itself", () => {
  for (const raw of [SITE, SITE + "/", " " + SITE + "/\n"]) {
    const dir = build(tmp(), raw, () => assert.fail("valid value must not warn"));
    const want: Record<string, string> = { index: SITE + "/", mission: SITE + "/mission", vision: SITE + "/vision", values: SITE + "/values", ecosystem: SITE + "/ecosystem" };
    for (const f of FILES) {
      const h = readFileSync(dir + f + ".html", "utf8");
      assert.deepEqual(canonicals(h), [`<link rel="canonical" href="${want[f]}">`], `${JSON.stringify(raw)}: ${f}`);
      assert.ok(h.indexOf("rel=\"canonical\"") < h.indexOf("</head>"), f + ": canonical is in the head");
      // The canonical is the only absolute URL; everything else stays local.
      assert.equal([...h.matchAll(/https?:\/\//g)].length, 1, f + ": one absolute URL, the canonical");
    }
  }
  // A site root with a path keeps it.
  const dir = build(tmp(), SITE + "/docs/", () => {});
  assert.deepEqual(canonicals(readFileSync(dir + "index.html", "utf8")), [`<link rel="canonical" href="${SITE}/docs/">`]);
  assert.deepEqual(canonicals(readFileSync(dir + "values.html", "utf8")), [`<link rel="canonical" href="${SITE}/docs/values">`]);
});

test("words: every homepage string is in docs/copy.md verbatim, and the page shows exactly them", () => {
  const copy = readFileSync(ROOT + "docs/copy.md", "utf8");
  const head = section(copy, "Homepage head tags");
  assert.ok(head.includes("- `<title>`: " + HOME.title + "\n"), "title as placed by the PM");
  assert.ok(head.includes("- `<meta name=\"description\">`: " + HOME.description + "\n"), "description as placed by the PM");
  assert.ok(HOME.title.includes(" \u00B7 "), "the separator is U+00B7 MIDDLE DOT with a space on each side");
  assert.ok(copy.includes('"' + HOME.alt + '"'), "alt text");
  for (const s of [HOME.kicker, HOME.h1.join(" "), HOME.line, HOME.plate, ...HOME.meta.map((m: string[]) => m.join(" ")), ...PAGES.map((p: any) => p.nav)]) assert.ok(copy.includes(s), s);
  const h = readFileSync(OUT + "index.html", "utf8");
  assert.match(h, /<html lang="en">/);
  assert.ok(h.includes("<title>" + HOME.title + "</title>"));
  assert.ok(h.includes('<meta name="description" content="' + HOME.description + '">'));
  assert.ok(h.includes(' alt="' + HOME.alt + '" width="1280" height="853" fetchpriority="high">'));
  const text = h.replace(/<head>[\s\S]*<\/head>/, "").replace(/<[^>]+>/g, "\n").split("\n").map((t) => decode(t).trim()).filter(Boolean);
  assert.deepEqual(text, ["Toll", "Mission", "Vision", "Values", "Where Toll fits", HOME.kicker, ...HOME.h1, HOME.line, ...HOME.meta.flat(), HOME.plate]);
  assert.equal(h.match(/<h1>/g)!.length, 1, "one h1");
  assert.doesNotMatch(h, /TODO|lorem/i, "no placeholder left");
});

test("homepage: no scripts, no inline styles, no external requests; fonts preloaded locally with their OFL texts", () => {
  const h = readFileSync(OUT + "index.html", "utf8");
  assert.doesNotMatch(h, /<script|<style|\sstyle=|\son[a-z]+\s*=|javascript:|<iframe|<object|<embed|<base\b|http-equiv/i);
  assert.doesNotMatch(h, /https?:|\/\/[a-z0-9]/i, "no absolute or protocol-relative URL");
  const urls = [...h.matchAll(/\s(?:href|src)="([^"]*)"/gi)].map((m) => m[1]);
  const srcset = /\ssrcset="([^"]*)"/.exec(h)![1].split(",").map((c) => c.trim().split(/\s+/)[0]);
  for (const u of [...urls, ...srcset]) assert.match(u, /^\/(mission|vision|values|ecosystem)?$|^\/(home\.css|img\/forest-road-(1280|2560)\.jpg|fonts\/arvo\/Arvo-Bold\.woff2|favicon\.ico|favicon\.svg|apple-touch-icon\.png)$/, u);
  assert.match(h, /sizes="\(max-width:760px\) max\(100vw, 69svh\), 150svh"/);
  assert.deepEqual([...h.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]), [
    '<link rel="icon" href="/favicon.ico" sizes="32x32">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<link rel="preload" href="/fonts/arvo/Arvo-Bold.woff2" as="font" type="font/woff2" crossorigin>',
    '<link rel="stylesheet" href="/home.css">',
  ], "Arvo is the only preload");
  const css = readFileSync(OUT + "home.css", "utf8");
  assert.doesNotMatch(css, /@import|https?:|\/\/[a-z0-9]/i, "the stylesheet fetches nothing remote");
  assert.deepEqual([...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]), ["/fonts/arvo/Arvo-Bold.woff2", "/fonts/public-sans/PublicSans-Latin.woff2"]);
  assert.equal(css.match(/font-display:swap/g)!.length, 2);
  assert.doesNotMatch(css, /nav a\{[^}]*opacity/, "the nav uses full --muted, no opacity (contrast)");
  assert.match(css, /a:focus-visible\{outline:2px solid var\(--sign\);outline-offset:3px\}/);
  for (const d of ["arvo", "public-sans"]) assert.match(readFileSync(OUT + "fonts/" + d + "/LICENSE.txt", "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/, d);
  assert.match(readFileSync(OUT + "fonts/arvo/LICENSE.txt", "utf8"), /Reserved Font Name 'Arvo'/);
  for (const f of ["fonts/arvo/Arvo-Bold.woff2", "fonts/public-sans/PublicSans-Latin.woff2"]) assert.equal(readFileSync(OUT + f).subarray(0, 4).toString("latin1"), "wOF2", f);
});

let server: Server;
let base = "";
const CSP = "default-src 'self'";
before(async () => {
  server = createServer((req, res) => {
    let f = (req.url ?? "/").split("?")[0].replace(/^\//, "") || "index";
    if (f === "nested/deep/" || f === "mission/") f = f === "mission/" ? "mission" : "index"; // pages at other paths
    if (/^[a-z]+$/.test(f)) f += ".html";
    if (!/^[a-z0-9/-]+\.[a-z0-9]+$/i.test(f) || f.includes("..") || !existsSync(OUT + f)) { res.writeHead(404).end(); return; }
    const type: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css", jpg: "image/jpeg", woff2: "font/woff2", txt: "text/plain; charset=utf-8", png: "image/png", ico: "image/x-icon", svg: "image/svg+xml" };
    res.writeHead(200, { "content-type": type[f.split(".").pop()!] ?? "application/octet-stream", "content-security-policy": CSP }).end(readFileSync(OUT + f));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}/`;
});
after(() => server?.close());

test("in a browser under CSP default-src 'self': only same-origin requests, no CSP violations, no sideways scroll", async () => {
  const browser = await chromium.launch();
  try {
    for (const width of [1280, 390, 320]) {
      const ctx = await browser.newContext({ viewport: { width, height: width > 760 ? 800 : 844 } });
      const page = await ctx.newPage();
      const seen: string[] = [];
      const problems: string[] = [];
      page.on("request", (r) => seen.push(r.url()));
      page.on("console", (m) => { if (/Content.Security.Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
      await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error("Refused to load: CSP " + e.violatedDirective + " " + e.blockedURI)));
      const res = await page.goto(base, { waitUntil: "networkidle" });
      assert.equal(res!.status(), 200);
      assert.equal(res!.headers()["content-security-policy"], CSP);
      await page.evaluate(() => document.fonts.ready);
      assert.deepEqual(problems, [], width + ": CSP violations");
      for (const u of seen) assert.ok(u.startsWith(base), `${width}: ${u} is same-origin`);
      assert.ok(seen.includes(base + "home.css") && seen.includes(base + "fonts/arvo/Arvo-Bold.woff2"), width + ": stylesheet and Arvo load");
      assert.equal(await page.evaluate(() => document.scripts.length), 0);
      assert.equal(await page.evaluate(() => document.fonts.check('700 20px "Toll Slab"')), true, width + ": Toll Slab loaded");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, width + ": no sideways scroll");
      await ctx.close();
    }
    // Root-relative assets: the same pages served at other paths ("/nested/deep/", "/mission/") still load
    // every stylesheet, font and image from the root, with nothing failing.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    for (const [path, want] of [["nested/deep/", ["home.css", "fonts/arvo/Arvo-Bold.woff2", "fonts/public-sans/PublicSans-Latin.woff2", "img/forest-road-1280.jpg"]], ["mission/", ["site.css"]]] as const) {
      const ok: string[] = [], bad: string[] = [];
      const onRes = (r: any) => (r.status() === 200 ? ok : bad).push(r.url() + " " + r.status());
      page.on("response", onRes);
      page.on("requestfailed", (r) => bad.push(r.url() + " failed"));
      assert.equal((await page.goto(base + path, { waitUntil: "networkidle" }))!.status(), 200, path);
      await page.evaluate(() => document.fonts.ready);
      page.off("response", onRes);
      page.removeAllListeners("requestfailed");
      assert.deepEqual(bad, [], path + ": nothing fails");
      for (const w of want) assert.ok(ok.includes(base + w + " 200"), `${path}: ${w} loads from the root (${ok.join(", ")})`);
    }
    await ctx.close();
  } finally {
    await browser.close();
  }
});
