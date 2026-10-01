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

// ---- Vendor names (Amendment 1) ----------------------------------------------------------------
// The work engine and settlement vendors, their hosted services, and forbidden captcha / risk-score
// services must never appear on a public surface. The list lives in docs/adapters.md
// ("## Vendor names (copy lint)"). Vendor names are allowed only in docs/adapters.md, package.json
// files (dependency pins) and the bundled third-party licence notices.
export const ADAPTERS_PATH = ROOT + "docs/adapters.md";
export const VENDOR_ALLOWED = [/^docs\/adapters\.md$/, /(^|\/)package(-lock)?\.json$/, /(^|\/)composer\.(json|lock)$/, /(^|\/)LICENSES\.txt$/];

export function isVendorAllowed(relPath) {
  return VENDOR_ALLOWED.some((re) => re.test(relPath.replace(/\\/g, "/")));
}

/** { exact: [...], any: [...] } from the adapters doc. "Exact case:" lines match case-sensitively. */
export function vendorList(md = readFileSync(ADAPTERS_PATH, "utf8")) {
  const sec = section(md, "Vendor names (copy lint)");
  const exact = [];
  const any = [];
  for (const raw of sec.split("\n")) {
    const line = raw.replace(/^[-*]\s*/, "").trim();
    const i = line.indexOf(":");
    if (i < 0 || line.startsWith("|") || line.startsWith(">")) continue;
    const label = line.slice(0, i).toLowerCase();
    if (!/case/.test(label)) continue;
    const terms = line.slice(i + 1).split(",").map((t) => t.trim().replace(/\.$/, "").trim()).filter(Boolean);
    (/exact case/.test(label) ? exact : any).push(...terms);
  }
  if (exact.length + any.length === 0) throw new Error("docs/adapters.md: vendor name list is empty");
  return { exact, any };
}

export function vendorRegexes(list = vendorList()) {
  const mk = (t, flags) => ({ term: t, re: new RegExp(`(?<![A-Za-z0-9_])${esc(t).replace(/\s+/g, "\\s+")}(?![A-Za-z0-9_])`, flags) });
  return [...list.exact.map((t) => mk(t, "g")), ...list.any.map((t) => mk(t, "gi"))];
}

/** Vendor-name hits for a public-surface file; [] where vendor names are allowed. */
export function lintVendor(relPath, text, regexes = vendorRegexes()) {
  if (isVendorAllowed(relPath)) return [];
  const hits = [];
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    for (const { term, re } of regexes) {
      re.lastIndex = 0;
      const m = re.exec(lines[n]);
      if (m) hits.push({ term: "vendor: " + term, line: n + 1, text: m[0] });
    }
  }
  return hits;
}

// ---- Discovery documents (Amendment 3) --------------------------------------------------------
// The manifest (/.well-known/toll.json) and the MCP tool list are for machines. Only their
// `payment` objects may name the payment method; every other string (every `description`, the
// tool names, the price displays) stays under the full lint list and the vendor list, and must not
// name a payment method either.
export const PAYMENT_METHOD_WORDS = ["ln402", "x402", "l402", "lsat", "lightning", "bolt11", "lnurl", "usdc", "bitcoin", "btc"];
const PAYMENT_RE = new RegExp(`(?<![A-Za-z0-9_])(${PAYMENT_METHOD_WORDS.join("|")})(?![A-Za-z0-9_])`, "i");

/** Hits for a discovery document: [{ path, term, text }]. Strings under a `payment` key are exempt. */
export function lintDiscovery(doc, regexes = lintRegexes(), vendors = vendorRegexes()) {
  const hits = [];
  const walk = (v, path) => {
    if (typeof v === "string") {
      for (const h of lintText("discovery", v, regexes)) hits.push({ path, term: h.term, text: v });
      for (const h of lintVendor("discovery", v, vendors)) hits.push({ path, term: h.term, text: v });
      const m = PAYMENT_RE.exec(v);
      if (m) hits.push({ path, term: "payment method outside payment: " + m[1], text: v });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (k !== "payment") walk(x, path ? `${path}.${k}` : k);
  };
  walk(doc, "");
  return hits;
}
