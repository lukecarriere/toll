// The overlap guard must fail when a shared input is treated as the same swap.
// The source is restored afterwards.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const file = "packages/settlement-ln/src/cashu-store.ts";
const original = readFileSync(file, "utf8");

const mutants = [
  {
    name: "a shared input returns the other swap",
    from: `  // CASHU_GUARD overlap: one stored swap per input set. A shared mark is not this swap.
  if (hit.mint === p.mint && sameInputSet(hit.marks, p.marks)) return hit;
  throw new TollError("replay");`,
    to: `  // CASHU_GUARD overlap: one stored swap per input set. A shared mark is not this swap.
  if (hit) return hit;
  throw new TollError("replay");`,
  },
];

function runGuard() {
  return spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-name-pattern", "overlap guard:", "tests/settlement-cashu-receive.test.ts"], {
    encoding: "utf8",
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
console.log("overlap mutants: " + mutants.length + " killed");
