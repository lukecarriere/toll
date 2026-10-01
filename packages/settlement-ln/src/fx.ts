// USD display rate (spec §8.6.2, settlement.md Q4). Only USD display depends on it: amounts are
// always integer msat, and when the rate is missing or older than 15 minutes the USD is hidden,
// never guessed.
//
// Phase 2 ships one source: a FIXED TEST RATE for the demo and tests. It is not a market price and
// is labelled as such wherever it is configured. A live, free, commercial-use source is still to be
// chosen (Q4); no paid source is used.

export interface FxQuote {
  usd_per_btc: number;
  /** Unix seconds when the rate was obtained. */
  fetched_at: number;
  source: string;
}

export interface FxSource {
  readonly kind: "fixed-test" | "none";
  /** Current quote, or null when the rate is unavailable. */
  quote(now: number): FxQuote | null;
}

export const FX_MAX_AGE_S = 15 * 60;

/** Fixed test rate. `setDown(true)` simulates the rate source being unavailable. */
export class FixedTestRate implements FxSource {
  readonly kind = "fixed-test" as const;
  private down = false;
  readonly usd_per_btc: number;
  constructor(usd_per_btc: number) {
    this.usd_per_btc = usd_per_btc;
    if (!(usd_per_btc > 0) || !Number.isFinite(usd_per_btc)) throw new Error("fixed test rate must be a positive number");
  }
  setDown(down: boolean) {
    this.down = down;
  }
  quote(now: number): FxQuote | null {
    return this.down ? null : { usd_per_btc: this.usd_per_btc, fetched_at: now, source: "fixed test rate" };
  }
}

/** No rate configured: USD is always hidden. */
export class NoRate implements FxSource {
  readonly kind = "none" as const;
  quote(): FxQuote | null {
    return null;
  }
}

export function fresh(fx: FxQuote | null, now: number): fx is FxQuote {
  return !!fx && fx.usd_per_btc > 0 && now - fx.fetched_at <= FX_MAX_AGE_S;
}

/**
 * USD for an offer's `display.usd` (agents): plain decimal string with 4 places, or undefined to omit
 * it. Rounds UP to $0.0001 (an offer never looks cheaper than it is); the 1e-6 tolerance absorbs
 * float noise so Node and PHP agree (settlement vectors).
 */
export function offerUsd(amount_msat: number, fx: FxQuote | null, now: number): string | undefined {
  if (!fresh(fx, now)) return undefined;
  const units = Math.ceil((amount_msat * fx.usd_per_btc) / 1e7 - 1e-6); // 1 unit = $0.0001
  return Math.floor(units / 10000) + "." + String(units % 10000).padStart(4, "0");
}
