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
const HTTP = "packages/server-node/src/http.ts";
const TEST_FILES = ["tests/edge-do-store.test.ts", "tests/settlement-mint-quote.test.ts", "tests/l402-quote.test.ts", "tests/l402-edge.test.ts", "tests/l402-expiry.test.ts"];
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
    from: '      await o.noteLoss({ quote: c.quote, action: c.cls, amount, reason: "unrecoverable" });\n      await o.unlock(c.quote);\n      throw new TollError("store_unavailable", MINT_SIGNED_UNRECOVERABLE);',
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
    from: "    // MINT_QUOTE_GUARD issued-loss: a paid quote this store holds no row for is booked as a loss, once.\n    await o.noteLoss({ quote: c.quote, action: c.cls, amount, reason: \"issued_no_row\" });\n",
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
    from: '      await o.noteLoss({ quote: c.quote, action: c.cls, amount, reason: "unrecoverable" });\n      await o.unlock(c.quote);\n      throw new TollError("store_unavailable", MINT_SIGNED_UNRECOVERABLE);',
    to: '      await o.unlock(c.quote);\n      throw new TollError("store_unavailable", MINT_SIGNED_UNRECOVERABLE);',
  },
  {
    name: "a retryable quote 503 has no Retry-After",
    test: "a retryable 503 carries Retry-After and the unrecoverable 503 does not",
    from: ': { "retry-after": MINT_RETRY_AFTER_S };',
    to: ": {};",
  },
  {
    name: "the unrecoverable quote 503 invites a retry",
    test: "a retryable 503 carries Retry-After and the unrecoverable 503 does not",
    from: 'return detail === MINT_SIGNED_UNRECOVERABLE ? {} :',
    to: 'return detail === "" ? {} :',
  },
  {
    name: "any non-200 mint reply is read as a refusal",
    test: "a proxy's 502 page in place of the mint keeps the reservation",
    from: 'return typeof body.detail === "string" || typeof body.code === "number" ? "refused" : "unknown";',
    to: 'return "refused";',
  },
  {
    name: "an expired paid quote is booked as a loss instead of minted",
    test: "an expired macaroon on a paid quote that was never minted books the sats as stored",
    from: "  if (expired && state !== \"PAID\") {\n",
    to: "  if (expired && state === \"PAID\") await o.noteLoss({ quote: c.quote, action: c.cls, amount, reason: \"issued_no_row\" });\n  if (expired) {\n",
  },
  {
    name: "an expired issued quote with no row is not booked as a loss",
    test: "an expired token and an action mismatch are refused",
    from: '    if (state === "ISSUED") await o.noteLoss({ quote: c.quote, action: c.cls, amount, reason: "issued_no_row" });\n',
    to: "",
  },
  {
    name: "a freshly minted expired quote is granted a pass",
    test: "an expired macaroon on a paid quote that was never minted books the sats as stored",
    from: "    await commitProofs(o, c.quote, c.cls, amount, first.proofs);\n    return granted();",
    to: "    await commitProofs(o, c.quote, c.cls, amount, first.proofs);\n    return paid();",
  },
  {
    file: MS,
    name: "memory finish does not reverse a booked loss",
    test: "a restore after a booked unrecoverable loss reverses it, once",
    from: "    if (lost) lost.recovered = true;\n",
    to: "",
  },
  {
    file: MS,
    name: "memory net losses count recovered rows",
    test: "a restore after a booked unrecoverable loss reverses it, once",
    from: "return this.losses.filter((o) => !o.recovered).map(",
    to: "return this.losses.map(",
  },
  {
    file: DO,
    name: "DO finish does not reverse a booked loss",
    test: "a restore on the worker after a booked unrecoverable loss reverses it, once",
    from: "      if (lost.length) {\n        this.sql.exec(\"UPDATE cashu_mint_loss SET recovered = 1 WHERE quote = ?\", row.quote);",
    to: "      if (false) {\n        this.sql.exec(\"UPDATE cashu_mint_loss SET recovered = 1 WHERE quote = ?\", row.quote);",
  },
  {
    file: DO,
    name: "DO reversal marks the row but leaves the loss in the books",
    test: "a restore on the worker after a booked unrecoverable loss reverses it, once",
    from: "        this.sql.exec(\"UPDATE cashu_meta SET n = ? WHERE k = 'losses'\", Math.max(0, this.lossN() - num(lost[0].amount)));\n",
    to: "",
  },
  {
    name: "the expired refusal cap is never reached",
    test: "an expired paid quote the mint keeps refusing books one loss at the cap",
    from: "(await o.refusalsLeft(c.quote, EXPIRED_REFUSAL_CAP)) <= 0",
    to: "(await o.refusalsLeft(c.quote, EXPIRED_REFUSAL_CAP)) < -1",
  },
  {
    name: "unexpired refusals count toward the cap",
    test: "an expired paid quote the mint keeps refusing books one loss at the cap",
    from: "if (expired && o.refusalsLeft && (await",
    to: "if (o.refusalsLeft && (await",
  },
  {
    name: "a capped refusal is not booked as a loss",
    test: "an expired paid quote the mint keeps refusing books one loss at the cap",
    from: '      await o.noteLoss({ quote: c.quote, action: c.cls, amount, reason: "mint_refused" });\n',
    to: "",
  },
  {
    file: MS,
    name: "memory loss record loses its dedup",
    test: "past the refusal cap, presentations post to the mint only on the re-check schedule",
    from: "    if (this.losses.some((row) => row.quote === o.quote)) return;\n",
    to: "",
  },
  {
    file: HTTP,
    name: "guardFetch drops the quote 503 headers",
    test: "guardFetch sends Retry-After on a retryable quote 503",
    from: "      if (quoted) return Response.json(quoted.body, { status: quoted.status, headers: quoted.headers });\n      return refuse(true);",
    to: "      if (quoted) return Response.json(quoted.body, { status: quoted.status });\n      return refuse(true);",
  },
  {
    file: HTTP,
    name: "guardFetch drops the quote 503 headers beside a stale pass",
    test: "guardFetch sends Retry-After on a retryable quote 503",
    from: "      if (quoted) return Response.json(quoted.body, { status: quoted.status, headers: quoted.headers });\n      return refuse(false);",
    to: "      if (quoted) return Response.json(quoted.body, { status: quoted.status });\n      return refuse(false);",
  },
  {
    file: DO,
    name: "the loss-table migration re-adds reason on every start",
    test: "edge store migration: a restart on an already migrated store is a no-op",
    from: 'if (!lossCols.includes("reason")) this.sql.exec(',
    to: "this.sql.exec(",
  },
  {
    file: DO,
    name: "the loss-table migration re-adds recovered on every start",
    test: "edge store migration: a restart on an already migrated store is a no-op",
    from: 'if (!lossCols.includes("recovered")) this.sql.exec(',
    to: "this.sql.exec(",
  },
  {
    file: DO,
    name: "a reversal can drive net losses below zero",
    test: "edge store reversal: net losses never go below zero",
    from: "Math.max(0, this.lossN() - num(lost[0].amount))",
    to: "this.lossN() - num(lost[0].amount)",
  },
  {
    name: "past the cap every presentation posts",
    test: "past the refusal cap, presentations post to the mint only on the re-check schedule",
    from: 'if (expired && o.rechecks && (await o.rechecks.gate(c.quote)) === "closed") throw new TollError("expired");',
    to: "// mutant: no re-check gate",
  },
  {
    name: "the cap does not start the re-check schedule",
    test: "past the refusal cap, presentations post to the mint only on the re-check schedule",
    from: "await o.rechecks?.arm(c.quote);",
    to: "// mutant: not armed",
  },
  {
    name: "re-checks never run out",
    test: "past the refusal cap, presentations post to the mint only on the re-check schedule",
    from: 'if (n <= 0) return "closed";',
    to: "// mutant: no last re-check",
  },
  {
    name: "a re-check window admits every presentation",
    test: "past the refusal cap, presentations post to the mint only on the re-check schedule",
    from: 'if (!(await store.firstUse("f:mqw:" + quote, RECHECK_BASE_S * 2 ** (used + 1)))) return "closed";',
    to: 'await store.firstUse("f:mqw:" + quote, RECHECK_BASE_S * 2 ** (used + 1));',
  },
  {
    name: "re-check windows do not grow",
    test: "past the refusal cap, presentations post to the mint only on the re-check schedule",
    from: "RECHECK_BASE_S * 2 ** (used + 1)",
    to: "RECHECK_BASE_S",
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
