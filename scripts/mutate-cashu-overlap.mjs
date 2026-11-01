// The overlap guard must fail when a shared input is treated as the same swap.
// The source is restored afterwards.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const mutants = [
  {
    file: "packages/settlement-ln/src/cashu-store.ts",
    name: "a shared input returns the other swap",
    from: `  // CASHU_GUARD overlap: one stored swap per input set. A shared mark is not this swap.
  if (hit.mint === p.mint && sameInputSet(hit.marks, p.marks)) return hit;
  throw new TollError("replay");`,
    to: `  // CASHU_GUARD overlap: one stored swap per input set. A shared mark is not this swap.
  if (hit) return hit;
  throw new TollError("replay");`,
  },
  {
    file: "packages/settlement-ln/src/cashu-receive.ts",
    name: "the claim write drops the lease",
    from: `      // CASHU_GUARD claim-lease: leased in the same write as the claim, before any mint call.
      prepared.at = Date.now();
      prepared.owner = "own_" + randomHex(8);
      prepared.leaseExp = prepared.at + LEASE_MS;
      pending = await store.begin(prepared);`,
    to: `      // CASHU_GUARD claim-lease: leased in the same write as the claim, before any mint call.
      pending = await store.begin(prepared);`,
  },
];

function runGuard() {
  // Node 23+ uses the spec reporter on a pipe, which has no "# fail N" line. Pin TAP.
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", "--test-name-pattern", "overlap guard:", "tests/settlement-cashu-receive.test.ts"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

let survived = 0;
const originals = new Map(mutants.map((m) => [m.file, readFileSync(m.file, "utf8")]));
try {
  for (const mutant of mutants) {
    const source = originals.get(mutant.file);
    if (!source || !source.includes(mutant.from)) throw new Error(mutant.name + ": anchor missing");
    writeFileSync(mutant.file, source.replace(mutant.from, mutant.to));
    const result = runGuard();
    writeFileSync(mutant.file, source);
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
  for (const [file, source] of originals) writeFileSync(file, source);
}

if (survived > 0) {
  console.error(survived + " mutant(s) survived");
  process.exit(1);
}
console.log("overlap mutants: " + mutants.length + " killed");
