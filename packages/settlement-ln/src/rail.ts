// The settlement rail as the issuer uses it (spec §8.6, settlement.md, Amendment 1 §C):
//   offers(cls)      -> offers[] for agent requests (empty when off or degraded; never throws)
//   redeemPaid(body) -> verified payment, booked in the msat ledger; the issuer then mints the
//                       short settle pass (n = pass_uses, exp = pass_ttl_s; default 1 use / 60 s)
//   status(), balance() for health and owner screens (USD, hidden when the rate is unavailable)
// Proof of payment is checked by the settlement engine (stub here; the L402 proxy later). This file
// holds no macaroon or invoice logic of its own.
import { TollError, hmacSha256, toHex, utf8, type ActionClass } from "../../protocol/src/index.ts";
import type { Offer, Paid, PaidClass, SettlementEngine } from "./engine.ts";
import { type FxSource, fresh, offerUsd } from "./fx.ts";
import { type Balance, MemoryLedger, usdDisplay } from "./ledger.ts";
import { offerAmountMsat } from "./stub-engine.ts";

export interface RailOptions {
  site: string;
  engine: SettlementEngine;
  fx: FxSource;
  ledger?: MemoryLedger;
  fee_bps: number;
  offer_ttl_s: number;
  now: () => number;
  /** Single-use guard from the issuer's replay store (throws store_unavailable when it is down). */
  firstUse: (key: string, ttl_s: number) => Promise<boolean>;
  onDegraded?: (reason: string) => void;
  onSettled?: (o: { cls: ActionClass; amount_msat: number; fee_msat: number }) => void;
}

export interface RailStatus {
  mode: "stub";
  healthy: boolean;
  /** Owner switch: false means paid requests are switched off on purpose (offers []), not degraded. */
  collecting: boolean;
  usd: "ok" | "unavailable";
  rate_source: string;
}

/** Derive the stub engine's own secret from the site secret, so it never shares MACs with passes. */
export async function stubEngineSecret(siteSecret: string): Promise<string> {
  return toHex(await hmacSha256(siteSecret, utf8("toll/settlement/stub/v1")));
}

export function createSettlementRail(o: RailOptions) {
  const ledger = o.ledger ?? new MemoryLedger();
  let degraded = false;
  let settledCount = 0;
  /** Owner switch ("Collect usage payouts"). Off: no new offers; work keeps flowing. Not a failure. */
  let collecting = true;
  let replayRejected = 0;
  const recent: { at: number; cls: ActionClass; amount_msat: number }[] = [];

  function markDegraded(reason: string) {
    if (!degraded) o.onDegraded?.(reason);
    degraded = true;
  }

  /** offers[] for an agent request. Fail soft: any engine problem means no offers, work still flows. */
  async function offers(cls: PaidClass, mults: { velocity?: number; suspicion?: number } = {}): Promise<Offer[]> {
    if (!collecting) return [];
    const now = o.now();
    let healthy = false;
    try {
      healthy = await o.engine.healthy();
    } catch {
      healthy = false;
    }
    if (!healthy) {
      markDegraded("engine_unhealthy");
      return [];
    }
    try {
      const amount_msat = offerAmountMsat(cls, mults.velocity ?? 1, mults.suspicion ?? 1);
      const offer = await o.engine.offer({ site: o.site, cls, amount_msat, now, ttl_s: o.offer_ttl_s });
      degraded = false;
      const usd = offerUsd(offer.amount_msat, o.fx.quote(now), now);
      const out: Offer = { ...offer };
      if (usd) out.display = { usd, label: "per request" };
      else delete out.display; // rate unavailable: the amount stands, the USD is omitted (Q4)
      return [out];
    } catch {
      markDegraded("offer_failed");
      return [];
    }
  }

  /**
   * Verify a paid redeem body `{ offer_id, kind: "ln402", preimage, macaroon }` and book it.
   * Order: shape -> engine (credential, offer binding, site, expiry, preimage) -> single use -> ledger.
   * Verification needs no node round trip, so it keeps working while new offers are paused.
   */
  async function redeemPaid(body: any): Promise<Paid & { fee_msat: number; net_msat: number }> {
    if (!body || body.kind !== "ln402" || typeof body.offer_id !== "string" || typeof body.preimage !== "string" || typeof body.macaroon !== "string") throw new TollError("malformed");
    const now = o.now();
    let paid: Paid;
    try {
      paid = await o.engine.verifyPaid({ site: o.site, proof: { offer_id: body.offer_id, credential: body.macaroon, preimage: body.preimage.toLowerCase() }, now, firstUse: o.firstUse });
    } catch (e) {
      if (e instanceof TollError && e.code === "replay") replayRejected++;
      throw e;
    }
    const entry = ledger.credit({ site: o.site, ref: body.offer_id, gross_msat: paid.amount_msat, fee_bps: o.fee_bps, at: now });
    settledCount++;
    recent.push({ at: now, cls: paid.cls, amount_msat: paid.amount_msat });
    if (recent.length > 50) recent.shift();
    o.onSettled?.({ cls: paid.cls, amount_msat: paid.amount_msat, fee_msat: entry.fee_msat });
    return { ...paid, fee_msat: entry.fee_msat, net_msat: entry.net_msat };
  }

  async function status(): Promise<RailStatus> {
    let healthy = false;
    try { healthy = await o.engine.healthy(); } catch { healthy = false; }
    if (!healthy) markDegraded("engine_unhealthy");
    else degraded = false;
    const now = o.now();
    return { mode: "stub", healthy, collecting, usd: fresh(o.fx.quote(now), now) ? "ok" : "unavailable", rate_source: o.fx.kind };
  }

  /** Owner view: msat totals plus USD strings (null when the rate is unavailable: hide, don't guess). */
  function balance(): { msat: Balance; paid_requests: number; usd: { collected: string; available: string } | null } {
    const now = o.now();
    const b = ledger.balance(o.site);
    const fx = o.fx.quote(now);
    const collected = usdDisplay(b.gross_msat, fx, now);
    const available = usdDisplay(b.available_msat, fx, now);
    return { msat: b, paid_requests: settledCount, usd: collected !== null && available !== null ? { collected, available } : null };
  }

  /**
   * Switch new offers on or off. Offers already issued can still be redeemed (the client may have
   * paid already); one payment still buys one pass.
   */
  function setCollecting(on: boolean) {
    collecting = on;
  }

  /** USD string for an owner amount (null when the rate is unavailable). */
  function usd(msat: number): string | null {
    const now = o.now();
    return usdDisplay(msat, o.fx.quote(now), now);
  }

  return { offers, redeemPaid, status, balance, usd, setCollecting, isCollecting: () => collecting, replayRejected: () => replayRejected, ledger, recent: () => [...recent], isDegraded: () => degraded, fee_bps: o.fee_bps };
}

export type SettlementRail = ReturnType<typeof createSettlementRail>;
