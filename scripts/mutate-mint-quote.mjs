// Each mutant must make its mint-quote guard test fail. The sources are restored afterwards.
// The TAP reporter is named explicitly: from Node 23 the default reporter for piped output is spec,
// which has no "# fail N" line. A mutant counts as killed only when the run exits non-zero and TAP
// reports at least one failing test; a crash or a pattern that matches no test is not a kill.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MQ = "packages/settlement-ln/src/mint-quote.ts";
const MS = "packages/server-node/src/stores.ts";
const DO = "packages/edge-cf/src/do-store.ts";
const TEST_FILES = ["tests/settlement-mint-quote.test.ts", "tests/l402-quote.test.ts", "tests/l402-edge.test.ts", "tests/l402-expiry.test.ts"];
const TIMEOUT_MS = 300_000;

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
    from: 'if (!(await o.reserve({ quote: c.quote, action: c.cls, amount, mint: c.mint, outputs }))) throw new TollError("replay");',
    to: "if (false) throw new TollError(\"replay\");",
  },
  {
    name: "issued state accepted as payment",
    test: "a foreign mint of the quote does not grant a pass",
    from: '// MINT_QUOTE_GUARD issued: mint state ISSUED is not payment when this store has no row.\n    throw new TollError("bad_solution");',
    to: "// mutant: falls through",
  },
  {
    file: MS,
    name: "claim yields between the check and the write",
    test: "eight concurrent retries of one paid quote",
    from: '    if (this.quotes.has(row.quote) || this.live("f:mq:" + row.quote)) return false;\n    const until = this.now() + 30;',
    to: '    if (this.quotes.has(row.quote) || this.live("f:mq:" + row.quote)) return false;\n    await new Promise((r) => setTimeout(r, 20));\n    const until = this.now() + 30;',
  },
  {
    name: "a refusal never releases the reservation",
    test: "a mint 500 releases the quote and the retry passes once",
    from: 'if (settled === "unsigned") return "released";',
    to: 'if (settled === "unsigned") return "kept";',
  },
  {
    name: "an unrecoverable signature is not booked as a loss",
    test: "an issued quote whose signatures cannot be fetched records one loss",
    from: '      await o.noteLoss({ quote: c.quote, action: c.cls, amount });\n      await o.unlock(c.quote);\n      throw new TollError("store_unavailable", MINT_SIGNED_UNRECOVERABLE);',
    to: '      await o.unlock(c.quote);\n      throw new TollError("store_unavailable", MINT_SIGNED_UNRECOVERABLE);',
  },
  {
    name: "the reservation does not keep the blinded outputs",
    test: "a dropped mint response is recovered by the retry, once",
    from: "reserve({ quote: c.quote, action: c.cls, amount, mint: c.mint, outputs })",
    to: "reserve({ quote: c.quote, action: c.cls, amount, mint: c.mint, outputs: [] })",
  },
  {
    name: "an issued quote with an empty restore is treated as unsigned",
    test: "an issued quote whose signatures cannot be fetched records one loss",
    from: 'if (restored.kind === "none") return "unrecoverable";',
    to: 'if (restored.kind === "none") return "unsigned";',
  },
  {
    file: MS,
    name: "memory claimOpen ignores the live lease",
    test: "concurrent retries during a failing first mint yield one pass",
    from: 'if (!held || held.proofs.length > 0 || this.live("f:mq:" + quote)) return null;',
    to: "if (!held || held.proofs.length > 0) return null;",
  },
  {
    file: MS,
    name: "memory release keeps the row",
    test: "a mint 500 releases the quote and the retry passes once",
    from: '    this.quotes.delete(quote);\n    this.m.delete("f:mq:" + quote);\n    return true;',
    to: '    this.m.delete("f:mq:" + quote);\n    return true;',
  },
  {
    file: DO,
    name: "DO loss record loses its dedup",
    test: "a late signature the worker cannot restore records the loss once",
    from: '    if (this.sql.exec("SELECT quote FROM cashu_mint_loss WHERE quote = ?", o.quote).toArray().length) return;\n',
    to: "",
  },
  {
    name: "a timed-out post may release the reservation",
    test: "both mint posts time out and the mint signs late",
    from: 'if (!outcomes.every((x) => x === "refused")) return null;',
    to: "",
  },
  {
    name: "an open issued quote is posted again before restore",
    test: "a dropped mint response is recovered by the retry, once",
    from: '  if (state === "ISSUED") {\n    if (bolt11) {',
    to: '  if (false) {\n    if (bolt11) {',
  },
  {
    name: "an issued quote with no row is not booked as a loss",
    test: "a foreign mint of the quote does not grant a pass",
    from: "    // MINT_QUOTE_GUARD issued-loss: a paid quote this store holds no row for is booked as a loss, once.\n    await o.noteLoss({ quote: c.quote, action: c.cls, amount });\n",
    to: "",
  },
  {
    name: "a mint refusal is treated as ambiguous",
    test: "a mint refusal with an empty restore releases the reservation",
    from: 'return typeof body.detail === "string" || typeof body.code === "number" ? "refused" : "unknown";',
    to: 'return "unknown";',
  },
  {
    name: "an expired macaroon is granted a pass after recovery",
    test: "an expired macaroon on a kept reservation books the late signature as stored",
    from: 'if (expired) throw new TollError("expired");\n    return paid();',
    to: "return paid();",
  },
  {
    name: "an expired macaroon skips its open reservation",
    test: "an expired macaroon on a kept reservation books the late signature as stored",
    from: "  const ctx: MintCtx = {",
    to: '  if (expired) throw new TollError("expired");\n  const ctx: MintCtx = {',
  },
  {
    name: "an expired unrecoverable reservation is not booked as a loss",
    test: "an expired macaroon on a kept reservation the mint cannot restore books one loss",
    from: '      await o.noteLoss({ quote: c.quote, action: c.cls, amount });\n      await o.unlock(c.quote);\n      throw new TollError("store_unavailable", MINT_SIGNED_UNRECOVERABLE);',
    to: '      await o.unlock(c.quote);\n      throw new TollError("store_unavailable", MINT_SIGNED_UNRECOVERABLE);',
  },
];

/** TAP summary counts, or null when the run printed no TAP summary (a crash, not a test result). */
export function tapCounts(text) {
  const tests = /^# tests (\d+)$/m.exec(text);
  const fail = /^# fail (\d+)$/m.exec(text);
  if (!tests || !fail) return null;
  return { tests: Number(tests[1]), fail: Number(fail[1]) };
}

/** Killed: non-zero exit and TAP shows a failing test. A non-zero exit without TAP failures is a crash, not a kill. */
export function killed(status, text) {
  const counts = tapCounts(text);
  return status !== 0 && counts !== null && counts.fail > 0;
}

// Only files that hold the named test: a file where the pattern matches nothing skips its
// before hook, and its after hook then fails on the missing server instead of testing the mutant.
function run(mutant) {
  const files = TEST_FILES.filter((f) => readFileSync(f, "utf8").includes(JSON.stringify(mutant.test).slice(0, -1)));
  if (files.length === 0) throw new Error(mutant.name + ": no test named " + mutant.test);
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", "--test-name-pattern", mutant.test, ...files], {
    encoding: "utf8", timeout: TIMEOUT_MS,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let survived = 0;
  const originals = new Map();
  try {
    for (const mutant of mutants) {
      const file = mutant.file ?? MQ;
      if (!originals.has(file)) originals.set(file, readFileSync(file, "utf8"));
      const original = originals.get(file);
      if (!original.includes(mutant.from)) throw new Error(mutant.name + ": anchor missing");
      writeFileSync(file, original.replace(mutant.from, mutant.to));
      const result = run(mutant);
      writeFileSync(file, original);
      const text = (result.stdout || "") + (result.stderr || "");
      const counts = tapCounts(text);
      if (killed(result.status, text)) console.log(`killed: ${mutant.name} (fail ${counts.fail} of ${counts.tests})`);
      else {
        survived++;
        console.error(`survived: ${mutant.name} (exit ${result.status}, tap ${JSON.stringify(counts)})`);
        console.error(text.slice(-2000));
      }
    }
  } finally {
    for (const [file, original] of originals) writeFileSync(file, original);
    // The edge test bundles the worker from source, so rebuild it from the restored DO store.
    if (originals.has(DO)) spawnSync(process.execPath, ["packages/edge-cf/build.mjs"], { stdio: "inherit" });
  }
  if (survived > 0) {
    console.error(survived + " mutant(s) survived");
    process.exit(1);
  }
  console.log("mint-quote mutants: " + mutants.length + " killed");
}
