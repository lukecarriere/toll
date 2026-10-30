// Public-site discovery: canonical and social tags, sitemap, robots Sitemap line, llms.txt,
// homepage JSON-LD, and the www -> apex redirect. An explicit empty site root stays free of absolute URLs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { wwwRedirect, workerHandles } from "../packages/edge-cf/src/host-redirect.ts";
// @ts-ignore plain JS build script
import { build, cliSiteRaw, discoveryFiles, pagePath, HOME, PAGES, DOC_PAGES, LEGAL_PAGES } from "../website/build.mjs";

const SITE = "https://site.example";
const ROOT = new URL("..", import.meta.url).pathname;
const tmp = () => mkdtempSync(join(tmpdir(), "toll-seo-")) + "/";
const htmlPath = (file: string) => (file === "index" ? "index.html" : file === "demo" ? "demo.html" : file + ".html");
const titleOf = (h: string) => /<title>([^<]*)<\/title>/.exec(h)![1];
const descOf = (h: string) => /<meta name="description" content="([^"]*)">/.exec(h)![1];

function walkMd(dir: string, at = dir): string[] {
  return readdirSync(at).flatMap((f) => {
    const p = join(at, f);
    if (f === "dist") return [];
    return statSync(p).isDirectory() ? walkMd(dir, p) : p.endsWith(".md") ? [p] : [];
  });
}

test("every public page: self canonical, Open Graph and Twitter tags from that page's title and description", () => {
  const dir = build(tmp(), SITE, () => {});
  const image = SITE + "/img/forest-road-1280.jpg";
  assert.ok(existsSync(dir + "img/forest-road-1280.jpg"), "the social image is the shipped hero");
  for (const file of discoveryFiles()) {
    const html = readFileSync(dir + htmlPath(file), "utf8");
    const url = SITE + pagePath(file);
    const title = titleOf(html);
    const description = descOf(html);
    assert.equal([...html.matchAll(/rel="canonical"/g)].length, 1, file);
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`), file);
    assert.ok(html.includes(`<meta property="og:title" content="${title}">`), file);
    assert.ok(html.includes(`<meta property="og:description" content="${description}">`), file);
    assert.ok(html.includes(`<meta property="og:url" content="${url}">`), file);
    assert.ok(html.includes(`<meta property="og:type" content="website">`), file);
    assert.ok(html.includes(`<meta property="og:image" content="${image}">`), file);
    assert.ok(html.includes(`<meta name="twitter:card" content="summary_large_image">`), file);
    assert.ok(html.includes(`<meta name="twitter:title" content="${title}">`), file);
    assert.ok(html.includes(`<meta name="twitter:description" content="${description}">`), file);
    assert.ok(html.includes(`<meta name="twitter:image" content="${image}">`), file);
    assert.equal([...html.matchAll(/<script type="application\/ld\+json"/g)].length, file === "index" ? 1 : 0, file);
  }
});

test("empty site root: no canonical, no social tags, no JSON-LD, no sitemap, no llms.txt", () => {
  const dir = build(tmp(), "");
  assert.equal(existsSync(dir + "sitemap.xml"), false);
  assert.equal(existsSync(dir + "llms.txt"), false);
  assert.equal(readFileSync(dir + "robots.txt", "utf8"), readFileSync(ROOT + "website/robots.txt", "utf8"));
  for (const file of discoveryFiles()) {
    const html = readFileSync(dir + htmlPath(file), "utf8");
    assert.doesNotMatch(html, /rel="canonical"|property="og:|name="twitter:|application\/ld\+json/, file);
  }
});

test("sitemap lists the public pages and no API routes; llms.txt uses only sentences already on the site", () => {
  const dir = build(tmp(), SITE, () => {});
  const sm = readFileSync(dir + "sitemap.xml", "utf8");
  const locs = [...sm.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, discoveryFiles().map((f: string) => SITE + pagePath(f)));
  assert.ok(!locs.some((u: string) => u.includes(".html") || u.includes("/v1/") || u.includes("toll.json")));
  const llms = readFileSync(dir + "llms.txt", "utf8");
  assert.match(llms, /^# Toll\n/);
  assert.doesNotMatch(llms, /\b(cashu|ecash|sats|bitcoin|lightning)\b/i);
  const corpus = walkMd(ROOT + "website").map((p) => readFileSync(p, "utf8")).join("\n");
  const prose = llms.split("\n## ")[0].replace(/^>\s*/gm, "").replace(/^#.*$/gm, "");
  const sentences = prose.split(/(?<=\.)\s+/).map((s) => s.trim()).filter((s) => s.endsWith("."));
  assert.ok(sentences.length >= 8, sentences.join(" | "));
  for (const s of sentences) assert.ok(s === HOME.description || corpus.includes(s), "not on the site: " + s);
  for (const p of [...DOC_PAGES, ...PAGES, ...LEGAL_PAGES]) {
    assert.ok(llms.includes(`](${SITE}${pagePath(p.file)}): ${p.description}`), p.file);
  }
  assert.ok(llms.includes(`](${SITE}/): ${HOME.description}`));
});

test("homepage JSON-LD is SoftwareApplication and the site CSP allows that script by hash", async () => {
  const dir = build(tmp(), SITE, () => {});
  const home = readFileSync(dir + "index.html", "utf8");
  const body = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(home)![1];
  const data = JSON.parse(body);
  assert.equal(data["@context"], "https://schema.org");
  assert.equal(data["@type"], "SoftwareApplication");
  assert.equal(data.name, "Toll");
  assert.equal(data.description, HOME.description);
  assert.equal(data.url, SITE + "/");
  assert.equal(data.image, SITE + "/img/forest-road-1280.jpg");
  assert.equal(data.documentation, SITE + "/docs");
  assert.equal("offers" in data, false);
  assert.equal("aggregateRating" in data, false);
  assert.doesNotMatch(body, /price|rating|cashu|ecash|sats|bitcoin/i);
  const hash = createHash("sha256").update(body).digest("base64");
  const headers = readFileSync(dir + "_headers", "utf8");
  const csp = headers.split("\n").find((l) => l.includes("default-src 'none'"))!.replace(/^\s*Content-Security-Policy:\s*/, "");
  assert.ok(csp.includes(`script-src 'sha256-${hash}'`), csp);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
  for (const d of ["default-src 'none'", "style-src 'self'", "img-src 'self'", "font-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(d), d);

  const types: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css", jpg: "image/jpeg", woff2: "font/woff2", png: "image/png", svg: "image/svg+xml", ico: "image/x-icon" };
  const server: Server = createServer((req, res) => {
    let p = (req.url ?? "/").split("?")[0];
    if (p.endsWith("/")) p = p.slice(0, -1);
    if (p === "") p = "/index.html";
    else if (!p.includes(".")) p += ".html";
    const rel = p.replace(/^\//, "");
    if (rel.includes("..") || !existsSync(dir + rel)) { res.writeHead(404).end(); return; }
    const ext = rel.split(".").pop()!;
    res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream", "content-security-policy": csp }).end(readFileSync(dir + rel));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const problems: string[] = [];
    await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error("CSP " + e.violatedDirective + " " + e.blockedURI)));
    page.on("console", (m) => { if (/^CSP /.test(m.text())) problems.push(m.text()); });
    assert.equal((await page.goto(base + "/", { waitUntil: "networkidle" }))!.status(), 200);
    assert.deepEqual(problems, [], problems.join("\n"));
    const raw = await page.locator('script[type="application/ld+json"]').textContent();
    assert.equal(JSON.parse(raw!)["@type"], "SoftwareApplication");
    assert.equal(await page.evaluate(() => document.scripts.length), 1);
    problems.length = 0;
    assert.equal((await page.goto(base + "/values", { waitUntil: "networkidle" }))!.status(), 200);
    assert.deepEqual(problems, []);
    assert.equal(await page.evaluate(() => document.scripts.length), 0);
    assert.match(await page.locator("h1").innerText(), /Values/);
  } finally {
    await browser.close();
    server.close();
  }
});

test("www redirects to the apex with 308; other hosts and static paths do not", async () => {
  const req = (url: string, method = "GET") => wwwRedirect(new Request(url, { method }), SITE);
  const docs = req("https://www.site.example/docs?q=1");
  assert.equal(docs!.status, 308);
  assert.equal(docs!.headers.get("location"), "https://site.example/docs?q=1");
  assert.equal(await docs!.text(), "");
  const post = req("https://www.site.example/v1/health", "POST");
  assert.equal(post!.status, 308);
  assert.equal(post!.headers.get("location"), "https://site.example/v1/health");
  assert.equal(await post!.text(), "");
  assert.equal(req("https://site.example/docs"), null);
  assert.equal(req("https://www.other.example/docs"), null);
  assert.equal(wwwRedirect(new Request("https://www.site.example/"), "http://site.example"), null);
  assert.equal(wwwRedirect(new Request("https://www.site.example/"), undefined), null);
  const spoof = new Request("https://site.example/mission", { headers: { host: "www.site.example" } });
  assert.equal(wwwRedirect(spoof, SITE), null);
  const apex = cliSiteRaw();
  assert.equal(typeof apex, "string");
  const live = wwwRedirect(new Request("https://www." + new URL(apex!).host + "/mission"), apex);
  assert.equal(live!.status, 308);
  assert.equal(live!.headers.get("location"), "https://" + new URL(apex!).host + "/mission");
  assert.equal(await live!.text(), "");
  assert.equal(workerHandles("/v1/health"), true);
  assert.equal(workerHandles("/demo/contact"), true);
  assert.equal(workerHandles("/.well-known/toll.json"), true);
  assert.equal(workerHandles("/demo"), false);
  assert.equal(workerHandles("/mission"), false);
  assert.equal(workerHandles("/sitemap.xml"), false);
  const src = readFileSync(ROOT + "packages/edge-cf/src/site.ts", "utf8");
  const body = src.slice(src.indexOf("async fetch"));
  assert.ok(body.indexOf("wwwRedirect(req, env.TOLL_SITE_URL)") < body.indexOf("workerHandles(url.pathname)"));
  assert.ok(body.indexOf("workerHandles(url.pathname)") < body.indexOf("storeFailSlot.run"));
});
