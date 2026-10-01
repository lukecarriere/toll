// Builds the public mission pages (Amendment 2 §D/§E) from website/*.md into website/dist/.
// Markup follows the Designer's template (design/proto/website): wordmark, four-page nav with
// aria-current, no images, no scripts, no analytics, no footer, no external requests.
// Markdown subset: "# Title", blank-line paragraphs, "- " list items. Nothing else is needed.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const PAGES = [
  { file: "mission", nav: "Mission" },
  { file: "vision", nav: "Vision" },
  { file: "values", nav: "Values" },
  { file: "ecosystem", nav: "Where Toll fits", closingLine: true },
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

export function render(page, md) {
  const { title, blocks } = parse(md);
  const nav = PAGES.map((p) => `<a href="${p.file}.html"${p.file === page.file ? ' aria-current="page"' : ""}>${esc(p.nav)}</a>`).join("");
  const body = blocks.map((b, i) => {
    if (b.list) return `<ul>${b.list.map((li) => `<li>${esc(li)}</li>`).join("")}</ul>`;
    const close = page.closingLine && i === blocks.length - 1;
    return `<p${close ? ' class="close"' : ""}>${esc(b.p)}</p>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Toll</title><link rel="stylesheet" href="site.css"></head><body>
<header><div class="bar"><a class="mark" href="mission.html">Toll</a><nav aria-label="Pages">${nav}</nav></div></header>
<main><h1>${esc(title)}</h1>
${body}
</main></body></html>`;
}

export function build(out = HERE + "dist/") {
  mkdirSync(out, { recursive: true });
  for (const p of PAGES) writeFileSync(out + p.file + ".html", render(p, readFileSync(HERE + p.file + ".md", "utf8")));
  copyFileSync(HERE + "site.css", out + "site.css");
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log("website: built " + build());
