// WCAG 2.2 SC 2.5.8: header nav, footer, docs subnav, and standalone in-body
// links must be at least 24×24 CSS pixels (issue #61).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { chromium } from "playwright";
// @ts-ignore plain JS build script
import { build, pagePath, pluginRelease } from "../website/build.mjs";

const OUT = build(mkdtempSync(join(tmpdir(), "toll-tap-")) + "/", "");
const rel = pluginRelease();
const PATHS = ["/", "/docs", "/download"] as const;
const VIEWPORTS = [
  { name: "iPhone 13", width: 390, height: 844 },
  { name: "Pixel 7", width: 412, height: 915 },
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

test("header, footer, docs subnav, and standalone in-body links are at least 24×24 CSS pixels", async () => {
  const zipText = `toll-gate-${rel.version}.zip`;
  const browser = await chromium.launch();
  const problems: string[] = [];
  try {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      for (const path of PATHS) {
        const res = await page.goto(base + path, { waitUntil: "networkidle" });
        assert.equal(res!.status(), 200, path + " " + vp.name);
        await page.evaluate(() => document.fonts.ready);
        const targets = await page.evaluate(() => {
          const seen = new Set<Element>();
          const add = (sel: string) => document.querySelectorAll(sel).forEach((el) => seen.add(el));
          add("header nav a");
          add(".site-foot a, footer a");
          add("nav.guides a");
          add("main li a");
          return [...seen].map((el) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            return { text: (el.textContent ?? "").trim().replace(/\s+/g, " "), href: (el as HTMLAnchorElement).href, w: r.width, h: r.height };
          });
        });
        assert.ok(targets.length > 0, path + " " + vp.name + ": found links to measure");
        if (path === "/") {
          assert.ok(targets.some((t) => t.text === "Mission"), "home header includes Mission");
          assert.ok(targets.some((t) => t.text === "Docs"), "home header includes Docs");
          assert.ok(targets.some((t) => t.text === "Privacy"), "home footer includes Privacy");
        }
        if (path === "/docs") {
          assert.ok(targets.some((t) => t.text === "Quick start"), "docs subnav includes Quick start");
        }
        if (path === "/download") {
          assert.ok(targets.some((t) => t.text === zipText), "download zip link");
        }
        for (const t of targets) {
          if (t.w + 0.01 < 24 || t.h + 0.01 < 24) {
            problems.push(`${vp.name} ${path} "${t.text}" ${Math.round(t.w)}×${Math.round(t.h)}`);
          }
        }
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});
