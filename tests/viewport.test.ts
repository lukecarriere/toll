// Phone width: a 390px layout of /demo was 423px wide because the curl line set the grid's
// minimum, and the form fields ran past the right edge. Every public page must stay within
// the viewport at 360 and 390. npm test runs this in CI.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { chromium } from "playwright";
// @ts-ignore plain JS build script
import { build, DOC_PAGES, pagePath } from "../website/build.mjs";

const OUT = build(mkdtempSync(join(tmpdir(), "toll-viewport-")) + "/", "");
const PATHS = ["/", "/demo", ...DOC_PAGES.map((p: { file: string }) => pagePath(p.file))];
const WIDTHS = [360, 390];

let server: Server;
let base = "";
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css", js: "text/javascript", woff2: "font/woff2", png: "image/png", ico: "image/x-icon", svg: "image/svg+xml", jpg: "image/jpeg" };

before(async () => {
  server = createServer((req, res) => {
    let path = (req.url ?? "/").split("?")[0];
    if (path.endsWith("/")) path = path.slice(0, -1);
    let file = path === "" ? "index.html" : path.replace(/^\//, "");
    if (!extname(file)) file = file === "docs" || file === "download" ? file + "/index.html" : file + ".html";
    if (file.includes("..") || !existsSync(OUT + file)) { res.writeHead(404).end(); return; }
    const ext = extname(file).slice(1);
    res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream" }).end(readFileSync(OUT + file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server?.close());

test("phone width: scrollWidth <= innerWidth at 360 and 390 for /, /demo, the docs pages and /download", async () => {
  for (const p of ["/", "/demo", "/docs", "/docs/quick-start", "/docs/widget", "/docs/server", "/docs/agent", "/docs/mcp", "/docs/wordpress", "/docs/self-hosting", "/download"]) {
    assert.ok(PATHS.includes(p), p + " is covered");
  }
  assert.ok(PATHS.filter((p) => p.startsWith("/docs")).length >= 8, "every docs page");
  const browser = await chromium.launch();
  try {
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width, height: 844 } });
      const page = await ctx.newPage();
      for (const path of PATHS) {
        const res = await page.goto(base + path, { waitUntil: "networkidle" });
        assert.equal(res!.status(), 200, path + " " + width);
        await page.evaluate(() => document.fonts.ready);
        const box = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        assert.equal(box.iw, width, `${path} @ ${width}: layout width`);
        assert.ok(box.sw <= box.iw, `${path} @ ${width}: scrollWidth ${box.sw} > innerWidth ${box.iw}`);
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
});
