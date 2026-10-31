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

interface OfferBase {
  id: string;
  amount_msat: number;
  display?: { usd: string; label: string };
  exp: number;
}

/** Lightning offer (spec §8.6). The credential is opaque to Toll. */
export interface LnOffer extends OfferBase {
  kind: "ln402";
  invoice: string;
  /** Engine-issued credential (a real macaroon only ever comes from the engine). Opaque. */
  macaroon: string;
}

/**
 * Test-only Cashu offer (NUT-24). `request` is the `creqA` payment request carried in `X-Cashu`.
 * `credential` is the opaque seal the client returns with the `cashuA` or `cashuB` token.
 */
export interface CashuOffer extends OfferBase {
  kind: "cashu";
  request: string;
  credential: string;
  mint: string;
  unit: "sat";
  amount: number;
}

/** Mint-quote offer. `kind` is `l402`. The invoice is the loopback stand-in, or a real one when the production flag is on. */
export interface QuoteOffer extends OfferBase {
  kind: "l402";
  invoice: string;
  macaroon: string;
}

/** What a client is offered on 402. */
export type Offer = LnOffer | CashuOffer | QuoteOffer;

/** Lightning proof: `Authorization: L402 <credential>:<preimage>`. */
export interface LnPaidProof {
  kind?: "ln402" | "l402";
  offer_id: string;
  credential: string;
  preimage: string;
}

/** Cashu proof: a `cashuA` or `cashuB` token plus the offer seal. Accepted only after a mint call. */
export interface CashuPaidProof {
  kind: "cashu";
  offer_id: string;
  credential: string;
  token: string;
}

export type PaidProof = LnPaidProof | CashuPaidProof;

export interface Paid {
  cls: ActionClass;
  amount_msat: number;
  /** Stable reference for the ledger's duplicate guard (payment hash). */
  payment_ref: string;
}

export interface SettlementEngine {
  readonly kind: "stub" | "proxy" | "cashu";
  /** Mint an offer for a class at a price Toll chose (Toll is the price source). */
  offer(o: { site: string; cls: PaidClass; amount_msat: number; now: number; ttl_s?: number }): Promise<Offer>;
  /** Verify a paid retry. One payment -> one pass: replays are rejected. `action` is the route being paid. */
  verifyPaid(o: {
    site: string; proof: PaidProof; now: number; action?: ActionClass;
    firstUse: (key: string, ttl_s: number) => Promise<boolean>;
    hasMintQuote?: (quote: string) => Promise<boolean>;
    claimMintQuote?: (row: { quote: string; action: string; amount: number; mint: string; proofs: { amount: number; secret: string; id: string; C: string }[] }) => Promise<boolean>;
    noteMintQuoteLoss?: (x: { quote: string; action: string; amount: number }) => Promise<void>;
  }): Promise<Paid>;
  /** Second offer from a NUT-04 quote on the Cashu mint. Absent unless the test hook or the production flag is on. */
  mintQuote?(o: { site: string; cls: PaidClass; amount_msat: number; now: number; ttl_s?: number }): Promise<QuoteOffer>;
  /** Health for the degraded-mode switch (spec §8.6.8): when false, offers are [] and work still flows. */
  healthy(): Promise<boolean>;
}

/** Parse `Authorization: L402 <credential>:<preimage>` (also accepts the legacy `LSAT` scheme). */
export function parseL402Authorization(header: string | undefined, offer_id: string): PaidProof | null {
  const m = /^(?:L402|LSAT)\s+([^:\s]+):([0-9a-f]{64})$/i.exec((header ?? "").trim());
  return m ? { offer_id, credential: m[1], preimage: m[2].toLowerCase() } : null;
}

/** `WWW-Authenticate` value for a Lightning 402 to agents (settlement.md Q2). */
export function l402Challenge(offer: Offer): string {
  if (offer.kind !== "ln402" && offer.kind !== "l402") throw new Error("L402 challenge requires an invoice offer");
  return `L402 macaroon="${offer.macaroon}", invoice="${offer.invoice}"`;
}

/**
 * Where an agent fetches the work challenge a 402 links to (docs/settlement.md §4). Root-relative,
 * resolved against the issuer origin. `offers=0` asks for the challenge only (no second invoice).
 */
export function workChallengeUrl(site: string, action: string, path: string): string {
  return "/v1/challenge?" + new URLSearchParams({ site, action, path, client: "agent", offers: "0" }).toString();
}

/**
 * The agent 402 (docs/settlement.md §4): offers to pay plus a link to the work challenge, which is
 * minted only if the agent fetches it. Key order is fixed: error, challenge_url, offers.
 */
export function paymentRequired(site: string, action: string, path: string, offers: Offer[]): { status: 402; headers: Record<string, string>; body: { error: "payment_required"; challenge_url: string; offers: Offer[] } } {
  if (offers.length === 0) throw new Error("a 402 needs at least one offer");
  const cashu = offers.find((o) => o.kind === "cashu");
  const ln = offers.find((o) => o.kind === "ln402" || o.kind === "l402");
  if (!cashu && !ln) throw new Error("a 402 needs a cashu or invoice offer");
  // Cashu stays the NUT-24 header. A mint-quote offer adds WWW-Authenticate on the same 402.
  // Any other combination still sends the one header it always sent.
  const headers: Record<string, string> = {};
  const expose: string[] = [];
  if (cashu) { headers["x-cashu"] = cashu.request; expose.push("x-cashu"); }
  if (ln) { headers["www-authenticate"] = l402Challenge(ln); expose.push("www-authenticate"); }
  headers["access-control-expose-headers"] = expose.join(", ");
  return {
    status: 402,
    headers,
    body: { error: "payment_required", challenge_url: workChallengeUrl(site, action, path), offers },
  };
}
