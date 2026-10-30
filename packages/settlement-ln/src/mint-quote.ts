// Second offer beside Cashu. The invoice is a NUT-04 quote on the mint the Cashu offer already uses.
// A NUT-04 quote is quote, request, state, and expiry. It has no preimage field. Whether a public
// mint adds one is unverified, so this path never asks the mint for it. The payer proves
// sha256(preimage) equals the payment hash sealed with the price, the action, and the expiry.
// Mint state ISSUED is not payment. Toll's own quote row, written with the proofs and the
// single-use mark, is the proof. No node, and no second place that holds funds.
import {
  type ActionClass, TollError, canonicalJson, fromB64url, fromHex, fromUtf8, hmacSha256, hmacVerify, randomHex, sha256, timingSafeEqual, toB64url, utf8,
} from "../../protocol/src/index.ts";
import type { Paid, PaidClass, QuoteOffer, SettlementEngine } from "./engine.ts";

const PREFIX = "toll-mint-quote-v1.";
const TIMEOUT_MS = 1500;

/** Method name carried in a manifest payment object. The word stays in this package. */
export const QUOTE_KIND = "l402" as const;

export interface HeldProof { amount: number; secret: string; id: string; C: string }

interface Caveats {
  v: 1; offer_id: string; site: string; cls: ActionClass; amount_msat: number;
  payment_hash: string; quote: string; mint: string; exp: number;
}

/** Loopback invoice only. Not a bolt11 decoder and not for a public mint. */
export function invoiceFor(amountSats: number, paymentHash: string): string {
  return `lnbc${amountSats * 10}n1${paymentHash}`;
}

/** LOOPBACK ONLY. A real bolt11 invoice does not match and is refused. */
export function paymentHashOf(invoice: string): string {
  const m = /^lnbc\d+n1([0-9a-f]{64})$/.exec(invoice);
  if (!m) throw new TollError("malformed");
  return m[1];
}

async function seal(secret: string, c: Caveats): Promise<string> {
  const payload = toB64url(utf8(canonicalJson(c)));
  const mac = await hmacSha256(secret, utf8(PREFIX + payload));
  return payload + "." + toB64url(mac);
}

async function open(secret: string, token: string): Promise<Caveats> {
  const [payload, macB64, extra] = token.split(".");
  if (!payload || !macB64 || extra !== undefined) throw new TollError("malformed");
  let mac: Uint8Array;
  try { mac = fromB64url(macB64); } catch { throw new TollError("malformed"); }
  if (!(await hmacVerify(secret, utf8(PREFIX + payload), mac))) throw new TollError("bad_sig");
  let c: Caveats;
  try { c = JSON.parse(fromUtf8(fromB64url(payload))); } catch { throw new TollError("malformed"); }
  if (c.v !== 1 || typeof c.offer_id !== "string" || typeof c.quote !== "string" || typeof c.payment_hash !== "string" || typeof c.cls !== "string") throw new TollError("malformed");
  return c;
}

/** Offer id from the token payload. The seal is checked later, in open(). */
export function offerIdOf(token: string): string {
  const payload = token.split(".")[0];
  if (!payload) throw new TollError("malformed");
  let c: { offer_id?: unknown };
  try { c = JSON.parse(fromUtf8(fromB64url(payload))); } catch { throw new TollError("malformed"); }
  if (typeof c.offer_id !== "string" || c.offer_id === "") throw new TollError("malformed");
  return c.offer_id;
}

async function readJson(url: string, init: RequestInit | undefined, fetchImpl: typeof fetch): Promise<{ status: number; body: Record<string, unknown> }> {
  let r: Response;
  try { r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }); } catch { throw new TollError("store_unavailable"); }
  const text = await r.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { body = {}; }
  return { status: r.status, body };
}

export interface MintQuoteRow {
  quote: string;
  action: string;
  amount: number;
  mint: string;
  proofs: HeldProof[];
}

export async function mintQuoteOffer(o: {
  secret: string; mint: string; site: string; cls: PaidClass; amount_msat: number; now: number; ttl_s?: number;
  fetchImpl?: typeof fetch;
}): Promise<QuoteOffer> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const created = await readJson(o.mint + "/v1/mint/quote/bolt11", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount: o.amount_msat / 1000, unit: "sat" }),
  }, fetchImpl);
  const quote = created.body.quote;
  const request = created.body.request;
  if (created.status !== 200 || typeof quote !== "string" || typeof request !== "string") throw new TollError("store_unavailable");
  if ("preimage" in created.body || "payment_preimage" in created.body) throw new TollError("store_unavailable");
  const ttl = Math.min(o.ttl_s ?? 120, 120);
  const exp = o.now + ttl;
  const id = "off_" + randomHex(12);
  const macaroon = await seal(o.secret, {
    v: 1, offer_id: id, site: o.site, cls: o.cls, amount_msat: o.amount_msat,
    payment_hash: paymentHashOf(request), quote, mint: o.mint, exp,
  });
  return { id, kind: QUOTE_KIND, amount_msat: o.amount_msat, invoice: request, macaroon, exp };
}

function asProofs(rows: unknown, amount: number): HeldProof[] | null {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 8) return null;
  const out: HeldProof[] = [];
  for (const row of rows) {
    if (!Number.isSafeInteger(row?.amount) || row.amount <= 0) return null;
    if (typeof row?.secret !== "string" || typeof row?.id !== "string" || typeof row?.C !== "string") return null;
    out.push({ amount: row.amount, secret: row.secret, id: row.id, C: row.C });
  }
  return out.reduce((n, p) => n + p.amount, 0) === amount ? out : null;
}

export async function verifyMintQuote(o: {
  secret: string; mint: string; site: string; action: ActionClass; offer_id: string; macaroon: string; preimage: string; now: number;
  fetchImpl?: typeof fetch;
  has: (quote: string) => Promise<boolean>;
  claim: (row: MintQuoteRow) => Promise<boolean>;
  noteLoss: (x: { quote: string; action: string; amount: number }) => Promise<void>;
}): Promise<Paid> {
  if (!/^[0-9a-f]{64}$/.test(o.preimage)) throw new TollError("malformed");
  const fetchImpl = o.fetchImpl ?? fetch;
  const c = await open(o.secret, o.macaroon);
  if (c.offer_id !== o.offer_id || c.mint !== o.mint) throw new TollError("bad_sig");
  if (c.site !== o.site) throw new TollError("wrong_site");
  if (c.cls !== o.action) throw new TollError("wrong_action");
  if (!Number.isSafeInteger(c.amount_msat) || c.amount_msat % 1000 !== 0) throw new TollError("bad_sig");
  const got = await sha256(fromHex(o.preimage));
  // MINT_QUOTE_GUARD preimage: the payer's preimage must hash to the sealed payment hash.
  if (!timingSafeEqual(got, fromHex(c.payment_hash))) throw new TollError("bad_solution");
  const looked = await readJson(o.mint + "/v1/mint/quote/bolt11/" + encodeURIComponent(c.quote), undefined, fetchImpl);
  const state = typeof looked.body.state === "string" ? looked.body.state : "";
  if (looked.status !== 200 || looked.body.quote !== c.quote) throw new TollError(looked.status === 200 ? "bad_solution" : "store_unavailable");
  const amount = c.amount_msat / 1000;
  if (o.now > c.exp) {
    if ((state === "PAID" || state === "ISSUED") && !(await o.has(c.quote))) await o.noteLoss({ quote: c.quote, action: c.cls, amount });
    throw new TollError("expired");
  }
  if (await o.has(c.quote)) throw new TollError("replay");
  if (state !== "PAID" && state !== "ISSUED") throw new TollError("bad_solution");
  // MINT_QUOTE_GUARD issued: mint state ISSUED is not payment when this store has no row.
  if (state === "ISSUED") throw new TollError("bad_solution");
  const minted = await readJson(o.mint + "/v1/mint/bolt11", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quote: c.quote }),
  }, fetchImpl);
  const proofs = minted.status === 200 ? asProofs(minted.body.proofs, amount) : null;
  if (!proofs) throw new TollError("store_unavailable");
  // MINT_QUOTE_GUARD replay: the row, the proofs, and the single-use mark are one store call.
  try {
    if (!(await o.claim({ quote: c.quote, action: c.cls, amount, mint: c.mint, proofs }))) throw new TollError("replay");
  } catch (e) {
    if (e instanceof TollError && e.code === "replay") throw e;
    await o.noteLoss({ quote: c.quote, action: c.cls, amount });
    throw e;
  }
  return { cls: c.cls, amount_msat: c.amount_msat, payment_ref: c.payment_hash };
}

/** Adds the loopback quote offer onto a Cashu engine. The fetch must already target the test mint. */
export function withQuoteOffer(base: SettlementEngine, o: { secret: string; mint: string; fetchImpl: typeof fetch }): SettlementEngine {
  return {
    kind: base.kind,
    offer: (x) => base.offer(x),
    healthy: () => base.healthy(),
    mintQuote: (x) => mintQuoteOffer({ ...x, secret: o.secret, mint: o.mint, fetchImpl: o.fetchImpl }),
    async verifyPaid(x) {
      if (x.proof.kind === "cashu" || !("preimage" in x.proof)) return base.verifyPaid(x);
      if (!x.action || !x.hasMintQuote || !x.claimMintQuote || !x.noteMintQuoteLoss) throw new TollError("malformed");
      return verifyMintQuote({
        secret: o.secret, mint: o.mint, site: x.site, action: x.action, offer_id: x.proof.offer_id,
        macaroon: x.proof.credential, preimage: x.proof.preimage, now: x.now, fetchImpl: o.fetchImpl,
        has: x.hasMintQuote, claim: x.claimMintQuote, noteLoss: x.noteMintQuoteLoss,
      });
    },
  };
}
