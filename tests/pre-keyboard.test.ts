// Overflowing <pre> regions must be focusable so a keyboard user can scroll
// them (WCAG 2.1.1, axe-core scrollable-region-focusable). Issue #62.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { chromium } from "playwright";
// @ts-ignore plain JS build script
import { build } from "../website/build.mjs";

const OUT = build(mkdtempSync(join(tmpdir(), "toll-pre-")) + "/", "");
const PATHS = ["/docs/quick-start", "/docs/widget", "/docs/pay-with-nwc", "/download", "/demo"] as const;
const VIEWPORTS = [
  { name: "iPhone 13", width: 390, height: 844 },
  { name: "Pixel 7", width: 412, height: 915 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

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
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server?.close());

test("overflowing code blocks are keyboard-focusable", async () => {
  const browser = await chromium.launch();
  const problems: string[] = [];
  let overflowing = 0;
  try {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      for (const path of PATHS) {
        const res = await page.goto(base + path, { waitUntil: "networkidle" });
        assert.equal(res!.status(), 200, path + " " + vp.name);
        await page.evaluate(() => document.fonts.ready);
        const blocks = await page.evaluate(() => [...document.querySelectorAll("pre")].map((el, i) => {
          const overflow = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
          return {
            i,
            overflow,
            tabindex: el.tabIndex,
            focusable: el.tabIndex >= 0,
            preview: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
          };
        }));
        const over = blocks.filter((b) => b.overflow);
        overflowing += over.length;
        for (const b of over) {
          if (!b.focusable) problems.push(`${vp.name} ${path} pre[${b.i}] tabindex=${b.tabindex} "${b.preview}"`);
        }
        if (over.length) {
          const first = over[0].i;
          const handle = page.locator("pre").nth(first);
          await handle.focus();
          const focused = await page.evaluate(() => document.activeElement?.tagName);
          if (focused !== "PRE") problems.push(`${vp.name} ${path} pre[${first}] did not take focus (active=${focused})`);
        }
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  assert.ok(overflowing > 0, "the fixtures include at least one overflowing pre (for example the demo curl line)");
  assert.deepEqual(problems, [], problems.join("\n"));
});
