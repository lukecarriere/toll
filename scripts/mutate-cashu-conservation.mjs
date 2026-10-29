// Each mutant must make the Cashu conservation test fail. The source is restored afterwards.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const file = "packages/settlement-ln/src/cashu-receive.ts";
const original = readFileSync(file, "utf8");

const mutants = [
  {
    name: "replay check removed from verifyPaid",
    from: 'if (marks.some((h) => snap.spent.includes(h))) throw new TollError("replay");',
    to: 'if (false && marks.some((h) => snap.spent.includes(h))) throw new TollError("replay");',
  },
  {
    name: "PENDING counted as UNSPENT",
    from: 'else if (state === "PENDING") waiting++;',
    to: 'else if (state === "PENDING") unspent++;',
  },
  {
    name: "dropped connection treated as mint 4xx",
    from: `      // CASHU_GUARD transport-not-4xx: a dropped connection is not a mint 4xx.
      return { kind: "unknown" };`,
    to: `      // CASHU_GUARD transport-not-4xx: a dropped connection is not a mint 4xx.
      return { kind: "refused", code: 11000 };`,
  },
  {
    name: "store.begin skipped",
    from: "pending = await store.begin(prepared);",
    to: "pending = prepared;",
  },
];

function runConservation() {
  return spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-name-pattern", "conservation:", "tests/edge-cashu.test.ts"], {
    encoding: "utf8",
  });
}

let survived = 0;
try {
  for (const mutant of mutants) {
    if (!original.includes(mutant.from)) throw new Error(mutant.name + ": anchor missing");
    writeFileSync(file, original.replace(mutant.from, mutant.to));
    const result = runConservation();
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
console.log("conservation mutants: " + mutants.length + " killed");
