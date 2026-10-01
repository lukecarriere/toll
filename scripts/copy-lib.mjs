// Reads docs/copy.md, the single source for public strings and the copy lint list.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const COPY_PATH = ROOT + "docs/copy.md";

export function readCopy(path = COPY_PATH) {
  return readFileSync(path, "utf8");
}

/** Text of the "## <title...>" section up to the next "## " heading. */
export function section(md, titleStart) {
  const lines = md.split("\n");
  const i = lines.findIndex((l) => l.startsWith("## " + titleStart));
  if (i < 0) throw new Error(`docs/copy.md: missing section "## ${titleStart}"`);
  const out = [];
  for (let j = i + 1; j < lines.length && !lines[j].startsWith("## "); j++) out.push(lines[j]);
  return out.join("\n");
}

/** Lint list: whole-word, case-insensitive terms plus the percentage-as-identity rule. */
export function lintList(md = readCopy()) {
  const sec = section(md, "Lint list");
  const terms = [];
  let pctWords = [];
  for (const raw of sec.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/percentage next to/i.test(line)) {
      pctWords = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((w) => !/%/.test(w));
      continue;
    }
    const i = line.indexOf(":");
    if (i < 0) continue;
    for (const t of line.slice(i + 1).split(",")) {
      const term = t.trim().replace(/\.$/, "").trim().toLowerCase();
      if (term) terms.push(term);
    }
  }
  if (terms.length === 0) throw new Error("docs/copy.md: lint list is empty");
  return { terms, pctWords };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function lintRegexes(list = lintList()) {
  const res = list.terms.map((t) => ({ term: t, re: new RegExp(`(?<![A-Za-z0-9_])${esc(t).replace(/\s+/g, "\\s+")}(?![A-Za-z0-9_])`, "gi") }));
  if (list.pctWords.length) {
    const w = list.pctWords.map(esc).join("|");
    res.push({ term: "percentage as identity", re: new RegExp(`\\d+(?:\\.\\d+)?\\s*%\\s*(?:${w})(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?:${w})\\s*:?\\s*\\d+(?:\\.\\d+)?\\s*%`, "gi") });
  }
  return res;
}

export const EXEMPT = [/^docs\/settlement\.md$/, /^docs\/settlement-vectors\.json$/, /^packages\/settlement-ln\//];

export function isExempt(relPath) {
  return EXEMPT.some((re) => re.test(relPath.replace(/\\/g, "/")));
}

/** Returns [{ term, line, text }] hits for a public-surface file; [] for exempt paths. */
export function lintText(relPath, text, regexes = lintRegexes()) {
  if (isExempt(relPath)) return [];
  const hits = [];
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    for (const { term, re } of regexes) {
      re.lastIndex = 0;
      const m = re.exec(lines[n]);
      if (m) hits.push({ term, line: n + 1, text: m[0] });
    }
  }
  return hits;
}

/** README top block from the "## README" section's code fence. */
export function readmeTop(md = readCopy()) {
  const m = /```\n([\s\S]*?)\n```/.exec(section(md, "README"));
  if (!m) throw new Error("docs/copy.md: README block missing");
  return m[1];
}

export function readmeFootnote(md = readCopy()) {
  const m = /\*([^*]+Operators can withdraw\.)\*/.exec(section(md, "README"));
  return m ? m[1] : null;
}

const WIDGET_KEYS = [
  ["Working", "checking"],
  ["Done after a visible check", "verified"],
  ["Checkbox mode button", "verify"],
  ["Error action", "retry"],
  ["Error", "error"],
  ["No JavaScript", "nojs"],
];

/** Widget strings from the "## Widget strings" table. */
export function widgetStrings(md = readCopy()) {
  const out = {};
  for (const row of section(md, "Widget strings").split("\n")) {
    const cells = row.split("|").map((c) => c.trim());
    if (cells.length < 4 || cells[1] === "Use" || /^-+$/.test(cells[1])) continue;
    const hit = WIDGET_KEYS.find(([prefix]) => cells[1].startsWith(prefix));
    if (hit && !(hit[1] in out)) out[hit[1]] = cells[2];
  }
  for (const [, k] of WIDGET_KEYS) if (!out[k]) throw new Error(`docs/copy.md: widget string "${k}" missing`);
  return out;
}

/** True if `s` appears verbatim in docs/copy.md (used to keep demo strings honest). */
export function inCopy(s, md = readCopy()) {
  return md.includes(s);
}
