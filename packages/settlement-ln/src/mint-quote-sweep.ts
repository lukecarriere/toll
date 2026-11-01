// Retries stored mint quotes that no client will present again: open reservations and booked losses
// whose sats a restore or a later mint can still recover. Bounded per run by a batch size and a time
// budget. Runs the same store calls as a presentation, so leases, the refusal cap and the re-check
// schedule apply to it as they do to live requests.
import { TollError } from "../../protocol/src/index.ts";
import { recoverMintQuote, type MintQuoteDeps } from "./mint-quote.ts";

/**
 * A row is only swept once it is this old (seconds). Quote macaroons live at most 120 s, so the
 * sweep never races a client that can still earn a pass with the same quote.
 */
export const SWEEP_MIN_AGE_S = 120;
/** Where the last swept quote is kept, so each run starts after it and stuck rows cannot starve the rest. */
export const SWEEP_CURSOR_KEY = "f:mqsweep:cursor";
export const SWEEP_CURSOR_TTL_S = 86_400;

/** A quote the store would retry. `lost` is the unrecovered loss booked for it, in sats (0 when none). */
export interface SweepCandidate { quote: string; action: string; amount: number; mint: string; lost: number }

export interface SweepSummary {
  /** Candidates taken up this run. */
  scanned: number;
  /** Quotes whose proofs this run stored. */
  recovered: number;
  /** Booked losses those stores reversed, in sats. */
  reversedSats: number;
  /** Candidates left as they were: a held lease, a closed re-check window, a mint that still refuses, another mint. */
  skipped: number;
  /** The time budget ran out before the batch did. */
  stoppedEarly: boolean;
}

export interface SweepDeps extends MintQuoteDeps {
  /** Candidates after `after` in quote order, at most `limit`, each at least `minAgeS` old. */
  candidates: (q: { after: string; limit: number; minAgeS: number }) => Promise<SweepCandidate[]>;
  cursor: { get: () => Promise<string | undefined>; set: (quote: string) => Promise<void> };
  /** Milliseconds, monotonic. */
  clock: () => number;
}

export function emptySweepSummary(): SweepSummary {
  return { scanned: 0, recovered: 0, reversedSats: 0, skipped: 0, stoppedEarly: false };
}

/**
 * One bounded pass. Idempotent: a recovered quote holds proofs and is no longer a candidate, and a
 * store finishes a quote once, so a rerun or a concurrent presentation books nothing twice. The
 * budget is checked before each item, so one slow item can run past it (by the mint timeouts).
 */
export async function sweepMintQuotes(o: SweepDeps, opts: { batch: number; budgetMs: number }): Promise<SweepSummary> {
  const { batch, budgetMs } = opts;
  if (!Number.isSafeInteger(batch) || batch < 1 || !Number.isFinite(budgetMs) || budgetMs < 0) throw new TollError("malformed");
  const start = o.clock();
  const out = emptySweepSummary();
  const after = (await o.cursor.get()) ?? "";
  // MINT_QUOTE_GUARD sweep-batch: one run takes up at most `batch` candidates.
  const list = await o.candidates({ after, limit: batch, minAgeS: SWEEP_MIN_AGE_S });
  if (list.length < batch && after !== "") {
    // Past the end: wrap to the start for the rest of the batch.
    const seen = new Set(list.map((c) => c.quote));
    const wrapped = await o.candidates({ after: "", limit: batch - list.length, minAgeS: SWEEP_MIN_AGE_S });
    list.push(...wrapped.filter((c) => !seen.has(c.quote)));
  }
  for (const c of list) {
    // MINT_QUOTE_GUARD sweep-budget: no new item once the time budget is spent.
    if (o.clock() - start >= budgetMs) {
      out.stoppedEarly = true;
      break;
    }
    out.scanned++;
    await o.cursor.set(c.quote);
    try {
      await recoverMintQuote(o, c);
    } catch {
      out.skipped++;
      continue;
    }
    out.recovered++;
    // The store reverses a booked loss in the same write that stores the proofs.
    out.reversedSats += c.lost;
  }
  return out;
}
