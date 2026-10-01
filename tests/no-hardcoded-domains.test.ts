// No hard-coded domains: every host written in a tracked file or a commit title is either allowed by
// rule (reserved names, localhost, IP literals, example.com/.net/.org, single labels) or on the short
// list below with a reason. The working domain is recorded once, by name, in docs/copy.md "## Naming"
// (the `Domain:` field) and in the title of the commit that placed it there; those two spots are
// exempt by location, so this file never needs to contain the name. Anywhere else it fails the test.
// The scanner is scripts/host-scan.ts; the canary tests below go through the same functions as the
// repo scan. Commit titles are the copy lint's range (scripts/copy-lint.mjs commitTitles()).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFiles, scanTitles, disallowed, hostsInText, excludedPath, isBinary, allowedByRule, trackedFiles, type HostHit } from "../scripts/host-scan.ts";
// @ts-ignore plain JS helper
import { commitTitles } from "../scripts/copy-lint.mjs";
// @ts-ignore plain JS helper
import { section } from "../scripts/copy-lib.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/** Hosts that may appear anywhere, each with why. Everything else needs a rule above or fails. */
export const ALLOWED_HOSTS = new Map<string, string>([
  ["github.com", "source host: wp-cli release download in the local WordPress setup script"],
  ["api.github.com", "GitHub API, for release lookups in dev scripts (EM list)"],
  ["packagist.org", "Composer package registry for packages/server-php (EM list)"],
  ["getcomposer.org", "Composer itself, named in PHP install notes (EM list)"],
  ["gnu.org", "GPL text and licence URI (EM list)"],
  ["www.gnu.org", "GPL licence URI in the plugin header and the licence test's source URL"],
  ["fsf.org", "Free Software Foundation, named in GPL notices (EM list)"],
  ["wordpress.org", "the WordPress.org plugin listing named in docs/copy.md"],
  ["downloads.wordpress.org", "SQLite integration plugin download in the local WordPress setup script"],
  ["schema.org", "structured-data vocabulary (EM list)"],
  ["www.w3.org", "W3C specs and XML namespaces (EM list)"],
  ["json-schema.org", "JSON Schema spec, for the tool input schemas (EM list)"],
  ["datatracker.ietf.org", "IETF RFCs and drafts (EM list)"],
  ["www.rfc-editor.org", "RFC texts (EM list)"],
  ["cdn.jsdelivr.net", "docs/adapters.md: the work engine's default WASM CDN, which Toll does not use"],
  ["trycap.dev", "docs/adapters.md: the work engine vendor's site, named where vendor names are allowed"],
  ["docs.x402.org", "docs/adapters.md: x402 spec docs cited for the Bazaar extension"],
  ["registry.modelcontextprotocol.io", "docs/catalogs.md: the official MCP registry, a catalog target"],
  ["npmjs.org", "docs/catalogs.md: the npm registry, where an MCP package would be published"],
]);

/** The working domain as recorded in docs/copy.md "## Naming" (`Domain: \`...\``), and that line's number. Read at run time. */
export function recordedDomain(root: string): { host: string; line: number } | null {
  let md: string;
  try { md = readFileSync(join(root, "docs/copy.md"), "utf8"); } catch { return null; }
  let sec: string;
  try { sec = section(md, "Naming"); } catch { return null; }
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## Naming"));
  const secLines = sec.split("\n");
  for (let i = 0; i < secLines.length; i++) {
    const m = /Domain: `([^`\s]+)`/.exec(secLines[i]);
    if (m) return { host: m[1].toLowerCase(), line: start + 2 + i };
  }
  return null;
}

/** Commit whose title placed the working domain in docs/copy.md (on main; history is never rewritten). */
export const RECORDED_DOMAIN_TITLES: Record<string, string> = {
  a408b59e8eb2d726c8c4af05592aaf6a09ce8266: "2026-10-01 PM commit that recorded the working domain under Naming in docs/copy.md",
};

function exemptByLocation(h: HostHit, rec: { host: string; line: number } | null): boolean {
  if (!rec || h.host !== rec.host) return false;
  if (h.file === "docs/copy.md" && h.line === rec.line) return true;
  return h.file.startsWith("git log ") && RECORDED_DOMAIN_TITLES[h.file.slice(8)] !== undefined;
}

/** Hosts that fail the rule, for files under `root` and commit titles. */
function violations(files: string[], root: string, titles: { sha: string; s: string }[]) {
  const rec = recordedDomain(root);
  const scan = scanFiles(files, root);
  const hits = [...scan.hits, ...scanTitles(titles)];
  return { scan, hits, bad: disallowed(hits, ALLOWED_HOSTS.keys()).filter((h) => !exemptByLocation(h, rec)) };
}

// Canary hosts are built at run time so this file itself contains no host outside the rules.
const CANARY = "canary-" + "host-zz" + ".com";
const CANARY_URL_ONLY = "canary-" + "zz" + ".xyz"; // a TLD outside the bare list: caught in URL form
const CANARY_CC = "canary-" + "zz" + ".co" + ".uk";

test("canary: a non-allowlisted host in a file is caught in URL form and in bare prose", () => {
  const dir = mkdtempSync(join(tmpdir(), "toll-hosts-"));
  try {
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/notes.md"), [
      "# Notes",
      `See https://${CANARY}/path?q=1 for the details.`,
      `Our home is ${CANARY}, mail us at team@${CANARY}.`,
      `Also http://user@${CANARY_URL_ONLY}:8443/x and the UK mirror ${CANARY_CC}.`,
    ].join("\n"));
    const { bad } = violations(["docs/notes.md"], dir, []);
    const got = bad.map((h) => `${h.line} ${h.kind} ${h.host}`);
    assert.ok(got.includes(`2 url ${CANARY}`), "URL form: " + got.join(", "));
    assert.ok(got.includes(`3 bare ${CANARY}`), "bare prose: " + got.join(", "));
    assert.equal(got.filter((g) => g === `3 bare ${CANARY}`).length, 2, "both mentions on line 3, including the e-mail domain");
    assert.ok(got.includes(`4 url ${CANARY_URL_ONLY}`), "URL form with user info and port, any TLD");
    assert.ok(got.includes(`4 bare ${CANARY_CC}`), "country-code second level");
    assert.equal(got.filter((g) => g.startsWith("2 ")).length, 1, "a URL's host is counted once, not again as prose");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canary: a non-allowlisted host in a commit title is caught", () => {
  const titles = [{ sha: "f".repeat(40), s: "docs: link the site at " + CANARY }, { sha: "e".repeat(40), s: "fix: point to https://" + CANARY + "/x" }];
  const bad = disallowed(scanTitles(titles), ALLOWED_HOSTS.keys());
  assert.deepEqual(bad.map((h) => [h.file, h.kind, h.host]), [["git log " + "f".repeat(40), "bare", CANARY], ["git log " + "e".repeat(40), "url", CANARY]]);
});

test("the location exemption is narrow: only the Naming `Domain:` field and the recorded commit title", () => {
  const dir = mkdtempSync(join(tmpdir(), "toll-hosts-"));
  try {
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/copy.md"), ["# Copy", "## Naming", "Product: Toll. Domain: `" + CANARY + "` (registered); the name stays Toll.", "## Next", "Visit " + CANARY + " today."].join("\n"));
    writeFileSync(join(dir, "README.md"), "Domain: `" + CANARY + "`\n");
    assert.deepEqual(recordedDomain(dir), { host: CANARY, line: 3 });
    const sha = Object.keys(RECORDED_DOMAIN_TITLES)[0];
    const { bad } = violations(["docs/copy.md", "README.md"], dir, [{ sha, s: "copy: working domain " + CANARY }, { sha: "d".repeat(40), s: "copy: working domain " + CANARY }]);
    assert.deepEqual(bad.map((h) => `${h.file}:${h.line}`), ["docs/copy.md:5", "README.md:1", "git log " + "d".repeat(40) + ":1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tuned: file names, code and reserved names are not hosts", () => {
  const quiet = [
    "Read README.md, run build.sh or x.py, edit package.json and composer.json.",
    "const s = demo.app(); await demo.app.close(); d.net_msat += 1; foo.co_x = 1; $x.io;",
    "Use toll.example.yaml, docs/copy.md and packages/mcp/src/server.ts.",
    "http://${host}/x and https://<toll-host>/.well-known/toll.json are templates.",
    "ln402 at v1.0.0 and 10.5 percent; e.g. i.e. etc.",
  ].join("\n");
  assert.deepEqual(hostsInText(quiet), []);
  const ruled = "http://x https://localhost:8787 http://127.0.0.1:8802 http://[::1]:80 https://pay.example.com https://example.org https://a.test https://wp.test https://edge.local http://bad.invalid https://issuer.example";
  const found = hostsInText(ruled).map((h) => h.host);
  assert.equal(found.length, 10, found.join(" "));
  for (const h of found) assert.ok(allowedByRule(h), h);
  for (const h of ["example" + ".co", "not" + "example.com", "example.com.evil" + ".co"]) assert.equal(allowedByRule(h), false, h);
});

test("excluded paths: lockfiles, vendor, node_modules, licence texts, binaries", () => {
  for (const p of ["package-lock.json", "packages/server-php/composer.lock", "yarn.lock", "pnpm-lock.yaml", "packages/server-php/vendor/a/b.php", "node_modules/x/index.js", "LICENSE", "packages/wp-toll-gate/LICENSE", "LICENSES.txt"]) assert.equal(excludedPath(p), true, p);
  for (const p of ["tests/licence.test.ts", "docs/copy.md", "packages/wp-toll-gate/toll-gate.php", "scripts/build-wp-zip.mjs"]) assert.equal(excludedPath(p), false, p);
  assert.equal(isBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), true);
  assert.equal(isBinary(Buffer.from("https://" + CANARY)), false);
});

test("the repo: every host in tracked files and commit titles is allowed", (t) => {
  const files = trackedFiles(ROOT);
  const titles = commitTitles(ROOT);
  const { scan, hits, bad } = violations(files, ROOT, titles);
  assert.ok(scan.scanned > 100, `scanned ${scan.scanned} files`);
  assert.ok(titles.length > 0, "commit titles are scanned");
  // A scan that finds nothing would pass vacuously: the hosts known to be in the repo must be found.
  for (const h of ["127.0.0.1", "localhost", "www.gnu.org", "github.com"]) assert.ok(hits.some((x) => x.host === h && x.file !== "tests/no-hardcoded-domains.test.ts"), "the scan finds " + h);
  assert.ok(recordedDomain(ROOT), "docs/copy.md records the working domain under Naming");
  const counts = new Map<string, number>();
  const SELF = "tests/no-hardcoded-domains.test.ts"; // the list itself names every entry once; not counted
  for (const h of hits) if (ALLOWED_HOSTS.has(h.host) && h.file !== SELF) counts.set(h.host, (counts.get(h.host) ?? 0) + 1);
  t.diagnostic(`scanned ${scan.scanned} files (${scan.skipped.length} skipped: ${[...new Set(scan.skipped.map((s) => s.why))].join(", ")}), ${titles.length} commit titles, ${hits.length} hosts`);
  t.diagnostic("allowlist hits outside this file: " + [...ALLOWED_HOSTS.keys()].map((h) => `${h}=${counts.get(h) ?? 0}`).join(" "));
  t.diagnostic(`allowed by rule: ${hits.filter((h) => allowedByRule(h.host)).length}; exempt by location (the recorded working domain): ${hits.filter((h) => !allowedByRule(h.host) && !ALLOWED_HOSTS.has(h.host)).length - bad.length}`);
  assert.deepEqual(bad.map((h) => `${h.file}:${h.line} ${h.kind} ${h.host}`), [], "hosts outside the rules and the allowlist");
});
