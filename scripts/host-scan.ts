// Host scan for tests/no-hardcoded-domains.test.ts: finds every host name written into the repo's
// tracked files and commit titles, so a real domain can't land by accident. The allowlist lives in
// the test; this file only finds hosts and applies the reserved-name rules.
//   (a) http(s) URLs: the host of every http:// or https:// URL, any TLD.
//   (b) bare host names in prose: dotted names whose last label is one of a short TLD list (or a
//       two-letter country code after one of them, as in .co.uk), so file names such as
//       README.md, build.sh or x.py never match.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** TLDs looked for in bare prose. URLs are checked whatever their TLD. */
export const BARE_TLDS = ["com", "net", "org", "dev", "app", "io", "co"] as const;

export interface HostHit { file: string; line: number; host: string; kind: "url" | "bare"; text: string }

const URL_RE = /\bhttps?:\/\/([^\s/?#"'`<>()[\]{}\\,;|^]*)/gi;
// A maximal dotted token. The look-behind keeps it from starting inside a longer identifier or path
// segment; the look-ahead keeps code such as `foo.app(` or `name.co_x` out.
const BARE_RE = /(?<![\w$.\-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?![\w$\-(]|\.[a-z0-9])/gi;
const TLD_SET = new Set<string>(BARE_TLDS);

/** Host of a URL authority ("user@Host:443" -> "host"), or null when it is not a literal host (a template such as ${host}). */
export function hostOfAuthority(authority: string): string | null {
  let a = authority.slice(authority.lastIndexOf("@") + 1).toLowerCase();
  if (a.startsWith("[")) return a.includes("]") ? a.slice(0, a.indexOf("]") + 1) : null; // IPv6 literal
  a = a.replace(/:\d*$/, "").replace(/\.+$/, "");
  if (!a || !/^[a-z0-9.-]+$/.test(a) || a.startsWith(".") || a.includes("..")) return null;
  return a;
}

function bareHost(token: string): string | null {
  const labels = token.toLowerCase().split(".");
  const last = labels[labels.length - 1];
  if (TLD_SET.has(last)) return labels.join(".");
  // .co.uk, .com.au: a country code after one of the short TLDs.
  if (labels.length >= 3 && /^[a-z]{2}$/.test(last) && TLD_SET.has(labels[labels.length - 2])) return labels.join(".");
  return null;
}

/** Every host written in `text`, with its 1-based line. */
export function hostsInText(text: string): { line: number; host: string; kind: "url" | "bare"; text: string }[] {
  const out: { line: number; host: string; kind: "url" | "bare"; text: string }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/[.:]/.test(l)) continue;
    const spans: [number, number][] = [];
    for (const m of l.matchAll(URL_RE)) {
      spans.push([m.index!, m.index! + m[0].length]);
      const h = hostOfAuthority(m[1]);
      if (h) out.push({ line: i + 1, host: h, kind: "url", text: l.trim().slice(0, 200) });
    }
    for (const m of l.matchAll(BARE_RE)) {
      if (spans.some(([a, b]) => m.index! >= a && m.index! < b)) continue; // the host of a URL already counted
      const h = bareHost(m[1]);
      if (h) out.push({ line: i + 1, host: h, kind: "bare", text: l.trim().slice(0, 200) });
    }
  }
  return out;
}

/**
 * Hosts allowed by rule, with no list entry needed: reserved names (RFC 2606 / 6761 / 6762) ending in
 * .test, .example, .invalid or .local; localhost; IP literals; example.com, example.net, example.org
 * and their subdomains; single-label hosts such as http://x.
 */
export function allowedByRule(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h.includes(".")) return true; // single label: localhost, http://x, [::1] (bracketed)
  if (h.startsWith("[")) return true; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4 literal
  if (/\.(test|example|invalid|local|localhost)$/.test(h)) return true;
  if (/(^|\.)example\.(com|net|org)$/.test(h)) return true;
  return false;
}

/** True when `host` is allowed by rule or is on `allow` (exact host, or a subdomain of an entry written as "*.name"). */
export function isAllowed(host: string, allow: Iterable<string>): boolean {
  if (allowedByRule(host)) return true;
  for (const a of allow) {
    if (a.startsWith("*.") ? host === a.slice(2) || host.endsWith(a.slice(1)) : host === a) return true;
  }
  return false;
}

/** Paths never scanned: lockfiles, vendored and installed code, licence texts. */
export function excludedPath(rel: string): boolean {
  const p = rel.replace(/\\/g, "/");
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (/(^|\/)(vendor|node_modules)\//.test(p)) return true;
  if (/(^|[-.])lock(\.json|\.ya?ml)?$/i.test(base) || /\.lock$/i.test(base) || /^npm-shrinkwrap\.json$/i.test(base)) return true;
  if (/^(licen[cs]es?|copying|notice)(\.(txt|md))?$/i.test(base)) return true; // LICENSE, LICENSES.txt; not licence.test.ts
  return false;
}

/** Binary by content: a NUL byte in the first 8 KB (the same test git uses). */
export function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

export interface ScanResult { scanned: number; skipped: { file: string; why: string }[]; hits: HostHit[] }

/** Scan `files` (paths relative to `root`) and return every host found, allowed or not. */
export function scanFiles(files: string[], root: string): ScanResult {
  const r: ScanResult = { scanned: 0, skipped: [], hits: [] };
  for (const f of files) {
    if (excludedPath(f)) { r.skipped.push({ file: f, why: "excluded path" }); continue; }
    const abs = join(root, f);
    let st;
    try { st = lstatSync(abs); } catch { r.skipped.push({ file: f, why: "missing" }); continue; }
    if (!st.isFile()) { r.skipped.push({ file: f, why: st.isSymbolicLink() ? "symlink" : "not a file" }); continue; }
    const buf = readFileSync(abs);
    if (isBinary(buf)) { r.skipped.push({ file: f, why: "binary" }); continue; }
    r.scanned++;
    for (const h of hostsInText(buf.toString("utf8"))) r.hits.push({ file: f, ...h });
  }
  return r;
}

/** Hosts in commit titles, as hits on "git log <sha>". */
export function scanTitles(titles: { sha: string; s: string }[]): HostHit[] {
  return titles.flatMap(({ sha, s }) => hostsInText(s).map((h) => ({ file: "git log " + sha, ...h })));
}

/** Hits whose host is neither allowed by rule nor on `allow`. */
export function disallowed(hits: HostHit[], allow: Iterable<string>): HostHit[] {
  const list = [...allow];
  return hits.filter((h) => !isAllowed(h.host, list));
}

/** Tracked files of the git checkout at `dir`. */
export function trackedFiles(dir: string): string[] {
  return execFileSync("git", ["-C", dir, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
}
