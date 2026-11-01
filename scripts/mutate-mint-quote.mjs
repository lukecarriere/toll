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
const TOLL = "packages/server-node/src/toll.ts";
const METRICS = "packages/server-node/src/metrics.ts";
const SWEEP = "packages/settlement-ln/src/mint-quote-sweep.ts";
const SITE = "packages/edge-cf/src/site.ts";
const TEST_FILES = ["tests/edge-do-store.test.ts", "tests/settlement-mint-quote.test.ts", "tests/l402-quote.test.ts", "tests/l402-edge.test.ts", "tests/l402-expiry.test.ts", "tests/mint-quote-sweep.test.ts", "tests/mint-quote-sweep-budget.test.ts", "tests/edge-mint-quote-sweep.test.ts"];
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
    from: "  await settleMintQuote(o, { quote: c.quote, cls: c.cls, mint: c.mint, amount, state, expired });\n  return granted();",
    to: "  await settleMintQuote(o, { quote: c.quote, cls: c.cls, mint: c.mint, amount, state, expired });\n  return paid();",
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
    from: 'if (expired && (gate === "open" || (o.refusalsLeft && (await',
    to: 'if ((gate === "open" || (o.refusalsLeft && (await',
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
    from: 'const gate = expired && o.rechecks ? await o.rechecks.gate(c.quote) : "uncapped";\n  if (gate === "closed") throw new TollError("expired");',
    to: 'const gate = "uncapped"; // mutant: no re-check gate',
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
  {
    file: DO,
    name: "an edge reversal is not counted",
    test: "edge store stats: a reversal counts once, with its sats, and survives a restart",
    from: '        this.bumpMeta("reversals", 1);\n',
    to: "",
  },
  {
    file: DO,
    name: "an edge reversal counts no sats",
    test: "edge store stats: a reversal counts once, with its sats, and survives a restart",
    from: 'this.bumpMeta("reversed_sats", num(lost[0].amount));',
    to: 'this.bumpMeta("reversed_sats", 1);',
  },
  {
    file: TOLL,
    name: "a Node reversal is not reported to the stats",
    test: "a re-check after the cap that the mint signs stores the proofs and reverses the loss",
    from: "if (reversed) metrics.mintQuoteReversed({ quote: row.quote, amount: reversed.amount });",
    to: "// mutant: not reported",
  },
  {
    file: TOLL,
    name: "a Node finish counts a reversal for any recovered row",
    test: "a re-check after the cap that the mint signs stores the proofs and reverses the loss",
    from: "store.mintQuoteLossRows?.().find((o) => o.quote === row.quote && o.recovered)",
    to: "store.mintQuoteLossRows?.().find((o) => o.recovered)",
  },
  {
    file: METRICS,
    name: "the Node stats count reversals but not their sats",
    test: "a re-check after the cap that the mint signs stores the proofs and reverses the loss",
    from: "this.c.mint_quote_reversed_sats += f.amount;",
    to: "this.c.mint_quote_reversed_sats += 1;",
  },
  {
    name: "a loss does not name its mint",
    test: "a loss names the quote's mint in the Node store",
    from: "noteLoss: (x) => deps.noteLoss({ ...x, mint: c.mint })",
    to: "noteLoss: (x) => deps.noteLoss({ ...x })",
  },
  {
    file: DO,
    name: "the edge loss row drops the mint",
    test: "edge store migration: the loss mint column is added once",
    from: 'o.reason ?? "", o.mint ?? "", this.now());',
    to: 'o.reason ?? "", "", this.now());',
  },
  {
    file: DO,
    name: "the edge loss mint column is added on every start",
    test: "edge store migration: the loss mint column is added once",
    from: 'if (!lossCols.includes("mint")) this.sql.exec("ALTER TABLE cashu_mint_loss ADD COLUMN mint',
    to: 'if (lossCols.length > 0) this.sql.exec("ALTER TABLE cashu_mint_loss ADD COLUMN mint',
  },
  {
    file: SWEEP,
    name: "the sweep takes up one item more than its batch",
    test: "sweep batch limit: a run takes up at most",
    from: "const list = await o.candidates({ after, limit: batch, minAgeS: SWEEP_MIN_AGE_S });",
    to: "const list = await o.candidates({ after, limit: batch + 1, minAgeS: SWEEP_MIN_AGE_S });",
  },
  {
    file: SWEEP,
    name: "the sweep's wrap-around ignores what the run already took",
    test: "sweep batch limit: a run takes up at most",
    from: "limit: batch - list.length, minAgeS: SWEEP_MIN_AGE_S",
    to: "limit: batch, minAgeS: SWEEP_MIN_AGE_S",
  },
  {
    file: SWEEP,
    name: "the sweep ignores its time budget",
    test: "sweep budget stop:",
    from: "if (o.clock() - start > budgetMs - worst * callMs) {",
    to: "if (false) {",
  },
  {
    file: SWEEP,
    name: "the sweep's budget leaves out the item's worst time",
    test: "sweep budget stop:",
    from: "if (o.clock() - start > budgetMs - worst * callMs) {",
    to: "if (o.clock() - start > budgetMs) {",
  },
  {
    file: MS,
    name: "the Node sweep takes up rows a client may still present",
    test: "sweep recovery: an open reservation is restored",
    from: "const cutoff = this.now() - o.minAgeS;",
    to: "const cutoff = this.now();",
  },
  {
    file: MS,
    name: "the Node sweep retries issued_no_row losses",
    test: "sweep nothing recoverable:",
    from: '!this.quotes.has(l.quote) && l.reason !== "issued_no_row"',
    to: "!this.quotes.has(l.quote)",
  },
  {
    name: "the sweep sends a quote to a mint it was not issued by",
    test: "sweep nothing recoverable:",
    from: 'if (row.mint !== o.mint) throw new TollError("bad_sig");',
    to: "",
  },
  {
    name: "re-check marks are kept 1 day instead of 30 (QA C13)",
    test: "re-check marks last 30 days from the cap",
    from: "export const RECHECK_TTL_S = 30 * 86_400;",
    to: "export const RECHECK_TTL_S = 86_400;",
  },
  {
    file: MS,
    name: "the Node store keeps a counter's first TTL on later spends",
    test: "re-check marks on Node last 30 days from the last re-check",
    from: "    e.until = this.now() + ttl_s;\n",
    to: "",
  },
  {
    name: "a refused re-check counts toward a lapsed refusal count again",
    test: "a refused re-check after the one-day refusal count lapses",
    from: 'if (expired && (gate === "open" || (o.refusalsLeft',
    to: 'if (expired && ((o.refusalsLeft',
  },
  {
    file: SWEEP,
    name: "the sweep starts an item that could pass the call cap",
    test: "sweep call cap:",
    from: "if (out.calls + worst > maxCalls) {",
    to: "if (false) {",
  },
  {
    file: SWEEP,
    name: "the sweep's worst case leaves out the key calls",
    test: "sweep call cap:",
    from: '+ (mode === "bolt11" && keys.size < SWEEP_KEY_CALLS ? SWEEP_KEY_CALLS : 0)',
    to: "+ 0",
  },
  {
    file: SWEEP,
    name: "the meter lets an item past its worst case",
    test: "sweep item cap:",
    from: "if (out.calls >= maxCalls || itemLeft <= 0) throw",
    to: "if (out.calls >= maxCalls) throw",
  },
  {
    file: SWEEP,
    name: "the meter fetches the keys for every item",
    test: "sweep call cap:",
    from: "const hit = cacheable ? keys.get(href) : undefined;",
    to: "const hit = undefined;",
  },
  {
    file: SWEEP,
    name: "mint calls are not timed out at callMs",
    test: "sweep time budget:",
    from: "const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;",
    to: "const signal = init?.signal;",
  },
  {
    file: SWEEP,
    name: "callers can raise the call cap",
    test: "sweep call cap:",
    from: "maxCalls > SWEEP_MAX_CALLS) throw",
    to: "maxCalls > 1000) throw",
  },
  {
    file: SWEEP,
    name: "callers can raise the call timeout",
    test: "sweep call cap:",
    from: "callMs > SWEEP_CALL_MS) throw",
    to: "callMs > 60_000) throw",
  },
  {
    file: SWEEP,
    name: "callers can raise the item cap",
    test: "sweep call cap:",
    from: "itemCalls > SWEEP_ITEM_CALLS[mode]) throw",
    to: "itemCalls > 1000) throw",
  },
  {
    file: SWEEP,
    name: "a failing quote is retried every run",
    test: "sweep backoff: a quote that keeps failing",
    from: "if (mark && (mark.fails >= SWEEP_MAX_TRIES || run < mark.run + 2 ** mark.fails)) {",
    to: "if (false) {",
  },
  {
    file: SWEEP,
    name: "a failing quote is retried forever",
    test: "sweep backoff: a quote that keeps failing",
    from: "if (mark && (mark.fails >= SWEEP_MAX_TRIES || run < mark.run + 2 ** mark.fails)) {",
    to: "if (mark && (run < mark.run + 2 ** mark.fails)) {",
  },
  {
    file: SWEEP,
    name: "a held lease counts as a failure",
    test: "sweep backoff: a row held by a live request",
    from: "if (o.tags && !held)",
    to: "if (o.tags)",
  },
  {
    file: SWEEP,
    name: "a row booked with mint '' is not tried on the configured mint",
    test: "sweep mint fallback:",
    from: 'mint: c.mint === "" ? o.mint : c.mint',
    to: "mint: c.mint",
  },
  {
    file: MS,
    name: "the Node cursor keeps its first TTL",
    test: "sweep cursor:",
    from: "      if (Number.isNaN(e.v)) e.until = this.now() + ttl_s;\n",
    to: "",
  },
  {
    file: MS,
    name: "the Node listing drops a young loss from an old open row",
    test: "sweep reversals:",
    from: "if (open) open.lost = l.amount;",
    to: "if (open && l.at <= cutoff) open.lost = l.amount;",
  },
  {
    file: MS,
    name: "the Node listing takes up young bare losses",
    test: "sweep reversals:",
    from: "else if (l.at <= cutoff && !this.quotes.has(l.quote)",
    to: "else if (!this.quotes.has(l.quote)",
  },
  {
    file: MS,
    name: "the Node listing leaves out mint '' losses",
    test: "sweep mint fallback:",
    from: "else if (l.at <= cutoff && !this.quotes.has(l.quote)",
    to: 'else if (l.mint !== "" && l.at <= cutoff && !this.quotes.has(l.quote)',
  },
  {
    file: DO,
    name: "the edge listing takes up young open rows",
    test: "edge store sweep listing:",
    from: "WHERE m.proofs = '[]' AND m.at <= ?",
    to: "WHERE m.proofs = '[]' AND m.at <= ? + 1000",
  },
  {
    file: DO,
    name: "the edge listing takes up young bare losses",
    test: "edge store sweep listing:",
    from: "WHERE l.recovered = 0 AND l.at <= ? AND",
    to: "WHERE l.recovered = 0 AND l.at <= ? + 1000 AND",
  },
  {
    file: DO,
    name: "the edge listing retries issued_no_row losses",
    test: "edge store sweep listing:",
    from: " AND l.reason <> 'issued_no_row'",
    to: "",
  },
  {
    file: DO,
    name: "the edge listing drops the loss of an open row",
    test: "edge store sweep listing:",
    from: "ON l.quote = m.quote AND l.recovered = 0",
    to: "ON l.quote = m.quote AND l.recovered = 0 AND l.at < 0",
  },
  {
    file: DO,
    name: "the edge listing leaves out mint '' losses",
    test: "edge store sweep listing:",
    from: "WHERE l.recovered = 0 AND l.at <= ? AND",
    to: "WHERE l.recovered = 0 AND l.mint <> '' AND l.at <= ? AND",
  },
  {
    file: DO,
    name: "the edge at column is added on every start",
    test: "edge store migration: the at columns",
    from: 'if (!lossCols.includes("at")) this.sql.exec(',
    to: "if (lossCols.length > 0) this.sql.exec(",
  },
  {
    file: DO,
    name: "an edge loss records no time",
    test: "edge store migration: the at columns",
    from: 'o.reason ?? "", o.mint ?? "", this.now());',
    to: 'o.reason ?? "", o.mint ?? "", 0);',
  },
  {
    file: DO,
    name: "the edge seed hook works without test hooks",
    test: "edge store sweep: a worst-case mint",
    from: 'if (this.envOf().TOLL_TEST_HOOKS !== "1") return { ok: false };',
    to: "",
  },
  {
    file: SITE,
    name: "the cron logs no summary",
    test: "edge cron sweep:",
    from: "Object.assign(line, await stub(env).mintQuoteSweep({}));",
    to: "await stub(env).mintQuoteSweep({});",
  },
  {
    file: SITE,
    name: "the cron runs no sweep",
    test: "edge cron sweep:",
    from: "Object.assign(line, await stub(env).mintQuoteSweep({}));",
    to: "",
  },
  {
    file: SWEEP,
    name: "a failed DNS lookup is tried again",
    test: "sweep subrequests: NXDOMAIN",
    from: "p.catch(() => undefined);",
    to: "p.catch(() => looked.delete(host));",
  },
  {
    file: SWEEP,
    name: "an outage spends a sweep try",
    test: "sweep backoff: DNS failure",
    from: 'const answered = (e instanceof TollError && e.code !== "store_unavailable") || definitive;',
    to: "const answered = true;",
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
    if (originals.has(DO) || originals.has(SITE)) spawnSync(process.execPath, ["packages/edge-cf/build.mjs"], { stdio: "inherit" });
  }
  if (survived > 0) {
    console.error(survived + " mutant(s) survived");
    process.exit(1);
  }
  console.log("mint-quote mutants: " + mutants.length + " killed");
}
