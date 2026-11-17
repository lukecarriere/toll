// USD display rate (spec §8.6.2, settlement.md Q4). Only USD display depends on it: amounts are
// always integer msat, and when the rate is missing or older than 15 minutes the USD is hidden,
// never guessed.
//
// Sources:
//   - fixed test rate: demo and tests only. It is not a market price and is labelled as such.
//   - public: Coinbase's keyless BTC-USD spot price, with mempool.space as a free fallback. No
//     API key. Cached at most 15 minutes. /v1/price refreshes before it answers so usd is not
//     left null when a source is up.
//   - none: USD is always hidden.

export interface FxQuote {
  usd_per_btc: number;
  /** Unix seconds when the rate was obtained. */
  fetched_at: number;
  source: string;
}

export interface FxSource {
  readonly kind: "fixed-test" | "none" | "public";
  /** Current quote, or null when the rate is unavailable. */
  quote(now: number): FxQuote | null;
  /** Fetch a fresh quote when the cache is stale. Optional; fixed and none do not need it. */
  refresh?(now: number): Promise<FxQuote | null>;
}

export const FX_MAX_AGE_S = 15 * 60;

/** Free, keyless BTC/USD endpoints tried in order. */
export const PUBLIC_FX_URLS = [
  "https://api.coinbase.com/v2/prices/BTC-USD/spot",
  "https://mempool.space/api/v1/prices",
] as const;

const FX_FETCH_MS = 2500;
const FX_UA = "toll-fx/1.0";
const FX_MIN_USD_PER_BTC = 1000;
const FX_MAX_USD_PER_BTC = 5_000_000;

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

/**
 * Live USD-per-BTC rate from public, keyless endpoints. `fetchImpl` is injectable for tests.
 * quote() stays synchronous (cache only). Call refresh() before building a /v1/price response.
 */
export class PublicBtcUsdRate implements FxSource {
  readonly kind = "public" as const;
  private cached: FxQuote | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly urls: readonly string[];
  constructor(fetchImpl?: typeof fetch, urls: readonly string[] = PUBLIC_FX_URLS) {
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.urls = urls;
  }

  quote(now: number): FxQuote | null {
    return fresh(this.cached, now) ? this.cached : null;
  }

  async refresh(now: number): Promise<FxQuote | null> {
    if (fresh(this.cached, now)) return this.cached;
    for (const url of this.urls) {
      const quote = await this.fetchOne(url, now);
      if (quote) {
        this.cached = quote;
        return quote;
      }
    }
    return this.quote(now);
  }

  private async fetchOne(url: string, now: number): Promise<FxQuote | null> {
    let text = "";
    try {
      const res = await this.fetchImpl(url, {
        headers: { accept: "application/json", "user-agent": FX_UA },
        signal: AbortSignal.timeout(FX_FETCH_MS),
      });
      text = await res.text();
      if (!res.ok) return null;
    } catch {
      return null;
    }
    let body: unknown;
    try { body = text ? JSON.parse(text) : null; } catch { return null; }
    const rate = parsePublicUsdPerBtc(body);
    if (rate == null) return null;
    return { usd_per_btc: rate, fetched_at: now, source: url };
  }
}

/** Coinbase `{ data: { amount } }` or mempool.space `{ USD }`. */
export function parsePublicUsdPerBtc(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const rec = body as Record<string, unknown>;
  const data = rec.data;
  const coinbase = data && typeof data === "object" ? Number((data as { amount?: unknown }).amount) : Number.NaN;
  const mempool = Number(rec.USD);
  const rate = Number.isFinite(coinbase) && coinbase > 0 ? coinbase : mempool;
  if (!(rate >= FX_MIN_USD_PER_BTC && rate <= FX_MAX_USD_PER_BTC) || !Number.isFinite(rate)) return null;
  return rate;
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
