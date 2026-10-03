// Meta descriptions (QA NO-GO, Oct 3: four inner pages had none). Every built page has exactly one non-empty
// <meta name="description"> in its head. The four inner pages carry the PM's text from docs/copy.md
// "Inner page descriptions" word for word (parsed here from the repo's own docs/copy.md); the homepage keeps
// its "Homepage head tags" description (tests/homepage.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
// @ts-ignore plain JS build script
import { build, PAGES, HOME } from "../website/build.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = ROOT + "website/dist/";
const OUT = build(mkdtempSync(join(tmpdir(), "toll-meta-")) + "/", "");
const SET = build(mkdtempSync(join(tmpdir(), "toll-meta-set-")) + "/", "https://site.example", () => {});
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function walk(dir: string, at = dir): string[] {
  return readdirSync(at).flatMap((f) => statSync(join(at, f)).isDirectory() ? walk(dir, join(at, f)) : [relative(dir, join(at, f))]).sort();
}

/** docs/copy.md "Inner page descriptions": page file -> { text, chars } (the PM's stated character count). */
function pmDescriptions() {
  const copy = readFileSync(ROOT + "docs/copy.md", "utf8").replace(/\r\n/g, "\n");
  const from = copy.indexOf("\n## Inner page descriptions");
  assert.ok(from >= 0, 'docs/copy.md has the "Inner page descriptions" heading');
  const to = copy.indexOf("\n## ", from + 1);
  const sec = copy.slice(from, to < 0 ? undefined : to);
  const out: Record<string, { text: string; chars: number }> = {};
  for (const m of sec.matchAll(/^- [^\n]*?\(`website\/([a-z]+)`\), (\d+) characters: (.+)$/gm)) out[m[1]] = { text: m[3], chars: Number(m[2]) };
  return out;
}

/** Every <meta name="description"> in a page: where it sits and its decoded content. */
function metas(h: string) {
  const head = /<head>([\s\S]*?)<\/head>/.exec(h)![1];
  const all = [...h.matchAll(/<meta\b[^>]*\bname\s*=\s*["']?description\b[^>]*>/gi)].map((m) => m[0]);
  const inHead = [...head.matchAll(/<meta\b[^>]*\bname\s*=\s*["']?description\b[^>]*>/gi)].map((m) => m[0]);
  return { all, inHead, content: all.map((t) => { const c = /\scontent="([^"]*)"/.exec(t); return c ? decode(c[1]) : null; }) };
}

function check(dir: string, label: string) {
  const pm = pmDescriptions();
  const pages = walk(dir).filter((f) => f.endsWith(".html"));
  assert.deepEqual(pages, ["ecosystem.html", "index.html", "mission.html", "values.html", "vision.html"], label + ": the built pages");
  for (const f of pages) {
    const m = metas(readFileSync(dir + f, "utf8"));
    assert.equal(m.all.length, 1, `${label} ${f}: exactly one meta description`);
    assert.equal(m.inHead.length, 1, `${label} ${f}: it is in the head`);
    assert.ok(m.content[0] && m.content[0].trim() !== "", `${label} ${f}: not empty`);
  }
  for (const p of PAGES) {
    const h = readFileSync(dir + p.file + ".html", "utf8");
    assert.equal(metas(h).content[0], pm[p.file].text, `${label} ${p.file}: the PM's text, word for word`);
    // Nothing in these four needs escaping, so the attribute is the text exactly (apostrophes stay as typed).
    assert.ok(h.includes(`<meta name="description" content="${pm[p.file].text}">`), `${label} ${p.file}: verbatim in the attribute`);
  }
  assert.equal(metas(readFileSync(dir + "index.html", "utf8")).content[0], HOME.description, label + ": the homepage keeps its description");
}

test("docs/copy.md: four inner page descriptions, one per page, each the length the PM states", () => {
  const pm = pmDescriptions();
  assert.deepEqual(Object.keys(pm).sort(), PAGES.map((p: any) => p.file).sort());
  for (const [f, d] of Object.entries(pm)) {
    assert.equal([...d.text].length, d.chars, `${f}: ${d.chars} characters as stated`);
    assert.ok(d.chars >= 120 && d.chars <= 155, `${f}: within the PM's 120 to 155`);
    assert.doesNotMatch(d.text, /[&<>"]/, `${f}: nothing that needs escaping (the verbatim check below relies on it)`);
  }
  for (const p of PAGES) assert.equal(p.description, pm[p.file].text, p.file + ": build.mjs has the docs/copy.md text");
});

test("meta description: every built page has exactly one, none empty, the inner four are docs/copy.md word for word", () => {
  check(OUT, "fresh build");
  check(SET, "fresh build with a site root");
  assert.ok(existsSync(DIST), "website/dist/ is missing: run `npm run build` (or `npm run build:website`) first");
  check(DIST, "website/dist");
});

test("meta description: the parser catches a missing, doubled or empty tag", () => {
  const page = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`;
  assert.equal(metas(page("")).all.length, 0);
  assert.equal(metas(page('<meta name="description" content="a"><meta name="description" content="b">')).all.length, 2);
  assert.equal(metas(page('<meta name="description" content="">')).content[0], "");
  assert.equal(metas(page('<meta name="description" content="Tom &amp; &quot;Jerry&quot;">')).content[0], 'Tom & "Jerry"');
});
