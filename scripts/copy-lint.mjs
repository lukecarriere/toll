// Copy lint (spec §19.12, extended to the full §1 list by the PM). The word list is read from
// docs/copy.md ("Lint list"). Whole words, case-insensitive. Exempt: docs/settlement.md,
// docs/settlement-vectors.json, packages/settlement-ln/.
// Vendor names (Amendment 1): list in docs/adapters.md; allowed only there, in package.json files
// and in the bundled licence notices. Same surfaces, plus commit titles.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ROOT, lintRegexes, lintText, isExempt, vendorRegexes, lintVendor, lintDiscovery } from "./copy-lib.mjs";

// Commit titles that are already in history and named a vendor before the title lint caught it.
// Exempt by exact SHA only; any new commit is still linted.
export const TITLE_EXCEPTIONS = {
  d37c9827e2b18b7f20d0e2fc5e2870f24d9b91b7: "2026-09-30 policy §5 commit names the work engine in its title; fixing it would rewrite main",
  "2bd47f60e4b664ea7cfaaeaadcc113317c51fe29": "2026-10-01 commit that added 'redwood' to the lint list quotes the banned word in its title; fixing it would rewrite main",
};

// Commit titles are linted for every commit after this one (TITLE_LINT_AFTER..HEAD). fa12195 is the
// last title written under the old banned list, before the PM's docs/copy.md with the brand brief's
// banned list. It is on main, so the cutoff keeps working when a branch is rebased or squashed.
// Older titles are not re-linted because history is never rewritten. If the cutoff is not in this
// checkout's history, every title is linted.
export const TITLE_LINT_AFTER = "fa12195d6bccf634616b7c56e1da8a5305f489c1";

/** Commit titles to lint in the git checkout at `dir`, newest first, as { sha, s }. */
export function commitTitles(dir = ROOT, after = TITLE_LINT_AFTER) {
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let range = [];
  try {
    git("merge-base", "--is-ancestor", after, "HEAD");
    range = [`${after}..HEAD`];
  } catch { /* cutoff not in this history: lint every title */ }
  try {
    return git("log", "--format=%H %s", ...range).split("\n").filter(Boolean).map((l) => ({ sha: l.slice(0, 40), s: l.slice(41) }));
  } catch {
    return []; // no commits yet, or not a git checkout
  }
}

/** Lint hits for commit titles; TITLE_EXCEPTIONS are skipped by full SHA. */
export function lintTitles(subjects, regexes = lintRegexes(), vendors = vendorRegexes()) {
  const hits = [];
  for (const { sha, s } of subjects) {
    if (TITLE_EXCEPTIONS[sha]) continue;
    for (const h of [...lintText("commit-subject", s, regexes), ...lintVendor("commit-subject", s, vendors)]) hits.push({ file: "git log", ...h, text: s });
  }
  return hits;
}

// Public surfaces (docs/copy.md "Where these rules apply"). The WordPress plugin joins when it exists.
// Amendment 2: the mission pages (website/) and docs/positioning.md are linted too and must pass as written.
export const SURFACES = ["README.md", "packages/widget/src", "packages/widget/dist", "demo", "packages/server-node/src", "packages/wp-toll-gate", "toll.example.yaml", "website", "docs/positioning.md", "packages/mcp"];
const TEXT = /\.(md|ts|mjs|js|html|css|php|json|yaml|yml|txt|sh)$/;

function walk(rel, out = []) {
  const abs = ROOT + rel;
  if (!existsSync(abs)) return out;
  if (statSync(abs).isFile()) {
    if (TEXT.test(rel)) out.push(rel);
    return out;
  }
  for (const f of readdirSync(abs)) if (f !== "node_modules") walk(rel + "/" + f, out);
  return out;
}

export async function runLint() {
  const regexes = lintRegexes();
  const vendors = vendorRegexes();
  const hits = [];
  const files = SURFACES.flatMap((s) => walk(s));
  for (const f of files) {
    const text = readFileSync(ROOT + f, "utf8");
    for (const h of lintText(f, text, regexes)) hits.push({ file: f, ...h });
    for (const h of lintVendor(f, text, vendors)) hits.push({ file: f, ...h });
  }
  // Package names and descriptions are public.
  for (const f of walk("packages").filter((p) => p.endsWith("/package.json") || p.endsWith("/composer.json")).concat(["package.json", "demo/package.json"])) {
    if (isExempt(f)) continue;
    const pkg = JSON.parse(readFileSync(ROOT + f, "utf8"));
    for (const h of lintText(f + "#name+description", `${pkg.name ?? ""}\n${pkg.description ?? ""}`, regexes)) hits.push({ file: f, ...h });
  }
  // Discovery documents (Amendment 3): the manifest as served (with and without paid prices) and the
  // MCP tool list. Only `payment` objects may name the payment method.
  const { buildManifest, agentsPointer } = await import("../packages/server-node/src/manifest.ts");
  const { toolList } = await import("../packages/mcp/src/server.ts");
  const sample = { write: { amount_msat: 10000, usd: "0.0100" }, search: { amount_msat: 2000, usd: "0.0020" }, account: { amount_msat: 25000, usd: "0.0250" }, admin: { amount_msat: 100000, usd: "0.1000" } };
  const docs = {
    "toll.json (paid)": buildManifest({ api: "https://example.test/v1", docs: null, status: "test", prices: sample }),
    "toll.json (work only)": buildManifest({ api: "https://example.test/v1", docs: null, status: "stub", prices: null }),
    "agents.json": agentsPointer("https://example.test/.well-known/toll.json"),
    "mcp tools/list": { tools: toolList() },
  };
  for (const [name, doc] of Object.entries(docs)) for (const h of lintDiscovery(doc, regexes, vendors)) hits.push({ file: name, line: h.path, term: h.term, text: h.text });
  // Commit titles (spec §1), after TITLE_LINT_AFTER. Skipped outside a git checkout. History is
  // never rewritten to fix a title, so a title that slipped through is recorded in TITLE_EXCEPTIONS.
  const subjects = commitTitles();
  hits.push(...lintTitles(subjects, regexes, vendors));
  return { files: files.length, subjects: subjects.length, hits };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runLint();
  for (const h of r.hits) console.error(`copy-lint: ${h.file}:${h.line} "${h.text}" (${h.term})`);
  console.log(`copy-lint: ${r.files} files, ${r.subjects} commit titles, ${lintRegexes().length} rules from docs/copy.md, ${vendorRegexes().length} vendor names from docs/adapters.md, ${r.hits.length} hits`);
  if (r.hits.length) process.exit(1);
}
