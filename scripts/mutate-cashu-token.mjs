// Each mutant must make the cashuA guard test fail. The source is restored afterwards.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const file = "packages/settlement-ln/src/cashu-receive.ts";
const original = readFileSync(file, "utf8");

const mutants = [
  {
    name: "cashuA path skips the mint allowlist",
    from: `    // CASHU_GUARD allowlist: a V3 token and a V4 token must name a mint on the offer and the allowlist before any request.
    if (!sealed.includes(mint)) throw new TollError("malformed");
    try { await guardMintUrl(mint, this.mints, this.guard); } catch (e) {`,
    to: `    // CASHU_GUARD allowlist: a V3 token and a V4 token must name a mint on the offer and the allowlist before any request.
    if (o.proof.token.startsWith("cashuA")) this.mints = [...new Set([...this.mints, mint])];
    else if (!sealed.includes(mint)) throw new TollError("malformed");
    try { await guardMintUrl(mint, this.mints, this.guard); } catch (e) {`,
  },
  {
    name: "cashuA path skips replay check",
    from: 'if (marks.some((h) => snap.spent.includes(h))) throw new TollError("replay");',
    to: 'if (!o.proof.token.startsWith("cashuA") && marks.some((h) => snap.spent.includes(h))) throw new TollError("replay");',
  },
];

function runGuard() {
  // Node 23+ uses the spec reporter on a pipe, which has no "# fail N" line. Pin TAP.
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", "--test-name-pattern", "cashuA guard:", "tests/settlement-cashu-receive.test.ts"], {
    encoding: "utf8",
    // Same cap as the conservation script: a full log must keep the fail summary.
    maxBuffer: 16 * 1024 * 1024,
  });
}

let survived = 0;
try {
  for (const mutant of mutants) {
    if (!original.includes(mutant.from)) throw new Error(mutant.name + ": anchor missing");
    writeFileSync(file, original.replace(mutant.from, mutant.to));
    const result = runGuard();
    if (result.error) throw new Error(mutant.name + ": " + result.error.message);
    const text = (result.stdout || "") + (result.stderr || "");
    const failed = result.status !== 0 && /# fail [1-9]/.test(text);
    if (failed) console.log("killed: " + mutant.name);
    else {
      survived++;
      console.error("survived: " + mutant.name);
      console.error(text.slice(-2000));
    }
  }
} finally {
  writeFileSync(file, original);
}

if (survived > 0) {
  console.error(survived + " mutant(s) survived");
  process.exit(1);
}
console.log("cashuA mutants: " + mutants.length + " killed");
