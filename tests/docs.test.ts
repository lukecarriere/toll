// Visitor guides (issues #8 and #9): quick start, widget, server, agent SDK, MCP, WordPress,
// self-hosting, and the download page. Linked from the homepage nav. The four mission pages stay
// the released HTML, so they do not gain the Docs link.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { chromium } from "playwright";
// @ts-ignore plain JS build script
import { build, DOC_PAGES, GUIDE_PAGES, ICON_TAGS, pagePath, pluginRelease } from "../website/build.mjs";
// @ts-ignore plain JS helper
import { lintText, lintVendor } from "../scripts/copy-lib.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = build(mkdtempSync(join(tmpdir(), "toll-docs-")) + "/", "");
const SET = build(mkdtempSync(join(tmpdir(), "toll-docs-set-")) + "/", "https://site.example", () => {});
const rel = pluginRelease();
const hrefs = (h: string) => [...h.matchAll(/\shref="([^"]*)"/gi)].map((m) => m[1]);
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

test("guides: one h1, the copy.md description, icons, docs.css, no script, no .html href", () => {
  assert.equal(DOC_PAGES.length, 9);
  assert.deepEqual(GUIDE_PAGES.map((p: { file: string }) => p.file), DOC_PAGES.map((p: { file: string }) => p.file).filter((f: string) => f !== "docs/index"));
  for (const p of DOC_PAGES) {
    const h = readFileSync(OUT + p.file + ".html", "utf8");
    const md = readFileSync(ROOT + "website/" + p.file + ".md", "utf8").replace(/\r\n/g, "\n");
    const title = /^# (.+)$/m.exec(md)![1].replaceAll("{{VERSION}}", rel.version);
    assert.match(h, new RegExp("<h1>" + title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "</h1>"), p.file);
    assert.equal([...h.matchAll(/<h1>/g)].length, 1, p.file);
    assert.ok(h.includes(ICON_TAGS), p.file);
    assert.ok(h.includes('<link rel="stylesheet" href="/docs.css">'), p.file);
    assert.ok(h.includes('<link rel="stylesheet" href="/site.css">'), p.file);
    assert.doesNotMatch(h, /<script|<style|\sstyle=|\son[a-z]+\s*=|javascript:/i, p.file);
    assert.doesNotMatch(h, /\{\{VERSION\}\}|\{\{SHA\}\}/, p.file + ": tokens replaced");
    const nav = /<nav class="guides" aria-label="Guides">([\s\S]*?)<\/nav>/.exec(h)![1];
    const current = [...nav.matchAll(/href="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
    assert.deepEqual(current, p.file === "docs/index" ? [] : [pagePath(p.file)], p.file);
    for (const u of hrefs(h)) {
      assert.doesNotMatch(u, /\.html?(?:$|[?#])/i, p.file + " " + u);
      if (u.startsWith("/")) assert.match(u, /^\/(?!\/)/, u);
    }
    assert.deepEqual([...lintText("website/dist/" + p.file + ".html", h), ...lintVendor("website/dist/" + p.file + ".html", h)], [], p.file);
  }
  const home = readFileSync(OUT + "index.html", "utf8");
  assert.match(home, /<a href="\/docs">Docs<\/a>/);
  for (const name of ["mission", "vision", "values", "ecosystem"]) {
    assert.doesNotMatch(readFileSync(OUT + name + ".html", "utf8"), /href="\/docs"/, name + " stays the released nav");
  }
});

test("guides: canonicals point at the extensionless path, and only when a site root is set", () => {
  for (const p of DOC_PAGES) {
    assert.equal([...readFileSync(OUT + p.file + ".html", "utf8").matchAll(/rel="canonical"/g)].length, 0, p.file);
    const set = readFileSync(SET + p.file + ".html", "utf8");
    assert.match(set, new RegExp(`<link rel="canonical" href="https://site\\.example${pagePath(p.file)}">`), p.file);
    const abs = hrefs(set).filter((u) => /^https?:/i.test(u));
    assert.deepEqual(abs, ["https://site.example" + pagePath(p.file)], p.file + ": the canonical is the only absolute href");
  }
});

test("download and WordPress pages link the GPL plugin zip", () => {
  const zip = "/download/" + rel.zip;
  const sha = zip + ".sha256";
  for (const file of ["download/index.html", "docs/wordpress.html"]) {
    const h = readFileSync(OUT + file, "utf8");
    assert.ok(h.includes(`href="${zip}"`), file);
    assert.ok(h.includes(`href="${sha}"`), file);
    assert.match(h, /GPL-2\.0-or-later/);
  }
  const page = readFileSync(OUT + "download/index.html", "utf8");
  assert.match(page, new RegExp("<h1>Download</h1>"));
  assert.match(decode(page), new RegExp("Version " + rel.version.replace(/\./g, "\\.")));
  if (existsSync(OUT + "download/" + rel.shaName)) {
    const hex = readFileSync(OUT + "download/" + rel.shaName, "utf8").trim().split(/\s+/)[0];
    assert.match(page, new RegExp("<pre><code>" + hex + "</code></pre>"));
  }
});

let server: Server;
let base = "";
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css", woff2: "font/woff2", png: "image/png", ico: "image/x-icon", svg: "image/svg+xml", jpg: "image/jpeg" };

before(async () => {
  server = createServer((req, res) => {
    let path = (req.url ?? "/").split("?")[0];
    if (path.endsWith("/")) path = path.slice(0, -1);
    let file = path === "" ? "index.html" : path.replace(/^\//, "");
    if (!extname(file)) file = file === "docs" || file === "download" ? file + "/index.html" : file + ".html";
    if (file.includes("..") || !existsSync(OUT + file)) { res.writeHead(404).end(); return; }
    const ext = extname(file).slice(1);
    res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream", "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'" }).end(readFileSync(OUT + file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server?.close());

test("guides in a browser: 200, same-origin, no sideways scroll at phone width", async () => {
  const browser = await chromium.launch();
  try {
    for (const width of [390, 320, 1280]) {
      const ctx = await browser.newContext({ viewport: { width, height: width > 760 ? 800 : 844 } });
      const page = await ctx.newPage();
      const problems: string[] = [];
      page.on("console", (m) => { if (/Content.Security.Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
      for (const p of DOC_PAGES) {
        const seen: string[] = [];
        const onReq = (r: { url: () => string }) => seen.push(r.url());
        page.on("request", onReq);
        const res = await page.goto(base + pagePath(p.file), { waitUntil: "networkidle" });
        assert.equal(res!.status(), 200, p.file + " " + width);
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => document.scripts.length), 0, p.file);
        assert.equal(await page.locator("h1").innerText(), /^# (.+)$/m.exec(readFileSync(ROOT + "website/" + p.file + ".md", "utf8"))![1].replaceAll("{{VERSION}}", rel.version), p.file);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${p.file} ${width}: no sideways scroll`);
        for (const u of seen) assert.ok(u.startsWith(base), `${p.file} ${width}: ${u}`);
        page.off("request", onReq);
      }
      assert.deepEqual(problems, [], width + ": CSP");
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
});
