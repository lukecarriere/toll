// Second offer beside Cashu. The invoice is a NUT-04 quote on the mint the Cashu offer already uses.
// A NUT-04 quote is quote, request, state, and expiry. It has no preimage field. Whether a public
// mint adds one is unverified, so this path never asks the mint for it. The payer proves
// sha256(preimage) equals the payment hash sealed with the price, the action, and the expiry.
// The mint proves payment when that quote id is PAID or ISSUED. Toll then mints the proofs into
// its own store. No node, and no second place that holds funds.
import {
  type ActionClass, TollError, canonicalJson, fromB64url, fromHex, fromUtf8, hmacSha256, hmacVerify, randomHex, sha256, timingSafeEqual, toB64url, utf8,
} from "../../protocol/src/index.ts";
import type { LnOffer, Paid, PaidClass } from "./engine.ts";

const PREFIX = "toll-mint-quote-v1.";
const TIMEOUT_MS = 1500;

/** Method name carried in a manifest payment object. The word stays in this package. */
export const QUOTE_KIND = "l402";

export interface HeldProof { amount: number; secret: string; id: string; C: string }

interface Caveats {
  v: 1; offer_id: string; site: string; cls: ActionClass; amount_msat: number;
  payment_hash: string; quote: string; mint: string; exp: number;
}

/** Loopback invoice: bolt11-style amount, then the payment hash. */
export function invoiceFor(amountSats: number, paymentHash: string): string {
  return `lnbc${amountSats * 10}n1${paymentHash}`;
}

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

async function readJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  let r: Response;
  try { r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }); } catch { throw new TollError("store_unavailable"); }
  const text = await r.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  return { status: r.status, body };
}

export async function mintQuoteOffer(o: {
  secret: string; mint: string; site: string; cls: PaidClass; amount_msat: number; now: number; ttl_s?: number;
}): Promise<LnOffer> {
  const created = await readJson(o.mint + "/v1/mint/quote/bolt11", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount: o.amount_msat / 1000, unit: "sat" }),
  });
  const quote = created.body?.quote;
  const request = created.body?.request;
  if (created.status !== 200 || typeof quote !== "string" || typeof request !== "string") throw new TollError("store_unavailable");
  if ("preimage" in created.body || "payment_preimage" in created.body) throw new TollError("store_unavailable");
  const ttl = Math.min(o.ttl_s ?? 120, 120);
  const exp = o.now + ttl;
  const id = "off_" + randomHex(12);
  const macaroon = await seal(o.secret, {
    v: 1, offer_id: id, site: o.site, cls: o.cls, amount_msat: o.amount_msat,
    payment_hash: paymentHashOf(request), quote, mint: o.mint, exp,
  });
  return { id, kind: "ln402", amount_msat: o.amount_msat, invoice: request, macaroon, exp };
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
  firstUse: (key: string, ttl_s: number) => Promise<boolean>;
  held: (quote: string) => HeldProof[] | undefined;
  hold: (quote: string, proofs: HeldProof[]) => void;
}): Promise<Paid> {
  if (!/^[0-9a-f]{64}$/.test(o.preimage)) throw new TollError("malformed");
  const c = await open(o.secret, o.macaroon);
  if (c.offer_id !== o.offer_id || c.mint !== o.mint) throw new TollError("bad_sig");
  if (c.site !== o.site) throw new TollError("wrong_site");
  if (o.now > c.exp) throw new TollError("expired");
  if (c.cls !== o.action) throw new TollError("wrong_action");
  if (!Number.isSafeInteger(c.amount_msat) || c.amount_msat % 1000 !== 0) throw new TollError("bad_sig");
  const got = await sha256(fromHex(o.preimage));
  // MINT_QUOTE_GUARD preimage: the payer's preimage must hash to the sealed payment hash.
  if (!timingSafeEqual(got, fromHex(c.payment_hash))) throw new TollError("bad_solution");
  const quote = await readJson(o.mint + "/v1/mint/quote/bolt11/" + encodeURIComponent(c.quote));
  const state = quote.body?.state;
  if (quote.status !== 200 || quote.body?.quote !== c.quote || (state !== "PAID" && state !== "ISSUED")) throw new TollError(quote.status === 200 ? "bad_solution" : "store_unavailable");
  const amount = c.amount_msat / 1000;
  let proofs = o.held(c.quote);
  if (!proofs) {
    const minted = await readJson(o.mint + "/v1/mint/bolt11", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quote: c.quote }),
    });
    proofs = minted.status === 200 ? asProofs(minted.body?.proofs, amount) ?? undefined : undefined;
    if (!proofs) throw new TollError("store_unavailable");
    o.hold(c.quote, proofs);
  }
  const ttl = Math.max(1, c.exp - o.now + 60);
  // MINT_QUOTE_GUARD replay: one quote grants one pass.
  if (!(await o.firstUse("mq:" + c.quote, ttl))) throw new TollError("replay");
  return { cls: c.cls, amount_msat: c.amount_msat, payment_ref: c.payment_hash };
}
