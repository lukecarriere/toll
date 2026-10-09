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
import { BARE_TLDS, scanFiles, scanTitles, disallowed, hostsInText, excludedPath, isBinary, allowedByRule, trackedFiles, type HostHit } from "../scripts/host-scan.ts";
// @ts-ignore plain JS helper
import { commitTitles } from "../scripts/copy-lint.mjs";

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
  ["registry.npmjs.org", "npm registry URL for the manual publish workflow"],
]);

/** A dotted host name (letters, digits, '-'; last label starts with a letter). Anything else in the field exempts nothing. */
const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * The working domain as recorded in the text of docs/copy.md, "## Naming" section, `Domain: \`...\``
 * field, and that line's 1-based number. Null when there is no Naming section, no field, an empty
 * field, or a value that is not a host name. Never throws.
 */
export function recordedDomainIn(md: string): { host: string; line: number } | null {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## Naming"));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length && !lines[i].startsWith("## "); i++) {
    const m = /Domain: `([^`]*)`/.exec(lines[i]);
    if (!m) continue;
    const host = m[1].trim().toLowerCase();
    return HOST_NAME.test(host) ? { host, line: i + 1 } : null;
  }
  return null;
}

/** recordedDomainIn() for `<root>/docs/copy.md`; null when the file can't be read. Read at run time. */
export function recordedDomain(root: string): { host: string; line: number } | null {
  let md: string;
  try { md = readFileSync(join(root, "docs/copy.md"), "utf8"); } catch { return null; }
  return recordedDomainIn(md);
}

/** Commit whose title placed the working domain in docs/copy.md (on main; history is never rewritten). */
export const RECORDED_DOMAIN_TITLES: Record<string, string> = {
  a408b59e8eb2d726c8c4af05592aaf6a09ce8266: "2026-10-01 PM commit that recorded the working domain under Naming in docs/copy.md",
};

/**
 * The location exemptions as "<file>:<line> <host>" keys: the Naming `Domain:` line of docs/copy.md and
 * the title of each RECORDED_DOMAIN_TITLES commit, for the recorded host only. Empty when nothing valid is recorded.
 */
export function exemptionSet(rec: { host: string; line: number } | null): Set<string> {
  if (!rec) return new Set();
  return new Set([`docs/copy.md:${rec.line} ${rec.host}`, ...Object.keys(RECORDED_DOMAIN_TITLES).map((sha) => `git log ${sha}:1 ${rec.host}`)]);
}

/** Hosts that fail the rule, for files under `root` and commit titles. */
function violations(files: string[], root: string, titles: { sha: string; s: string }[]) {
  const exempt = exemptionSet(recordedDomain(root));
  const scan = scanFiles(files, root);
  const hits = [...scan.hits, ...scanTitles(titles)];
  return { scan, hits, exempt, bad: disallowed(hits, ALLOWED_HOSTS.keys()).filter((h: HostHit) => !exempt.has(`${h.file}:${h.line} ${h.host}`)) };
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

test("canary: a bare .ai host in prose is caught; https://localhost is still allowed", () => {
  const ai = "foo" + ".ai";
  const prose = hostsInText(`Ask the ${ai} team, or mail hello@${ai}.`);
  assert.deepEqual(prose.map((h) => [h.kind, h.host]), [["bare", ai], ["bare", ai]]);
  assert.deepEqual(disallowed(prose.map((h) => ({ ...h, file: "docs/notes.md" })), ALLOWED_HOSTS.keys()).length, 2, "and not allowlisted");
  assert.ok((BARE_TLDS as readonly string[]).includes("ai"), "ai is in the bare-prose TLD list");
  assert.deepEqual(hostsInText("Use plain.ai.txt or main.aix, not a host.").map((h) => h.host), [], "file names and longer suffixes are not hosts");
  const local = hostsInText("Serve it at https://localhost and https://localhost:8443/docs.");
  assert.deepEqual(local.map((h) => h.host), ["localhost", "localhost"]);
  for (const h of local) assert.ok(allowedByRule(h.host), h.host);
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

test("a missing, empty or garbage `Domain:` field exempts nothing: the scan still runs and flags the canary", () => {
  const cases: [string, string][] = [
    ["no Domain field", "Product: Toll. The name stays Toll, see " + CANARY + "."],
    ["empty Domain field", "Product: Toll. Domain: `` (registered) " + CANARY + "; the name stays Toll."],
    ["blank Domain field", "Product: Toll. Domain: `   ` " + CANARY + "."],
    ["garbage Domain field", "Product: Toll. Domain: `%% not a host !!` " + CANARY + "."],
    ["IP in Domain field", "Product: Toll. Domain: `127.0.0.1` " + CANARY + "."],
    ["URL in Domain field", "Product: Toll. Domain: `https://" + CANARY + "/` " + CANARY + "."],
  ];
  for (const [name, line] of cases) {
    const md = ["# Copy", "## Naming", line, "## Next", "Visit " + CANARY + " today."].join("\n");
    assert.equal(recordedDomainIn(md), null, name + ": nothing recorded");
    assert.equal(exemptionSet(recordedDomainIn(md)).size, 0, name + ": exemption set is empty");
    const dir = mkdtempSync(join(tmpdir(), "toll-hosts-"));
    try {
      mkdirSync(join(dir, "docs"));
      writeFileSync(join(dir, "docs/copy.md"), md);
      const sha = Object.keys(RECORDED_DOMAIN_TITLES)[0];
      let r: ReturnType<typeof violations> | undefined;
      assert.doesNotThrow(() => { r = violations(["docs/copy.md"], dir, [{ sha, s: "copy: working domain " + CANARY }]); }, name);
      assert.equal(r!.exempt.size, 0, name);
      assert.ok(r!.scan.scanned === 1, name + ": the file was scanned");
      const got = r!.bad.map((h) => `${h.file}:${h.line} ${h.host}`);
      assert.ok(got.includes(`docs/copy.md:3 ${CANARY}`), name + ": canary on the Domain line is flagged: " + got.join(", "));
      assert.ok(got.includes(`docs/copy.md:5 ${CANARY}`), name + ": canary elsewhere is flagged");
      assert.ok(got.includes(`git log ${sha}:1 ${CANARY}`), name + ": even the recorded commit's title is flagged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // No Naming section, and no copy.md at all: nothing recorded, no exception.
  assert.equal(recordedDomainIn("# Copy\nDomain: `" + CANARY + "`\n"), null, "a Domain field outside Naming does not count");
  assert.equal(recordedDomainIn(""), null);
  const empty = mkdtempSync(join(tmpdir(), "toll-hosts-"));
  try {
    writeFileSync(join(empty, "notes.md"), "https://" + CANARY + "/\n");
    assert.equal(recordedDomain(empty), null);
    const r = violations(["notes.md"], empty, []);
    assert.equal(r.exempt.size, 0);
    assert.deepEqual(r.bad.map((h) => `${h.file}:${h.line} ${h.host}`), [`notes.md:1 ${CANARY}`]);
  } finally {
    rmSync(empty, { recursive: true, force: true });
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
  assert.equal(violations([], ROOT, []).exempt.size, 1 + Object.keys(RECORDED_DOMAIN_TITLES).length, "one copy.md line and the recorded commit title");
  const counts = new Map<string, number>();
  const SELF = "tests/no-hardcoded-domains.test.ts"; // the list itself names every entry once; not counted
  for (const h of hits) if (ALLOWED_HOSTS.has(h.host) && h.file !== SELF) counts.set(h.host, (counts.get(h.host) ?? 0) + 1);
  t.diagnostic(`scanned ${scan.scanned} files (${scan.skipped.length} skipped: ${[...new Set(scan.skipped.map((s) => s.why))].join(", ")}), ${titles.length} commit titles, ${hits.length} hosts`);
  t.diagnostic("allowlist hits outside this file: " + [...ALLOWED_HOSTS.keys()].map((h) => `${h}=${counts.get(h) ?? 0}`).join(" "));
  t.diagnostic(`allowed by rule: ${hits.filter((h) => allowedByRule(h.host)).length}; exempt by location (the recorded working domain): ${hits.filter((h) => !allowedByRule(h.host) && !ALLOWED_HOSTS.has(h.host)).length - bad.length}`);
  assert.deepEqual(bad.map((h) => `${h.file}:${h.line} ${h.kind} ${h.host}`), [], "hosts outside the rules and the allowlist");
});
