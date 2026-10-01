// Site ledger (spec §8.6.5, PM decision 2026-09-30): integer msat only.
// Every settled payment records gross, fee and net. The platform fee is recorded and held;
// nothing is transferred anywhere until phase 4 (there is no hosted processor to receive it).

export interface LedgerEntry {
  id: number;
  site: string;
  at: number;
  kind: "credit" | "withdrawal";
  ref: string; // offer_id for credits, withdrawal id for withdrawals
  gross_msat: number;
  fee_bps: number;
  fee_msat: number;
  net_msat: number; // credits: gross - fee; withdrawals: negative amount withdrawn
}

export interface Balance {
  gross_msat: number;
  fee_held_msat: number;
  net_credited_msat: number;
  withdrawn_msat: number;
  available_msat: number;
}

/** Fee rounds down to the whole msat, so rounding always favours the site owner. */
export function splitFee(gross_msat: number, fee_bps: number): { fee_msat: number; net_msat: number } {
  if (!Number.isSafeInteger(gross_msat) || gross_msat < 0) throw new Error("gross must be a non-negative integer msat");
  if (!Number.isInteger(fee_bps) || fee_bps < 0 || fee_bps > 10_000) throw new Error("fee_bps must be 0..10000");
  const fee_msat = Math.floor((gross_msat * fee_bps) / 10_000);
  return { fee_msat, net_msat: gross_msat - fee_msat };
}

export class MemoryLedger {
  private entries: LedgerEntry[] = [];
  private refs = new Set<string>();

  credit(o: { site: string; ref: string; gross_msat: number; fee_bps: number; at: number }): LedgerEntry {
    if (this.refs.has("c:" + o.ref)) throw new Error("duplicate credit for " + o.ref);
    const { fee_msat, net_msat } = splitFee(o.gross_msat, o.fee_bps);
    const e: LedgerEntry = { id: this.entries.length + 1, site: o.site, at: o.at, kind: "credit", ref: o.ref, gross_msat: o.gross_msat, fee_bps: o.fee_bps, fee_msat, net_msat };
    this.entries.push(e);
    this.refs.add("c:" + o.ref);
    return e;
  }

  /** Phase 2: called after a withdrawal invoice is paid. Rejects more than the available balance. */
  withdraw(o: { site: string; ref: string; amount_msat: number; at: number }): LedgerEntry {
    if (!Number.isSafeInteger(o.amount_msat) || o.amount_msat <= 0) throw new Error("bad amount");
    if (o.amount_msat > this.balance(o.site).available_msat) throw new Error("more than the available balance");
    const e: LedgerEntry = { id: this.entries.length + 1, site: o.site, at: o.at, kind: "withdrawal", ref: o.ref, gross_msat: 0, fee_bps: 0, fee_msat: 0, net_msat: -o.amount_msat };
    this.entries.push(e);
    return e;
  }

  balance(site: string): Balance {
    let gross = 0, fee = 0, net = 0, withdrawn = 0;
    for (const e of this.entries) {
      if (e.site !== site) continue;
      if (e.kind === "credit") { gross += e.gross_msat; fee += e.fee_msat; net += e.net_msat; }
      else withdrawn += -e.net_msat;
    }
    return { gross_msat: gross, fee_held_msat: fee, net_credited_msat: net, withdrawn_msat: withdrawn, available_msat: net - withdrawn };
  }

  list(site: string): LedgerEntry[] {
    return this.entries.filter((e) => e.site === site);
  }
}

/**
 * USD display for owner screens (docs/copy.md "Money"): two decimals, "less than $0.01" for a
 * non-zero amount under a cent, and null (hide it) when the FX rate is missing or older than 15 min.
 * `usd_per_btc` comes from a cached FX source; msat -> BTC is /1e11.
 */
export function usdDisplay(msat: number, fx: { usd_per_btc: number; fetched_at: number } | null, now: number): string | null {
  if (!fx || !(fx.usd_per_btc > 0) || now - fx.fetched_at > 15 * 60) return null;
  const usd = (msat / 1e11) * fx.usd_per_btc;
  if (msat > 0 && usd < 0.01) return "less than $0.01";
  return "$" + usd.toFixed(2);
}
