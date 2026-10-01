// Copy lint (spec §19.12, extended to the full §1 list by the PM). The word list is read from
// docs/copy.md ("Lint list"). Whole words, case-insensitive. Exempt: docs/settlement.md,
// docs/settlement-vectors.json, packages/settlement-ln/.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ROOT, lintRegexes, lintText, isExempt } from "./copy-lib.mjs";

// Public surfaces (docs/copy.md "Where these rules apply"). The WordPress plugin joins when it exists.
export const SURFACES = ["README.md", "packages/widget/src", "packages/widget/dist", "demo", "packages/server-node/src", "packages/wp-toll-gate", "toll.example.yaml"];
const TEXT = /\.(md|ts|mjs|js|html|css|php|json|yaml|yml|txt)$/;

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

export function runLint() {
  const regexes = lintRegexes();
  const hits = [];
  const files = SURFACES.flatMap((s) => walk(s));
  for (const f of files) for (const h of lintText(f, readFileSync(ROOT + f, "utf8"), regexes)) hits.push({ file: f, ...h });
  // Package names and descriptions are public.
  for (const f of walk("packages").filter((p) => p.endsWith("/package.json") || p.endsWith("/composer.json")).concat(["package.json", "demo/package.json"])) {
    if (isExempt(f)) continue;
    const pkg = JSON.parse(readFileSync(ROOT + f, "utf8"));
    for (const h of lintText(f + "#name+description", `${pkg.name ?? ""}\n${pkg.description ?? ""}`, regexes)) hits.push({ file: f, ...h });
  }
  // Commit titles (spec §1). Skipped outside a git checkout.
  let subjects = [];
  try { subjects = execFileSync("git", ["-C", ROOT, "log", "--format=%s"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean); } catch { /* no commits yet */ }
  for (const s of subjects) for (const h of lintText("commit-subject", s, regexes)) hits.push({ file: "git log", ...h, text: s });
  return { files: files.length, subjects: subjects.length, hits };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = runLint();
  for (const h of r.hits) console.error(`copy-lint: ${h.file}:${h.line} "${h.text}" (${h.term})`);
  console.log(`copy-lint: ${r.files} files, ${r.subjects} commit titles, ${lintRegexes().length} rules from docs/copy.md, ${r.hits.length} hits`);
  if (r.hits.length) process.exit(1);
}
