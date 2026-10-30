// Each mutant must make its mint-quote guard test fail. The source is restored afterwards.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const file = "packages/settlement-ln/src/mint-quote.ts";
const original = readFileSync(file, "utf8");

const mutants = [
  {
    name: "preimage guard removed",
    test: "mint-quote guard: a wrong preimage is refused",
    from: 'if (!timingSafeEqual(got, fromHex(c.payment_hash))) throw new TollError("bad_solution");',
    to: "if (false) throw new TollError(\"bad_solution\");",
  },
  {
    name: "replay guard removed",
    test: "a paid quote grants a pass, and a replay is refused",
    from: 'if (!(await o.claim({ quote: c.quote, action: c.cls, amount, mint: c.mint, proofs }))) throw new TollError("replay");',
    to: "if (false) throw new TollError(\"replay\");",
  },
  {
    name: "issued state accepted as payment",
    test: "a foreign mint of the quote does not grant a pass",
    from: 'if (state === "ISSUED") throw new TollError("bad_solution");',
    to: "if (false) throw new TollError(\"bad_solution\");",
  },
];

function run(testName) {
  return spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-name-pattern", testName, "tests/settlement-mint-quote.test.ts"], {
    encoding: "utf8",
  });
}

let survived = 0;
try {
  for (const mutant of mutants) {
    if (!original.includes(mutant.from)) throw new Error(mutant.name + ": anchor missing");
    writeFileSync(file, original.replace(mutant.from, mutant.to));
    const result = run(mutant.test);
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
console.log("mint-quote mutants: " + mutants.length + " killed");
