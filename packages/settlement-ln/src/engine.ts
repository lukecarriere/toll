// Settlement engine interface (Amendment 1, docs/adapters.md §2). Toll never writes macaroon or
// payment-channel code: a settlement engine issues the offer credential and proves payment.
//
// The shape follows the chosen engine, an L402 reverse proxy with a dynamic price source:
//   - Toll is the PRICE SOURCE: the engine asks Toll what a path costs (`priceFor`).
//   - The engine issues the 402 offer (invoice + credential) and, on retry, verifies the paid
//     credential before the request reaches Toll.
//   - Toll then mints its own pass and records the payment in the msat ledger.
// Phase 1 builds only the stub engine (tests, CI, demo) and a stub client for the proxy engine
// that refuses to run outside stub mode. No real funds, no network.
import type { ActionClass } from "../../protocol/src/index.ts";

export type PaidClass = Exclude<ActionClass, "read">;

/** What a client is offered on 402 (spec §8.6 offer object). `credential` is opaque to Toll. */
export interface Offer {
  id: string;
  kind: "ln402";
  amount_msat: number;
  display?: { usd: string; label: string };
  invoice: string;
  /** Engine-issued credential (a real macaroon only ever comes from the engine). Opaque. */
  macaroon: string;
  exp: number;
}

/** Proof of payment presented on retry: `Authorization: L402 <credential>:<preimage>`. */
export interface PaidProof {
  offer_id: string;
  credential: string;
  preimage: string;
}

export interface Paid {
  cls: ActionClass;
  amount_msat: number;
  /** Stable reference for the ledger's duplicate guard (payment hash). */
  payment_ref: string;
}

export interface SettlementEngine {
  readonly kind: "stub" | "proxy";
  /** Mint an offer for a class at a price Toll chose (Toll is the price source). */
  offer(o: { site: string; cls: PaidClass; amount_msat: number; now: number; ttl_s?: number }): Promise<Offer>;
  /** Verify a paid retry. One payment -> one pass: replays are rejected. */
  verifyPaid(o: { site: string; proof: PaidProof; now: number; firstUse: (key: string, ttl_s: number) => Promise<boolean> }): Promise<Paid>;
  /** Health for the degraded-mode switch (spec §8.6.8): when false, offers are [] and work still flows. */
  healthy(): Promise<boolean>;
}

/** Parse `Authorization: L402 <credential>:<preimage>` (also accepts the legacy `LSAT` scheme). */
export function parseL402Authorization(header: string | undefined, offer_id: string): PaidProof | null {
  const m = /^(?:L402|LSAT)\s+([^:\s]+):([0-9a-f]{64})$/i.exec((header ?? "").trim());
  return m ? { offer_id, credential: m[1], preimage: m[2].toLowerCase() } : null;
}

/** `WWW-Authenticate` value for a 402 to agents (settlement.md Q2). */
export function l402Challenge(offer: Offer): string {
  return `L402 macaroon="${offer.macaroon}", invoice="${offer.invoice}"`;
}
