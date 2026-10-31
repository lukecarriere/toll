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
// website/robots.txt allows everything and names no host. A build with a site root appends one Sitemap line.
// Canonicals and social tags: each page points at itself under TOLL_SITE_URL, validated by @toll/protocol/site-url.
// The CLI (`node website/build.mjs`) uses the environment, then wrangler.toml [vars] TOLL_SITE_URL, so the
// deployed site has absolute URLs. An explicit empty site (the tests) or an invalid value: no canonical,
// no social tags, no sitemap, no llms.txt, and those pages stay byte-identical to a build without them.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
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
export const SITE_FILES = ["_headers", "robots.txt"];

/** The hosted demo page (people do the work check; agents can pay real Cashu or a BOLT11 mint quote). Not part of the four mission pages; those stay byte-identical. */
export const DEMO_FILES = ["demo.html", "demo.css", "demo.js"];

/**
 * Visitor guides. Order, nav labels and meta descriptions come from docs/copy.md "## Docs pages".
 * The homepage links to /docs. The four mission pages do not: their HTML stays the released bytes.
 */
const DOC_ORDER = ["docs/index", "docs/quick-start", "docs/widget", "docs/server", "docs/agent", "docs/mcp", "docs/wordpress", "docs/self-hosting", "download/index"];

export function loadDocMeta(copy = readFileSync(fileURLToPath(new URL("../docs/copy.md", import.meta.url)), "utf8")) {
  const from = copy.indexOf("\n## Docs pages\n");
  if (from < 0) throw new Error('website: docs/copy.md has no "## Docs pages" section');
  const next = copy.indexOf("\n## ", from + 1);
  const sec = copy.slice(from, next < 0 ? undefined : next);
  const label = /^Homepage nav label: (.+)$/m.exec(sec)?.[1];
  if (!label) throw new Error("website: docs/copy.md Docs pages section has no homepage nav label");
  const pages = [];
  for (const m of sec.matchAll(/^- `website\/([^`]+)` \(([^)]+)\): (.+)$/gm)) pages.push({ file: m[1], nav: m[2], description: m[3] });
  if (pages.map((p) => p.file).join("\n") !== DOC_ORDER.join("\n")) throw new Error("website: docs page list does not match docs/copy.md");
  return { label, pages };
}

export const DOC_META = loadDocMeta();
export const DOC_PAGES = DOC_META.pages;
/** Guides listed under the docs nav. The index is the homepage's Docs link, not a second copy of it. */
export const GUIDE_PAGES = DOC_PAGES.filter((p) => p.file !== "docs/index");

/** Toll Gate header: version and GPL licence the download page and zip name must match. */
export function pluginRelease() {
  const php = readFileSync(fileURLToPath(new URL("../packages/wp-toll-gate/toll-gate.php", import.meta.url)), "utf8");
  const version = /^\s*\*\s*Version:\s*(\S+)\s*$/m.exec(php)?.[1];
  const license = /^\s*\*\s*License:\s*(\S+)\s*$/m.exec(php)?.[1];
  if (!version) throw new Error("website: toll-gate.php has no Version header");
  if (license !== "GPL-2.0-or-later") throw new Error("website: toll-gate.php licence is not GPL-2.0-or-later");
  const zip = `toll-gate-${version}.zip`;
  return { version, license, zip, shaName: `${zip}.sha256` };
}

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

/** Root-relative path of a page: "/" for the homepage, "/mission", "/docs", "/docs/widget", "/download". No extension. */
export function pagePath(file) {
  if (file === "index") return "/";
  if (file === "demo") return "/demo";
  if (file === "docs/index") return "/docs";
  if (file === "download/index") return "/download";
  return "/" + file;
}

/** `<link rel="canonical">` for `file` under the validated site root, or "" when there is none. */
export function canonical(file, base) {
  return base ? `<link rel="canonical" href="${esc(base + pagePath(file))}">` : "";
}

/** Hero photo already shipped on the homepage. Absolute social image for every public page. */
const OG_IMAGE = "/img/forest-road-1280.jpg";

/** Canonical, Open Graph and Twitter tags for one page, or "" when `base` is null. Titles and descriptions are the page's own. */
export function socialTags(file, title, description, base) {
  if (!base) return "";
  const url = base + pagePath(file);
  const image = base + OG_IMAGE;
  return canonical(file, base) +
    `<meta property="og:title" content="${esc(title)}">` +
    `<meta property="og:description" content="${esc(description)}">` +
    `<meta property="og:url" content="${esc(url)}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:image" content="${esc(image)}">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="${esc(title)}">` +
    `<meta name="twitter:description" content="${esc(description)}">` +
    `<meta name="twitter:image" content="${esc(image)}">`;
}

/**
 * Legal and support pages. Order, nav labels and meta descriptions come from docs/copy.md
 * "## Legal page descriptions". Rendered like guides but without the guide nav.
 */
export function loadLegalMeta(copy = readFileSync(fileURLToPath(new URL("../docs/copy.md", import.meta.url)), "utf8")) {
  const from = copy.indexOf("\n## Legal page descriptions\n");
  if (from < 0) throw new Error('website: docs/copy.md has no "## Legal page descriptions" section');
  const next = copy.indexOf("\n## ", from + 1);
  const sec = copy.slice(from, next < 0 ? undefined : next);
  const pages = [];
  for (const m of sec.matchAll(/^- `website\/([^`]+)` \(([^)]+)\): (.+)$/gm)) pages.push({ file: m[1], nav: m[2], description: m[3] });
  if (pages.map((p) => p.file).join("\n") !== "privacy\nterms\nsupport") throw new Error("website: legal page list does not match docs/copy.md");
  return pages;
}

export const LEGAL_PAGES = loadLegalMeta();

/** Footer on every page: root-relative links to the legal and support pages. */
export const FOOTER = `<footer class="site-foot"><nav aria-label="Site">${LEGAL_PAGES.map((p) => `<a href="/${p.file}">${p.nav}</a>`).join("")}</nav></footer>`;

export function renderLegal(page, md, base = null) {
  const { title, blocks } = parseGuide(md);
  const nav = PAGES.map((p) => `<a href="${pagePath(p.file)}">${esc(p.nav)}</a>`).join("") + `<a href="/docs">${esc(DOC_META.label)}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Toll</title><meta name="description" content="${esc(page.description)}">${socialTags(page.file, `${title} · Toll`, page.description, base)}${ICON_TAGS}<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/docs.css"></head><body>
<header><div class="bar"><a class="mark" href="/">Toll</a><nav aria-label="Pages">${nav}</nav></div></header>
<main><h1>${esc(title)}</h1>
${guideBody(blocks)}
</main>${FOOTER}</body></html>`;
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
<title>${esc(title)} · Toll</title><meta name="description" content="${esc(page.description)}">${socialTags(page.file, `${title} · Toll`, page.description, base)}${ICON_TAGS}<link rel="stylesheet" href="/site.css"></head><body>
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

/** SoftwareApplication JSON-LD for the homepage, or "" when there is no site root. Facts already on the page: name, description, url, the hero image, and the docs link. */
export function jsonLdTag(base) {
  if (!base) return "";
  const body = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Toll",
    description: HOME.description,
    url: base + "/",
    image: base + OG_IMAGE,
    documentation: base + "/docs",
  }).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${body}</script>`;
}

/** The homepage: markup from design/concepts/d-merged.html, styles in home.css (no inline styles). */
export function renderHome(base = null) {
  const h = HOME;
  const nav = PAGES.map((p) => `<a href="${pagePath(p.file)}">${esc(p.nav)}</a>`).join("") + `<a href="/docs">${esc(DOC_META.label)}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(h.title)}</title><meta name="description" content="${esc(h.description)}">${socialTags("index", h.title, h.description, base)}${jsonLdTag(base)}
${ICON_TAGS}<link rel="preload" href="/fonts/arvo/Arvo-Bold.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/home.css"></head><body><main class="hero"><div class="left">
<header><a class="sign" href="/" aria-current="page">Toll</a><nav aria-label="Main">${nav}</nav></header>
<div class="copy"><p class="kicker">${esc(h.kicker)}</p><h1>${h.h1.map((l) => `<span>${esc(l)}</span>`).join("")}</h1><p class="line">${esc(h.line)}</p></div>
<p class="meta">${h.meta.map(([b, t]) => `<span><b>${esc(b)}</b>${esc(t)}</span>`).join("")}</p>
</div><figure class="right"><img src="/img/forest-road-1280.jpg" srcset="/img/forest-road-1280.jpg 1280w, /img/forest-road-2560.jpg 2560w" sizes="(max-width:760px) max(100vw, 69svh), 150svh" alt="${esc(h.alt)}" width="1280" height="853" fetchpriority="high"><span class="lane" aria-hidden="true"></span><p class="plate">${esc(h.plate)}</p></figure></main>${FOOTER}</body></html>`;
}

/** Inline code and root-relative links. Anything else is escaped. */
function inline(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "`") {
      const j = s.indexOf("`", i + 1);
      if (j < 0) { out += esc(s.slice(i)); break; }
      out += "<code>" + esc(s.slice(i + 1, j)) + "</code>";
      i = j + 1;
      continue;
    }
    if (s[i] === "[") {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(s.slice(i));
      if (m && safeHref(m[2])) {
        out += `<a href="${esc(m[2])}">${inline(m[1])}</a>`;
        i += m[0].length;
        continue;
      }
    }
    const next = s.slice(i + 1).search(/[`\[]/);
    const end = next < 0 ? s.length : i + 1 + next;
    out += esc(s.slice(i, end));
    i = end;
  }
  return out;
}

function safeHref(url) {
  return /^\/(?!\/)[A-Za-z0-9._~/-]*$/.test(url) && !url.includes("..") && !/\.html?(?:$|[?#])/i.test(url);
}

/** Guide markdown: one h1, h2/h3, paragraphs, "- " lists, and fenced code. */
export function parseGuide(md) {
  const lines = md.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  if (!/^# \S/.test(lines[0] ?? "")) throw new Error("website: guide must start with '# Title'");
  const title = lines[0].slice(2).trim();
  const blocks = [];
  let i = 1;
  const blank = (n) => n >= lines.length || lines[n].trim() === "";
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (line.startsWith("```")) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      if (i >= lines.length) throw new Error("website: unclosed code fence in " + title);
      i++;
      blocks.push({ code: buf.join("\n") });
      continue;
    }
    if (line.startsWith("# ")) throw new Error("website: guide has a second h1: " + title);
    const h = /^(#{2,3}) (.+)$/.exec(line);
    if (h) { blocks.push({ h: h[1].length, text: h[2].trim() }); i++; continue; }
    if (line.startsWith("- ")) {
      const items = [];
      while (i < lines.length && lines[i].startsWith("- ")) items.push(lines[i++].slice(2).trim());
      blocks.push({ list: items });
      continue;
    }
    if (/^(?:\* |\d+\. |>)/.test(line)) throw new Error("website: unsupported markdown in " + title + ": " + line);
    const buf = [];
    while (i < lines.length && !blank(i) && !lines[i].startsWith("```") && !lines[i].startsWith("#") && !lines[i].startsWith("- ")) buf.push(lines[i++].trim());
    blocks.push({ p: buf.join(" ") });
  }
  return { title, blocks };
}

function guideBody(blocks) {
  return blocks.map((b) => {
    if (b.h) return `<h${b.h}>${inline(b.text)}</h${b.h}>`;
    if (b.list) return `<ul>${b.list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`;
    if (b.code != null) return `<pre><code>${esc(b.code)}</code></pre>`;
    return `<p>${inline(b.p)}</p>`;
  }).join("\n");
}

function applyTokens(md, rel, sha) {
  const checksum = sha || "see the .sha256 file next to the zip";
  return md.replaceAll("{{VERSION}}", rel.version).replaceAll("{{SHA}}", checksum);
}

export function renderGuide(page, md, base = null, rel = pluginRelease(), sha = "") {
  const path = pagePath(page.file);
  const { title, blocks } = parseGuide(applyTokens(md, rel, sha));
  const inDocs = path === "/docs" || path.startsWith("/docs/");
  const pagesNav = PAGES.map((p) => `<a href="${pagePath(p.file)}">${esc(p.nav)}</a>`).join("") + `<a href="/docs"${inDocs ? ' aria-current="page"' : ""}>${esc(DOC_META.label)}</a>`;
  const guides = GUIDE_PAGES.map((g) => `<a href="${pagePath(g.file)}"${pagePath(g.file) === path ? ' aria-current="page"' : ""}>${esc(g.nav)}</a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Toll</title><meta name="description" content="${esc(page.description)}">${socialTags(page.file, `${title} · Toll`, page.description, base)}${ICON_TAGS}<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/docs.css"></head><body>
<header><div class="bar"><a class="mark" href="/">Toll</a><nav aria-label="Pages">${pagesNav}</nav><nav class="guides" aria-label="Guides">${guides}</nav></div></header>
<main><h1>${esc(title)}</h1>
${guideBody(blocks)}
</main>${FOOTER}</body></html>`;
}

/** sha256 of the built plugin zip, or "" when the release dir has not been built yet. */
function releaseSha(rel) {
  const file = fileURLToPath(new URL("../dist-release/" + rel.shaName, import.meta.url));
  if (!existsSync(file)) return "";
  const hex = readFileSync(file, "utf8").trim().split(/\s+/)[0] ?? "";
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error("website: dist-release/" + rel.shaName + " is not a sha256 line");
  return hex;
}

function copyPluginZip(out, rel) {
  const dir = fileURLToPath(new URL("../dist-release/", import.meta.url));
  const zip = dir + rel.zip;
  const sha = dir + rel.shaName;
  if (!existsSync(zip) || !existsSync(sha)) return false;
  mkdirSync(out + "download", { recursive: true });
  copyFileSync(zip, out + "download/" + rel.zip);
  copyFileSync(sha, out + "download/" + rel.shaName);
  return true;
}

/** Public HTML pages, in sitemap order. `download/index` is already in DOC_PAGES. */
export function discoveryFiles() {
  return ["index", ...PAGES.map((p) => p.file), ...DOC_PAGES.map((p) => p.file), ...LEGAL_PAGES.map((p) => p.file), "demo"];
}

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function sitemapXml(base) {
  const rows = discoveryFiles().map((f) => `  <url><loc>${xml(base + pagePath(f))}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows}\n</urlset>\n`;
}

/** Plain-language index. Every sentence is already on a public page; the link blurbs are those pages' meta descriptions. */
export function llmsText(base) {
  const link = (href, label, description) => `- [${label}](${base}${href}): ${description}`;
  return [
    "# Toll",
    "",
    `> ${HOME.description}`,
    "",
    "Toll is a small check for comments, forms, logins, and write APIs. Page views stay free. People post the usual way. Floods get slower and more expensive.",
    "",
    "Page views and articles stay free. Spam takes another road.",
    "",
    "A site owner should not have to choose between closing the site and cleaning up after a flood. Toll runs on your server. Toll Gate is the WordPress plugin.",
    "",
    "Pages, docs and downloads are static files. There are no analytics, no ads and no tracking scripts. We do not block crawlers.",
    "",
    "## Docs",
    "",
    ...DOC_PAGES.map((p) => link(pagePath(p.file), p.nav, p.description)),
    "",
    "## Also on this site",
    "",
    link("/", "Toll", HOME.description),
    ...PAGES.map((p) => link(pagePath(p.file), p.nav, p.description)),
    ...LEGAL_PAGES.map((p) => link(pagePath(p.file), p.nav, p.description)),
    "",
  ].join("\n");
}

/** TOLL_SITE_URL from wrangler.toml [vars], or undefined when that line is absent. */
export function readWranglerSiteUrl() {
  const toml = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");
  return /^TOLL_SITE_URL\s*=\s*"([^"]*)"\s*$/m.exec(toml)?.[1];
}

/** What `node website/build.mjs` uses: the environment when it is set, otherwise the wrangler.toml value. */
export function cliSiteRaw(env = process.env) {
  if (env[SITE_URL_ENV] !== undefined) return env[SITE_URL_ENV];
  return readWranglerSiteUrl();
}

function decorateDemo(html, base) {
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  const desc = /<meta name="description" content="([^"]*)">/.exec(html)?.[1];
  if (!title || desc == null) throw new Error("website: demo.html has no title or description");
  const tags = socialTags("demo", title, desc, base);
  const needle = `<meta name="description" content="${desc}">`;
  return html.replace(needle, needle + tags);
}

/** Add script-src for the homepage JSON-LD only. The rest of the site policy stays. Demo CSP is a different line. */
function withJsonLdCsp(headers, html) {
  const body = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!body) return headers;
  const hash = createHash("sha256").update(body).digest("base64");
  const from = "default-src 'none'; style-src 'self'";
  if (!headers.includes(from)) throw new Error("website: site CSP line not found");
  return headers.replace(from, `default-src 'none'; script-src 'sha256-${hash}'; style-src 'self'`);
}

/**
 * Build into `out`. `site` is the raw TOLL_SITE_URL value (default: the environment, then wrangler.toml).
 * It is validated by the protocol helper; an invalid value is reported through `warn` (without the value)
 * and treated as unset. The plugin zip is copied from dist-release/ when that build has been run.
 */
export function build(out = HERE + "dist/", site = cliSiteRaw(), warn = console.warn) {
  const { url: base, error } = parseSiteUrl(site);
  if (error) warn(`website: ${error}; ignored, so no page gets a canonical tag`);
  const rel = pluginRelease();
  const sha = releaseSha(rel);
  mkdirSync(out, { recursive: true });
  writeFileSync(out + "index.html", renderHome(base));
  for (const p of PAGES) writeFileSync(out + p.file + ".html", render(p, readFileSync(HERE + p.file + ".md", "utf8"), base));
  mkdirSync(out + "docs", { recursive: true });
  mkdirSync(out + "download", { recursive: true });
  for (const p of DOC_PAGES) writeFileSync(out + p.file + ".html", renderGuide(p, readFileSync(HERE + p.file + ".md", "utf8"), base, rel, sha));
  for (const p of LEGAL_PAGES) writeFileSync(out + p.file + ".html", renderLegal(p, readFileSync(HERE + p.file + ".md", "utf8"), base));
  copyFileSync(HERE + "site.css", out + "site.css");
  copyFileSync(HERE + "docs.css", out + "docs.css");
  for (const f of ICON_FILES) copyFileSync(HERE + f, out + f);
  for (const f of SITE_FILES) copyFileSync(HERE + f, out + f);
  for (const f of DEMO_FILES) {
    if (f === "demo.html" && base) writeFileSync(out + f, decorateDemo(readFileSync(HERE + f, "utf8"), base));
    else copyFileSync(HERE + f, out + f);
  }
  for (const f of HOME_ASSETS) {
    mkdirSync(out + f.slice(0, f.lastIndexOf("/") + 1), { recursive: true });
    copyFileSync(HERE + f, out + f);
  }
  if (base) {
    writeFileSync(out + "robots.txt", readFileSync(out + "robots.txt", "utf8") + `Sitemap: ${base}/sitemap.xml\n`);
    writeFileSync(out + "sitemap.xml", sitemapXml(base));
    writeFileSync(out + "llms.txt", llmsText(base));
    writeFileSync(out + "_headers", withJsonLdCsp(readFileSync(out + "_headers", "utf8"), readFileSync(out + "index.html", "utf8")));
  }
  copyPluginZip(out, rel);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log("website: built " + build());
