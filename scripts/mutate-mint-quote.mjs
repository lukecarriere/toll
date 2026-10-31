// Each mutant must make its mint-quote guard test fail. The source is restored afterwards.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const DEFAULT_FILE = "packages/settlement-ln/src/mint-quote.ts";

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
  {
    file: "packages/server-node/src/stores.ts",
    name: "claim yields between the check and the write",
    test: "eight concurrent retries",
    from: '    if (this.quotes.has(row.quote) || this.live("f:mq:" + row.quote)) return false;\n    const until = this.now() + 180;',
    to: '    if (this.quotes.has(row.quote) || this.live("f:mq:" + row.quote)) return false;\n    await new Promise((r) => setTimeout(r, 20));\n    const until = this.now() + 180;',
  },
];

function run(testName) {
  return spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-name-pattern", testName, "tests/settlement-mint-quote.test.ts"], {
    encoding: "utf8",
  });
}

let survived = 0;
const originals = new Map();
try {
  for (const mutant of mutants) {
    const file = mutant.file ?? DEFAULT_FILE;
    if (!originals.has(file)) originals.set(file, readFileSync(file, "utf8"));
    const original = originals.get(file);
    if (!original.includes(mutant.from)) throw new Error(mutant.name + ": anchor missing");
    writeFileSync(file, original.replace(mutant.from, mutant.to));
    const result = run(mutant.test);
    const text = (result.stdout || "") + (result.stderr || "");
    const failed = result.status !== 0 && /# fail [1-9]/.test(text);
    writeFileSync(file, original);
    if (failed) console.log("killed: " + mutant.name);
    else {
      survived++;
      console.error("survived: " + mutant.name);
      console.error(text.slice(-2000));
    }
  }
} finally {
  for (const [file, original] of originals) writeFileSync(file, original);
}

if (survived > 0) {
  console.error(survived + " mutant(s) survived");
  process.exit(1);
}
console.log("mint-quote mutants: " + mutants.length + " killed");
