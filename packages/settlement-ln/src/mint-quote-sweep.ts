// Retries stored mint quotes that no client will present again: open reservations and booked losses
// whose sats a restore or a later mint can still recover. Bounded per run by a batch size, a mint
// call cap and a time budget, so one run fits a Workers Free invocation (50 subrequests). Runs the
// same store calls as a presentation, so leases, the refusal cap and the re-check schedule apply to
// it as they do to live requests.
import { TollError } from "../../protocol/src/index.ts";
import { defaultMintLookup, MINT_CALL_TIMEOUT_MS } from "./cashu-net.ts";
import { recoverMintQuote, type MintQuoteDeps } from "./mint-quote.ts";

/**
 * A row is only swept once it is this old (seconds). Quote macaroons live at most 120 s, so the
 * sweep never races a client that can still earn a pass with the same quote.
 */
export const SWEEP_MIN_AGE_S = 120;
/** Where the last swept quote is kept, so each run starts after it and stuck rows cannot starve the rest. */
export const SWEEP_CURSOR_KEY = "f:mqsweep:cursor";
/** Refreshed on every set, so a cursor that keeps moving never lapses. */
export const SWEEP_CURSOR_TTL_S = 86_400;

/**
 * Hard cap on mint calls (HTTP requests to the mint) in one run. Workers Free allows 50 subrequests
 * per invocation; the edge run also spends 1 on the cron-to-Durable-Object call and at most 2 on DNS
 * (one memoized lookup per run), so 40 + 1 + 2 = 43 < 50.
 */
export const SWEEP_MAX_CALLS = 40;
/** GET /v1/keysets and GET /v1/keys/<id>: fetched once per run, then served from the run's cache. */
export const SWEEP_KEY_CALLS = 2;
/**
 * The most mint calls one item can make once the keys are cached. bolt11, open PAID row the mint
 * refuses: state, then recoverOpen (state, post, restore, state), the row is released, then a fresh
 * mint (post, state, post, restore, state) = 10. Loopback has no restore: 1 + 3 + 4 = 8. An item is
 * cut off at this many calls; a call refused by the cap reads as a dropped call, so the row is kept.
 */
export const SWEEP_ITEM_CALLS = { bolt11: 10, loopback: 8 } as const;
/** Each mint call (DNS included) is aborted after this long. */
export const SWEEP_CALL_MS = MINT_CALL_TIMEOUT_MS;
/** Defaults for a scheduled run. Worst case: 40 mint calls and 24 s, see sweepMintQuotes. */
export const SWEEP_DEFAULT_BATCH = 25;
export const SWEEP_DEFAULT_BUDGET_MS = 24_000;

/**
 * Per-quote backoff. A quote the sweep took up and could not recover (not a held lease) is skipped
 * for 2^fails runs, and after SWEEP_MAX_TRIES failures it is no longer tried. Its loss stays booked.
 * The mark is a tag `<fails>:<run>` under f:mqsb:<quote>; the run number is a tag under SWEEP_RUN_KEY.
 */
export const SWEEP_BACKOFF_PREFIX = "f:mqsb:";
export const SWEEP_RUN_KEY = "f:mqsweep:run";
export const SWEEP_MAX_TRIES = 6;
export const SWEEP_BACKOFF_TTL_S = 400 * 86_400;

/** A quote the store would retry. `lost` is the unrecovered loss booked for it, in sats (0 when none). `mint` '' means unknown: the configured mint is used. */
export interface SweepCandidate { quote: string; action: string; amount: number; mint: string; lost: number }

export interface SweepSummary {
  /** Candidates taken up this run, deferred ones included. */
  scanned: number;
  /** Quotes whose proofs this run stored. */
  recovered: number;
  /** Booked losses those stores reversed, in sats. */
  reversedSats: number;
  /** Candidates tried and left as they were: a held lease, a closed re-check window, a mint that still refuses, another mint. */
  skipped: number;
  /** Candidates not tried this run: in their backoff window, or past SWEEP_MAX_TRIES. */
  deferred: number;
  /** Mint calls made (cache hits not counted). */
  calls: number;
  /** The run stopped before the batch did. */
  stoppedEarly: boolean;
  /** Why it stopped early: "time" (budget minus the worst item), "calls" (the call cap), or "". */
  stop: "" | "time" | "calls";
}

export interface SweepTags {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, value: string, ttl_s: number) => Promise<void>;
}

export interface SweepDeps extends MintQuoteDeps {
  /** Candidates after `after` in quote order, at most `limit`, each at least `minAgeS` old. */
  candidates: (q: { after: string; limit: number; minAgeS: number }) => Promise<SweepCandidate[]>;
  cursor: { get: () => Promise<string | undefined>; set: (quote: string) => Promise<void> };
  /** Per-quote backoff marks and the run number. Absent: no backoff. */
  tags?: SweepTags;
  /** Milliseconds, monotonic. */
  clock: () => number;
}

export interface SweepOptions {
  batch: number;
  budgetMs: number;
  /** At most SWEEP_MAX_CALLS. */
  maxCalls?: number;
  /** Per mint call timeout, at most SWEEP_CALL_MS. */
  callMs?: number;
  /** Mint calls one item may make (keys aside), at most SWEEP_ITEM_CALLS[mode]. */
  itemCalls?: number;
}

export function emptySweepSummary(): SweepSummary {
  return { scanned: 0, recovered: 0, reversedSats: 0, skipped: 0, deferred: 0, calls: 0, stoppedEarly: false, stop: "" };
}

function parseMark(v: string | undefined): { fails: number; run: number } | undefined {
  const m = v ? /^(\d+):(\d+)$/.exec(v) : null;
  return m ? { fails: Number(m[1]), run: Number(m[2]) } : undefined;
}

const KEY_PATH = /\/v1\/(keysets|keys\/[0-9a-fA-F]+)$/;

/**
 * One bounded pass. Idempotent: a recovered quote holds proofs and is no longer a candidate, and a
 * store finishes a quote once, so a rerun or a concurrent presentation books nothing twice.
 *
 * Before each item the run counts that item's worst case: SWEEP_ITEM_CALLS[mode] calls, plus
 * SWEEP_KEY_CALLS while the keys are not cached. It stops before an item that could take the run
 * past `maxCalls`, and before an item that could take it past `budgetMs` (elapsed > budgetMs minus
 * worst calls x callMs). Each call is aborted after callMs, so a run ends within budgetMs plus store
 * time. Defaults (bolt11): 2 + 10 + 10 + 10 = 32 <= 40 calls for three worst-case items; the first
 * item's worst is 12 x 1.5 s = 18 s and a later one's 15 s, both inside 24 s.
 */
export async function sweepMintQuotes(o: SweepDeps, opts: SweepOptions): Promise<SweepSummary> {
  const { batch, budgetMs } = opts;
  const maxCalls = opts.maxCalls ?? SWEEP_MAX_CALLS;
  const callMs = opts.callMs ?? SWEEP_CALL_MS;
  if (!Number.isSafeInteger(batch) || batch < 1 || !Number.isFinite(budgetMs) || budgetMs < 0) throw new TollError("malformed");
  // MINT_QUOTE_GUARD sweep-caps: callers cannot raise the call cap or the call timeout past the defaults.
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > SWEEP_MAX_CALLS) throw new TollError("malformed");
  if (!Number.isFinite(callMs) || callMs <= 0 || callMs > SWEEP_CALL_MS) throw new TollError("malformed");
  const mode = o.mode ?? "loopback";
  const itemCalls = opts.itemCalls ?? SWEEP_ITEM_CALLS[mode];
  if (!Number.isSafeInteger(itemCalls) || itemCalls < 1 || itemCalls > SWEEP_ITEM_CALLS[mode]) throw new TollError("malformed");
  const start = o.clock();
  const out = emptySweepSummary();

  // One meter for the run: counts calls, caps them per run and per item, times each out, and
  // serves the keyset and keys from a cache after the first answer.
  const keys = new Map<string, string>();
  let itemLeft = 0;
  const inner = o.fetchImpl ?? fetch;
  const metered: typeof fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let cacheable = false;
    try { cacheable = method === "GET" && KEY_PATH.test(new URL(href).pathname); } catch { /* not a URL: not cached */ }
    const hit = cacheable ? keys.get(href) : undefined;
    if (hit !== undefined) return new Response(hit, { status: 200, headers: { "content-type": "application/json" } });
    // MINT_QUOTE_GUARD sweep-call-cap: no mint call past the run's cap or the item's worst case.
    if (out.calls >= maxCalls || itemLeft <= 0) throw new Error("sweep call cap");
    out.calls++;
    itemLeft--;
    const timeout = AbortSignal.timeout(callMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const r = await inner(input, { ...init, signal });
    if (!cacheable || r.status !== 200) return r;
    const text = await r.text();
    keys.set(href, text);
    return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  };
  // One DNS answer per host per run.
  const looked = new Map<string, Promise<string[]>>();
  const look = o.guard?.lookup ?? defaultMintLookup;
  const lookup = (host: string) => {
    let p = looked.get(host);
    if (!p) {
      p = look(host);
      looked.set(host, p);
      p.catch(() => looked.delete(host));
    }
    return p;
  };
  let held = false;
  const deps: MintQuoteDeps = {
    ...o, fetchImpl: metered, guard: { ...o.guard, fetch: metered, lookup },
    // A held lease (or a row another caller just finished) is not this quote failing.
    has: async (q) => (held = await o.has(q)),
  };

  let run = 0;
  if (o.tags) {
    run = Number(await o.tags.get(SWEEP_RUN_KEY) ?? "0") + 1;
    if (!Number.isSafeInteger(run) || run < 1) run = 1;
    await o.tags.set(SWEEP_RUN_KEY, String(run), SWEEP_BACKOFF_TTL_S);
  }

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
    const worst = itemCalls + (mode === "bolt11" && keys.size < SWEEP_KEY_CALLS ? SWEEP_KEY_CALLS : 0);
    // MINT_QUOTE_GUARD sweep-calls: no item that could take the run past the call cap.
    if (out.calls + worst > maxCalls) {
      out.stoppedEarly = true;
      out.stop = "calls";
      break;
    }
    // MINT_QUOTE_GUARD sweep-budget: no item that could run past the time budget.
    if (o.clock() - start > budgetMs - worst * callMs) {
      out.stoppedEarly = true;
      out.stop = "time";
      break;
    }
    out.scanned++;
    await o.cursor.set(c.quote);
    const markKey = SWEEP_BACKOFF_PREFIX + c.quote;
    const mark = o.tags ? parseMark(await o.tags.get(markKey)) : undefined;
    // MINT_QUOTE_GUARD sweep-backoff: a quote that keeps failing waits 2^fails runs, and stops after SWEEP_MAX_TRIES.
    if (mark && (mark.fails >= SWEEP_MAX_TRIES || run < mark.run + 2 ** mark.fails)) {
      out.deferred++;
      continue;
    }
    // MINT_QUOTE_GUARD sweep-mint-fallback: a row booked before the mint was recorded is tried on the configured mint.
    const row = { ...c, mint: c.mint === "" ? o.mint : c.mint };
    held = false;
    itemLeft = worst;
    try {
      await recoverMintQuote(deps, row);
    } catch {
      itemLeft = 0;
      out.skipped++;
      if (o.tags && !held) await o.tags.set(markKey, `${(mark?.fails ?? 0) + 1}:${run}`, SWEEP_BACKOFF_TTL_S);
      continue;
    }
    itemLeft = 0;
    out.recovered++;
    // The store reverses a booked loss in the same write that stores the proofs.
    out.reversedSats += c.lost;
  }
  return out;
}
