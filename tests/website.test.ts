// Amendment 2 §D/§E: the public mission pages. Wording is the copy, character for character; the
// built pages carry no scripts, analytics, pixels, cookies or external requests (Values: "No tracking pixels.").
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
// @ts-ignore plain JS build script
import { build, PAGES } from "../website/build.mjs";
// @ts-ignore plain JS helper
import { runLint } from "../scripts/copy-lint.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = build(mkdtempSync(join(tmpdir(), "toll-website-")) + "/");
const md = (f: string) => readFileSync(ROOT + "website/" + f + ".md", "utf8");
const html = (f: string) => readFileSync(OUT + f + ".html", "utf8");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const A2 = ROOT + "AMENDMENT_2.md";

/** Visible text of a markdown page: title, then each paragraph or list item. */
function mdText(src: string) {
  return src.trim().split(/\n\s*\n/).flatMap((b) => b.split("\n").every((l) => l.startsWith("- ")) ? b.split("\n").map((l) => l.slice(2)) : [b.replace(/^# /, "")]).map(norm);
}
/** Visible text of a built page's main: h1, then each p or li. */
function htmlText(src: string) {
  const main = /<main>([\s\S]*)<\/main>/.exec(src)![1];
  return [...main.matchAll(/<(h1|p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => norm(decode(m[2])));
}

test("website/*.md and docs/positioning.md are Amendment 2 §E and §B as written", { skip: existsSync(A2) ? false : "AMENDMENT_2.md not present" }, () => {
  const a = readFileSync(A2, "utf8");
  const sec = (start: string) => { const i = a.indexOf(start) + start.length; return a.slice(i, a.indexOf("\n---\n", i)).trim(); };
  const e = sec("## E. Website copy (publish as written)\n").split(/^### /m).filter(Boolean);
  assert.equal(e.length, 4);
  for (const [i, part] of e.entries()) {
    const [title, ...rest] = part.split("\n");
    const page = PAGES[i];
    assert.equal(norm(md(page.file)), norm(`# ${title}\n\n${rest.join("\n")}`), page.file + ".md");
  }
  assert.equal(PAGES[3].nav, "Where Toll fits");
  assert.ok(norm(readFileSync(ROOT + "docs/positioning.md", "utf8")).endsWith(norm(sec("## B. Where Toll sits (for the team, not the homepage)\n"))), "positioning.md ends with §B verbatim");
});

test("built pages carry exactly the markdown text: header, nav with aria-current, list for values, closing line set off", () => {
  for (const p of PAGES) {
    const h = html(p.file);
    assert.deepEqual(htmlText(h), mdText(md(p.file)), p.file);
    const nav = /<nav aria-label="Pages">([\s\S]*?)<\/nav>/.exec(h)![1];
    assert.deepEqual([...nav.matchAll(/>([^<]+)<\/a>/g)].map((m) => decode(m[1])), ["Mission", "Vision", "Values", "Where Toll fits"]);
    assert.deepEqual([...nav.matchAll(/href="([^"]+)" aria-current="page"/g)].map((m) => m[1]), [p.file + ".html"]);
    assert.match(h, /<a class="mark" href="mission\.html">Toll<\/a>/);
    assert.doesNotMatch(h, /<footer|<img|<svg|<picture|<video|<audio|<iframe|<form/i);
  }
  assert.match(html("values"), /<ul><li>/);
  assert.match(html("ecosystem"), /<p class="close">Leave the front door open\. Lock the counter\.<\/p>\n<\/main>/);
  assert.match(readFileSync(OUT + "site.css", "utf8"), /p\.close\{[^}]*border-top:1px solid[^}]*font-weight:600/);
});

test("no analytics: no <script>, no inline handlers, no external URLs, no pixels, no cookies in the built HTML and CSS", () => {
  const files = readdirSync(OUT).sort();
  assert.deepEqual(files, ["ecosystem.html", "mission.html", "site.css", "values.html", "vision.html"], "nothing else is shipped");
  for (const p of PAGES) {
    const h = html(p.file);
    assert.doesNotMatch(h, /<script/i, p.file + ": no script tag");
    assert.doesNotMatch(h, /<noscript|<object|<embed|<iframe|<img|<base\b/i, p.file);
    assert.doesNotMatch(h, /\son[a-z]+\s*=/i, p.file + ": no inline event handlers");
    assert.doesNotMatch(h, /javascript:|http-equiv|set-cookie|document\.cookie|posthog|gtag|googletagmanager|google-analytics|plausible|segment\.|fbq|hotjar|matomo/i, p.file);
    assert.doesNotMatch(h, /https?:|\/\/[a-z0-9]/i, p.file + ": no absolute or protocol-relative URL anywhere");
    const urls = [...h.matchAll(/\s(?:href|src|action|srcset|poster|data)="([^"]*)"/gi)].map((m) => m[1]);
    for (const u of urls) assert.match(u, /^(mission|vision|values|ecosystem)\.html$|^site\.css$/, `${p.file}: ${u} is a local page or the stylesheet`);
    const links = [...h.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    assert.deepEqual(links, ['<link rel="stylesheet" href="site.css">'], p.file + ": one local stylesheet, no preconnect/prefetch/fonts");
  }
  const css = readFileSync(OUT + "site.css", "utf8");
  assert.doesNotMatch(css, /url\(|@import|@font-face|https?:/i, "the stylesheet fetches nothing");
});

let server: Server;
let base = "";
before(async () => {
  server = createServer((req, res) => {
    const f = (req.url ?? "/").split("?")[0].replace(/^\//, "");
    if (!/^[a-z]+\.(html|css)$/.test(f) || !existsSync(OUT + f)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": f.endsWith(".css") ? "text/css" : "text/html; charset=utf-8" }).end(readFileSync(OUT + f));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}/`;
});
after(() => server?.close());

test("in a browser each page makes only same-origin requests (the page and site.css), sets no cookies and has no scripts", async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const seen: string[] = [];
    page.on("request", (r) => seen.push(r.url()));
    for (const p of PAGES) {
      seen.length = 0;
      const res = await page.goto(base + p.file + ".html", { waitUntil: "networkidle" });
      assert.equal(res!.status(), 200);
      assert.deepEqual([...new Set(seen)].sort(), [base + p.file + ".html", base + "site.css"].sort(), p.file + ": requests");
      assert.equal(await page.evaluate(() => document.scripts.length), 0);
      assert.equal(await page.evaluate(() => document.cookie), "");
      assert.equal(await page.locator("p.close").count(), p.closingLine ? 1 : 0);
    }
    assert.deepEqual(await ctx.cookies(), []);
  } finally {
    await browser.close();
  }
});

test("copy lint covers website/ and docs/positioning.md, and they pass as written", () => {
  const r = runLint();
  assert.deepEqual(r.hits.filter((h: any) => h.file.startsWith("website/") || h.file === "docs/positioning.md"), []);
  assert.ok(md("values").includes("We do not score visitors as human or not."), "Luke's one use of 'human' stays");
});

test("built pages match the Designer's template byte for byte", { skip: existsSync(ROOT + "design/proto/website/mission.html") ? false : "design/ not present (gitignored)" }, () => {
  for (const f of [...PAGES.map((p: any) => p.file + ".html"), "site.css"]) assert.equal(readFileSync(OUT + f, "utf8"), readFileSync(ROOT + "design/proto/website/" + f, "utf8"), f);
});
