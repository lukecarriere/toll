// Site icons (EM, Oct 2): favicon.ico, favicon.svg and apple-touch-icon.png from the Designer's brand set
// (design/brand/favicon/) ship at the site root, byte for byte, and every page carries exactly these tags:
//   <link rel="icon" href="/favicon.ico" sizes="32x32">
//   <link rel="icon" href="/favicon.svg" type="image/svg+xml">
//   <link rel="apple-touch-icon" href="/apple-touch-icon.png">
// icon-192/icon-512 do not ship, and there is no web manifest. The source hashes are pinned below so the
// check runs even where design/ (gitignored) is absent; where it is present the live files must match too.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
// @ts-ignore plain JS build script
import { build, PAGES, ICON_FILES, ICON_TAGS } from "../website/build.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SOURCES = ROOT + "design/brand/favicon/";
const DIST = ROOT + "website/dist/";
const OUT = build(mkdtempSync(join(tmpdir(), "toll-icons-")) + "/", "");
const FILES = ["index", ...PAGES.map((p: any) => p.file)];
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** sha256 of the Designer's files in design/brand/favicon/ (Oct 2, 2026). */
const SOURCE_SHA256: Record<string, string> = {
  "favicon.ico": "7bbba17d8e7a8aafd8a26701bd7494df64e524fcc94b3347aedbe914cf9d3c15",
  "favicon.svg": "4e0aa2fdf156bbdb75a8d29fb4b895a1a0f1aaf2cf1fe650e7bd766890e7b18c",
  "apple-touch-icon.png": "2b4ebf40ac562aa0ed92de4709948bd04557b8909ae49e43de1dae6961aed255",
};
const TAGS = [
  '<link rel="icon" href="/favicon.ico" sizes="32x32">',
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
];

function walk(dir: string, at = dir): string[] {
  return readdirSync(at).flatMap((f) => statSync(join(at, f)).isDirectory() ? walk(dir, join(at, f)) : [relative(dir, join(at, f))]).sort();
}

/** The icon checks on a dist folder (website/dist as built, or a fresh build). */
function checkIcons(dir: string) {
  for (const f of ICON_FILES) {
    assert.ok(existsSync(dir + f), `${dir}${f} is missing`);
    assert.equal(sha256(readFileSync(dir + f)), SOURCE_SHA256[f], f + " is byte-identical to the Designer's file");
  }
  for (const f of FILES) {
    const head = /<head>([\s\S]*?)<\/head>/.exec(readFileSync(dir + f + ".html", "utf8"))![1];
    for (const t of TAGS) assert.equal(head.split(t).length - 1, 1, `${f}.html: exactly one ${t}`);
    assert.deepEqual([...head.matchAll(/<link\b[^>]*rel="(?:icon|shortcut icon|apple-touch-icon[^"]*|mask-icon|manifest)"[^>]*>/gi)].map((m) => m[0]), TAGS, f + ".html: these three icon tags, in order, and no others");
  }
  // Nothing else from the brand set ships: no icon-192/512, no manifest, no other icon or mark.
  const files = walk(dir);
  assert.deepEqual(files.filter((f) => /icon|manifest|toll-mark/i.test(f)), [...ICON_FILES].sort(), "only the three icons");
  assert.deepEqual(files.filter((f) => /^icon-(192|512)|\.webmanifest$|(^|\/)manifest\.json$/i.test(f)), []);
  for (const f of FILES) assert.doesNotMatch(readFileSync(dir + f + ".html", "utf8"), /rel="manifest"|icon-192|icon-512/, f);
}

test("icons: the three files are in a fresh build and in website/dist, byte-identical, with all three tags on every page", () => {
  assert.deepEqual(ICON_FILES, ["favicon.ico", "favicon.svg", "apple-touch-icon.png"]);
  assert.equal(ICON_TAGS, TAGS.join(""));
  for (const f of ICON_FILES) assert.equal(sha256(readFileSync(ROOT + "website/" + f)), SOURCE_SHA256[f], "website/" + f + " (the source the build copies)");
  checkIcons(OUT);
  assert.ok(existsSync(DIST), "website/dist/ is missing: run `npm run build` (or `npm run build:website`) first");
  checkIcons(DIST);
});

test("icons: the pinned hashes are the Designer's files (checked whenever design/brand/favicon/ is present)", () => {
  // design/ is gitignored, so this compares live only where it exists; the pinned hashes above always apply.
  if (!existsSync(SOURCES)) return;
  for (const f of ICON_FILES) assert.equal(sha256(readFileSync(SOURCES + f)), SOURCE_SHA256[f], "design/brand/favicon/" + f);
  for (const f of ICON_FILES) assert.deepEqual(readFileSync(OUT + f), readFileSync(SOURCES + f), f);
});

let server: Server;
let base = "";
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css", ico: "image/x-icon", svg: "image/svg+xml", png: "image/png" };
before(async () => {
  // A static server on website/dist (as built): "/" is index.html, "/mission" is mission.html, files by name.
  server = createServer((req, res) => {
    let f = (req.url ?? "/").split("?")[0].replace(/^\//, "") || "index";
    if (/^[a-z]+$/.test(f)) f += ".html";
    if (!/^[a-z-]+\.[a-z]+$/.test(f) || !existsSync(DIST + f)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": TYPES[f.split(".").pop()!] ?? "application/octet-stream", "content-security-policy": "default-src 'self'; font-src 'self'" }).end(readFileSync(DIST + f));
  });
  // TOLL_TEST_PORT picks a fixed port (the team uses 8792-8799 on the shared machine); otherwise any free port.
  await new Promise<void>((r) => server.listen(Number(process.env.TOLL_TEST_PORT ?? 0), "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server?.close());

test("icons: each file returns 200 from a static server on website/dist with its type and exact bytes; every page links them", async () => {
  for (const f of ICON_FILES) {
    const r = await fetch(`${base}/${f}`);
    assert.equal(r.status, 200, f);
    assert.equal(r.headers.get("content-type"), TYPES[f.split(".").pop()!], f);
    assert.equal(sha256(Buffer.from(await r.arrayBuffer())), SOURCE_SHA256[f], f + " as served");
  }
  for (const p of ["/", ...PAGES.map((p: any) => "/" + p.file)]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    const hrefs = [...html.matchAll(/<link\b[^>]*rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png"], p);
    for (const h of hrefs) assert.equal((await fetch(base + h)).status, 200, `${p}: ${h}`);
  }
  for (const missing of ["/icon-192.png", "/icon-512.png", "/manifest.webmanifest", "/site.webmanifest", "/manifest.json"]) assert.equal((await fetch(base + missing)).status, 404, missing + " is not shipped");
});
