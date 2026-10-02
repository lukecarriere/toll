// Amendment 2 §D/§E: the public mission pages. Wording is docs/copy.md "Website pages", character for character; the
// built pages carry no scripts, analytics, pixels, cookies or external requests (Values: "No tracking pixels.").
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
// @ts-ignore plain JS build script
import { build, PAGES, ICON_TAGS } from "../website/build.mjs";
// @ts-ignore plain JS helper
import { runLint } from "../scripts/copy-lint.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = build(mkdtempSync(join(tmpdir(), "toll-website-")) + "/", ""); // TOLL_SITE_URL unset: no canonical tags
const md = (f: string) => readFileSync(ROOT + "website/" + f + ".md", "utf8");
const html = (f: string) => readFileSync(OUT + f + ".html", "utf8");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const A2 = ROOT + "AMENDMENT_2.md";
const A3 = ROOT + "AMENDMENT_3.md";

/** Visible text of a markdown page: title, then each paragraph or list item. */
function mdText(src: string) {
  return src.trim().split(/\n\s*\n/).flatMap((b) => b.split("\n").every((l) => l.startsWith("- ")) ? b.split("\n").map((l) => l.slice(2)) : [b.replace(/^# /, "")]).map(norm);
}
/** Visible text of a built page's main: h1, then each p or li. */
function htmlText(src: string) {
  const main = /<main>([\s\S]*)<\/main>/.exec(src)![1];
  return [...main.matchAll(/<(h1|p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => norm(decode(m[2])));
}

test("website/*.md are the Creative Director's pages in docs/copy.md, word for word; the held catalog paragraph stays out", () => {
  // docs/copy.md "Website pages": one "### " block per page, in nav order. Numbered lines are paragraphs,
  // "- " lines are list items. [QA: ...] tags are notes for QA, not copy; "HOLD" lines are not published.
  const copy = readFileSync(ROOT + "docs/copy.md", "utf8");
  const from = copy.indexOf("\n## Website pages");
  const to = copy.indexOf("\n## ", from + 1);
  const parts = copy.slice(from, to < 0 ? undefined : to).split(/^### /m).slice(1);
  assert.equal(parts.length, 4);
  for (const [i, part] of parts.entries()) {
    const page = PAGES[i];
    const lines = part.split("\n");
    assert.ok(lines[0].includes("`website/" + page.file + "`"), page.file);
    const heading = lines.find((l) => l.startsWith("Heading: "))?.slice(9) ?? lines[0].split(" (")[0];
    const items = lines.filter((l) => /^(\d+\.|-) /.test(l) && !/^\d+\. HOLD\b/.test(l))
      .map((l) => l.replace(/^(\d+\.|-) /, "").replace(/^Closing line \([^)]*\): /, "").replace(/ \[QA:[^\]]*\]/g, ""));
    const list = lines.some((l) => l.startsWith("- "));
    const expected = `# ${heading}\n\n` + (list ? items.map((t) => "- " + t).join("\n") : items.join("\n\n"));
    assert.equal(norm(md(page.file)), norm(expected), page.file + ".md");
  }
  assert.equal(PAGES[3].nav, "Where Toll fits");
  assert.doesNotMatch(md("ecosystem"), /public tool catalogs/, "catalog paragraph is on hold");
});

test("docs/positioning.md is Amendment 2 §B as written (one banned word replaced), with the discovery note", { skip: existsSync(A2) ? false : "AMENDMENT_2.md not present" }, () => {
  const a = readFileSync(A2, "utf8");
  const sec = (start: string) => { const i = a.indexOf(start) + start.length; return a.slice(i, a.indexOf("\n---\n", i)).trim(); };
  // The brand brief's lint list bans "taxes"; positioning.md is linted, so that one word is "gates" (EM, Oct 1).
  const b = sec("## B. Where Toll sits (for the team, not the homepage)\n").replace("They clash only if Toll taxes the read.", "They clash only if Toll gates the read.");
  const pos = norm(readFileSync(ROOT + "docs/positioning.md", "utf8"));
  assert.ok(pos.includes(norm(b)), "positioning.md carries §B verbatim");
  assert.match(pos, /## Discovery .*AMENDMENT_3\.md/, "discovery note points at Amendment 3");
});

test("built pages carry exactly the markdown text: header, nav with aria-current, list for values, closing line set off", () => {
  for (const p of PAGES) {
    const h = html(p.file);
    assert.deepEqual(htmlText(h), mdText(md(p.file)), p.file);
    const nav = /<nav aria-label="Pages">([\s\S]*?)<\/nav>/.exec(h)![1];
    assert.deepEqual([...nav.matchAll(/>([^<]+)<\/a>/g)].map((m) => decode(m[1])), ["Mission", "Vision", "Values", "Where Toll fits"]);
    assert.deepEqual([...nav.matchAll(/href="([^"]+)" aria-current="page"/g)].map((m) => m[1]), ["/" + p.file]);
    assert.deepEqual([...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ["/mission", "/vision", "/values", "/ecosystem"], "root-relative, no extension (EM, Oct 2)");
    assert.match(h, /<a class="mark" href="\/">Toll<\/a>/, "the wordmark goes to the homepage");
    assert.doesNotMatch(h, /<footer|<img|<svg|<picture|<video|<audio|<iframe|<form/i);
  }
  assert.match(html("values"), /<ul><li>/);
  assert.match(html("ecosystem"), /<p class="close">The site stays open\. Spam takes another road\.<\/p>\n<\/main>/);
  assert.match(readFileSync(OUT + "site.css", "utf8"), /p\.close\{[^}]*border-top:1px solid[^}]*font-weight:600/);
});

test("no analytics: no <script>, no inline handlers, no external URLs, no pixels, no cookies in the built HTML and CSS", () => {
  const files = readdirSync(OUT).sort();
  // The homepage (index.html, home.css, img/, fonts/) is checked in tests/homepage.test.ts, the icons in tests/favicon.test.ts.
  assert.deepEqual(files, ["apple-touch-icon.png", "ecosystem.html", "favicon.ico", "favicon.svg", "fonts", "home.css", "img", "index.html", "mission.html", "site.css", "values.html", "vision.html"], "nothing else is shipped");
  for (const p of PAGES) {
    const h = html(p.file);
    assert.doesNotMatch(h, /<script/i, p.file + ": no script tag");
    assert.doesNotMatch(h, /<noscript|<object|<embed|<iframe|<img|<base\b/i, p.file);
    assert.doesNotMatch(h, /\son[a-z]+\s*=/i, p.file + ": no inline event handlers");
    assert.doesNotMatch(h, /javascript:|http-equiv|set-cookie|document\.cookie|posthog|gtag|googletagmanager|google-analytics|plausible|segment\.|fbq|hotjar|matomo/i, p.file);
    assert.doesNotMatch(h, /https?:|\/\/[a-z0-9]/i, p.file + ": no absolute or protocol-relative URL anywhere");
    const urls = [...h.matchAll(/\s(?:href|src|action|srcset|poster|data)="([^"]*)"/gi)].map((m) => m[1]);
    for (const u of urls) assert.match(u, /^\/(mission|vision|values|ecosystem)?$|^\/(site\.css|favicon\.ico|favicon\.svg|apple-touch-icon\.png)$/, `${p.file}: ${u} is a local page, the stylesheet or an icon`);
    const links = [...h.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    assert.deepEqual(links, ['<link rel="icon" href="/favicon.ico" sizes="32x32">', '<link rel="icon" href="/favicon.svg" type="image/svg+xml">', '<link rel="apple-touch-icon" href="/apple-touch-icon.png">', '<link rel="stylesheet" href="/site.css">'], p.file + ": the three local icons and one local stylesheet, no preconnect/prefetch/fonts");
  }
  const css = readFileSync(OUT + "site.css", "utf8");
  assert.doesNotMatch(css, /url\(|@import|@font-face|https?:/i, "the stylesheet fetches nothing");
});

let server: Server;
let base = "";
before(async () => {
  server = createServer((req, res) => {
    // Extensionless routes, as the site is served: "/" is index.html, "/mission" is mission.html.
    let f = (req.url ?? "/").split("?")[0].replace(/^\//, "") || "index";
    if (/^[a-z]+$/.test(f)) f += ".html";
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
      const res = await page.goto(base + p.file, { waitUntil: "networkidle" });
      assert.equal(res!.status(), 200);
      assert.deepEqual([...new Set(seen)].sort(), [base + p.file, base + "site.css"].sort(), p.file + ": requests");
      assert.equal(await page.evaluate(() => document.scripts.length), 0);
      assert.equal(await page.evaluate(() => document.cookie), "");
      assert.equal(await page.locator("p.close").count(), p.closingLine ? 1 : 0);
    }
    assert.deepEqual(await ctx.cookies(), []);
  } finally {
    await browser.close();
  }
});

test("copy lint covers website/ and docs/positioning.md, and they pass as written", async () => {
  const r = await runLint();
  assert.deepEqual(r.hits.filter((h: any) => h.file.startsWith("website/") || h.file === "docs/positioning.md"), []);
  assert.ok(md("values").includes("We do not score visitors as human or not."), "Luke's one use of 'human' stays");
});

test("built pages match the Designer's template byte for byte, apart from the EM's root-relative rulings", { skip: existsSync(ROOT + "design/proto/website/mission.html") ? false : "design/ not present (gitignored)" }, () => {
  // EM rulings (Oct 2): the wordmark goes to "/", every page link is root-relative with no extension,
  // the stylesheet is "/site.css", and the three icon tags sit just before it. Those are the only changes
  // to the template; everything else must match.
  const links = (t: string) => t.replace('<a class="mark" href="mission.html">', '<a class="mark" href="/">').replace(/href="(mission|vision|values|ecosystem)\.html"/g, 'href="/$1"')
    .replace('<link rel="stylesheet" href="site.css">', ICON_TAGS + '<link rel="stylesheet" href="/site.css">');
  for (const f of [...PAGES.map((p: any) => p.file + ".html"), "site.css"]) assert.equal(readFileSync(OUT + f, "utf8"), links(readFileSync(ROOT + "design/proto/website/" + f, "utf8")), f);
});
