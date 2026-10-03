// Builds the public site into website/dist/: the homepage (index.html + home.css, merged direction D,
// design/HANDOFF-HOMEPAGE.md) and the mission pages (Amendment 2 §D/§E) from website/*.md.
// Mission page markup follows the Designer's template (design/proto/website): wordmark, four-page nav
// with aria-current, no images, no scripts, no analytics, no footer, no external requests.
// Markdown subset: "# Title", blank-line paragraphs, "- " list items. Nothing else is needed.
// Links (EM ruling, Oct 2): root-relative with no extension: "/" is the homepage, then "/mission" etc.
// Assets (EM, Oct 2) are root-relative too ("/site.css", "/home.css", "/img/...", "/fonts/..."), so a page
// served at any path ("/mission/", a nested route) still finds its stylesheet, fonts and photo.
// Icons (EM, Oct 2): favicon.ico, favicon.svg and apple-touch-icon.png from the brand set ship at the site
// root, unchanged, with the same three <link> tags on every page. No icon-192/512, no web manifest.
// Site files (QA NO-GO, Oct 3): website/_headers is the section 2 `_headers` block of the deploy plan, word for
// word; it ships at the dist root unchanged, where Workers static assets applies it to every response.
// Canonicals: each page points at itself under TOLL_SITE_URL, validated by @toll/protocol/site-url.
// Unset or invalid: no canonical tag at all, and the pages are byte-identical to a build without it.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSiteUrl, SITE_URL_ENV } from "@toll/protocol/site-url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// description: docs/copy.md "Inner page descriptions" (PM, Oct 3), word for word, as each page's meta description.
export const PAGES = [
  { file: "mission", nav: "Mission", description: "Toll is a small check for comments, forms and write APIs. Page views stay free, and a flood gets slower and more expensive. Spam takes another road." },
  { file: "vision", nav: "Vision", description: "A site owner shouldn't have to choose between closing the site and cleaning up after a flood. Toll keeps public pages open and the comment box quiet." },
  { file: "values", nav: "Values", description: "Mind the traffic, not the driver. Nothing to solve, no tracking pixels, no selling visitor data, and page views stay free. Toll doesn't block crawlers." },
  { file: "ecosystem", nav: "Where Toll fits", closingLine: true, description: "Toll looks after writes like comments and forms. It doesn't block crawlers, charge for public articles or ask the caller to say who it is." },
];

/** Icons at the site root, used by every page; copied unchanged from website/ to dist/. */
export const ICON_FILES = ["favicon.ico", "favicon.svg", "apple-touch-icon.png"];
/** The icon tags in every page's head, all root-relative. */
export const ICON_TAGS = '<link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';

/** Files at the site root that are not pages; copied unchanged from website/ to dist/. */
export const SITE_FILES = ["_headers"];

/** Files the homepage ships besides index.html, relative to website/ and to dist/. */
export const HOME_ASSETS = [
  "home.css",
  "img/forest-road-1280.jpg",
  "img/forest-road-2560.jpg",
  "fonts/arvo/Arvo-Bold.woff2",
  "fonts/arvo/LICENSE.txt",
  "fonts/public-sans/PublicSans-Latin.woff2",
  "fonts/public-sans/LICENSE.txt",
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function parse(md) {
  const blocks = md.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  const h = /^# (.+)$/.exec(blocks[0]);
  if (!h) throw new Error("website: page must start with '# Title'");
  return {
    title: h[1].trim(),
    blocks: blocks.slice(1).map((b) => {
      const lines = b.split("\n");
      if (lines.every((l) => l.startsWith("- "))) return { list: lines.map((l) => l.slice(2).trim()) };
      if (lines.some((l) => /^(#|- |\* |\d+\. |>)/.test(l))) throw new Error("website: unsupported markdown: " + b);
      return { p: lines.join(" ").trim() };
    }),
  };
}

/** Root-relative path of a page: "/" for the homepage, "/mission" etc. No extension. */
export const pagePath = (file) => (file === "index" ? "/" : "/" + file);

/** `<link rel="canonical">` for `file` under the validated site root, or "" when there is none. */
export function canonical(file, base) {
  return base ? `<link rel="canonical" href="${esc(base + pagePath(file))}">` : "";
}

export function render(page, md, base = null) {
  const { title, blocks } = parse(md);
  const nav = PAGES.map((p) => `<a href="${pagePath(p.file)}"${p.file === page.file ? ' aria-current="page"' : ""}>${esc(p.nav)}</a>`).join("");
  const body = blocks.map((b, i) => {
    if (b.list) return `<ul>${b.list.map((li) => `<li>${esc(li)}</li>`).join("")}</ul>`;
    const close = page.closingLine && i === blocks.length - 1;
    return `<p${close ? ' class="close"' : ""}>${esc(b.p)}</p>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Toll</title><meta name="description" content="${esc(page.description)}">${canonical(page.file, base)}${ICON_TAGS}<link rel="stylesheet" href="/site.css"></head><body>
<header><div class="bar"><a class="mark" href="/">Toll</a><nav aria-label="Pages">${nav}</nav></div></header>
<main><h1>${esc(title)}</h1>
${body}
</main></body></html>`;
}

// Homepage words: docs/copy.md, verbatim (brand lines, website page headings, image alt text and
// "Homepage head tags"). The <title> separator is U+00B7 MIDDLE DOT.
export const HOME = {
  title: "Toll · Less traffic. Better road.",
  description: "Stop form spam without closing the site.",
  kicker: "A toll road, for forms. The site stays open.",
  h1: ["Less traffic.", "Better road."],
  line: "The nicest drives are the ones with less traffic.",
  meta: [["Your homepage stays open.", "Your forms stay quiet."], ["People pass through.", "Floods slow down."]],
  plate: "Spam takes another road.",
  alt: "An empty two-lane road through a tall forest.",
};

/** The homepage: markup from design/concepts/d-merged.html, styles in home.css (no inline styles). */
export function renderHome(base = null) {
  const h = HOME;
  const nav = PAGES.map((p) => `<a href="${pagePath(p.file)}">${esc(p.nav)}</a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(h.title)}</title><meta name="description" content="${esc(h.description)}">${canonical("index", base)}
${ICON_TAGS}<link rel="preload" href="/fonts/arvo/Arvo-Bold.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/home.css"></head><body><main class="hero"><div class="left">
<header><a class="sign" href="/" aria-current="page">Toll</a><nav aria-label="Main">${nav}</nav></header>
<div class="copy"><p class="kicker">${esc(h.kicker)}</p><h1>${h.h1.map((l) => `<span>${esc(l)}</span>`).join("")}</h1><p class="line">${esc(h.line)}</p></div>
<p class="meta">${h.meta.map(([b, t]) => `<span><b>${esc(b)}</b>${esc(t)}</span>`).join("")}</p>
</div><figure class="right"><img src="/img/forest-road-1280.jpg" srcset="/img/forest-road-1280.jpg 1280w, /img/forest-road-2560.jpg 2560w" sizes="(max-width:760px) max(100vw, 69svh), 150svh" alt="${esc(h.alt)}" width="1280" height="853" fetchpriority="high"><span class="lane" aria-hidden="true"></span><p class="plate">${esc(h.plate)}</p></figure></main></body></html>`;
}

/**
 * Build into `out`. `site` is the raw TOLL_SITE_URL value (default: the environment); it is validated
 * by the protocol helper; an invalid value is reported through `warn` (without the value) and treated as unset.
 */
export function build(out = HERE + "dist/", site = process.env[SITE_URL_ENV], warn = console.warn) {
  const { url: base, error } = parseSiteUrl(site);
  if (error) warn(`website: ${error}; ignored, so no page gets a canonical tag`);
  mkdirSync(out, { recursive: true });
  writeFileSync(out + "index.html", renderHome(base));
  for (const p of PAGES) writeFileSync(out + p.file + ".html", render(p, readFileSync(HERE + p.file + ".md", "utf8"), base));
  copyFileSync(HERE + "site.css", out + "site.css");
  for (const f of ICON_FILES) copyFileSync(HERE + f, out + f);
  for (const f of SITE_FILES) copyFileSync(HERE + f, out + f);
  for (const f of HOME_ASSETS) {
    mkdirSync(out + f.slice(0, f.lastIndexOf("/") + 1), { recursive: true });
    copyFileSync(HERE + f, out + f);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log("website: built " + build());
