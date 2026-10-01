// L402-shaped offers (draft, spec §8.6). docs/settlement.md is the normative text.
//
// macaroon (v1 draft) = base64url(canonical JSON caveats) "." base64url(HMAC-SHA256(secret, "toll-offer-v1." + payload))
// caveats = { v, offer_id, site, cls, amount_msat, payment_hash, exp }
// Binding offer_id and payment_hash inside the HMAC stops invoice substitution (spec §16).
import {
  type ActionClass, TollError, canonicalJson, fromB64url, fromHex, fromUtf8, hmacSha256, hmacVerify, randomHex, sha256, timingSafeEqual, toB64url, utf8,
} from "../../protocol/src/index.ts";
import type { Settler } from "./stub-settler.ts";

export const BASE_MSAT: Record<Exclude<ActionClass, "read">, number> = { search: 2000, write: 10000, account: 25000, admin: 100000 };
export const MAX_OFFER_TTL_S = 120;

export interface Offer {
  id: string;
  kind: "ln402";
  amount_msat: number;
  display?: { usd: string; label: string };
  invoice: string;
  macaroon: string;
  exp: number;
}

interface Caveats { v: 1; offer_id: string; site: string; cls: ActionClass; amount_msat: number; payment_hash: string; exp: number }

export function priceMsat(cls: Exclude<ActionClass, "read">, velocity_mult = 1, suspicion_mult = 1): number {
  return Math.round(BASE_MSAT[cls] * velocity_mult * suspicion_mult);
}

async function sealCaveats(secret: string, c: Caveats): Promise<string> {
  const payload = toB64url(utf8(canonicalJson(c)));
  const mac = await hmacSha256(secret, utf8("toll-offer-v1." + payload));
  return payload + "." + toB64url(mac);
}

export async function mintOffer(o: { secret: string; site: string; cls: Exclude<ActionClass, "read">; amount_msat: number; settler: Settler; now: number; ttl_s?: number }): Promise<Offer> {
  const ttl = Math.min(o.ttl_s ?? MAX_OFFER_TTL_S, MAX_OFFER_TTL_S);
  const id = "off_" + randomHex(12);
  const inv = await o.settler.mintInvoice({ amount_msat: o.amount_msat, memo: id, expiry_s: ttl, now: o.now });
  const exp = o.now + ttl;
  const macaroon = await sealCaveats(o.secret, { v: 1, offer_id: id, site: o.site, cls: o.cls, amount_msat: o.amount_msat, payment_hash: inv.payment_hash, exp });
  return { id, kind: "ln402", amount_msat: o.amount_msat, invoice: inv.invoice, macaroon, exp };
}

/**
 * Verify a paid redeem without a node round-trip: the preimage must hash to the payment_hash
 * committed in the macaroon. `firstUse` enforces one invoice -> one redeem -> one pass.
 */
export async function verifyPaidRedeem(o: {
  secret: string; site: string; offer_id: unknown; preimage: unknown; macaroon: unknown; now: number;
  firstUse: (key: string, ttl_s: number) => Promise<boolean>;
}): Promise<{ cls: ActionClass; amount_msat: number; payment_hash: string }> {
  if (typeof o.macaroon !== "string" || typeof o.preimage !== "string" || typeof o.offer_id !== "string") throw new TollError("malformed");
  if (!/^[0-9a-f]{64}$/.test(o.preimage)) throw new TollError("malformed", "preimage must be 32 bytes hex");
  const [payload, macB64, extra] = o.macaroon.split(".");
  if (!payload || !macB64 || extra !== undefined) throw new TollError("malformed");
  let mac: Uint8Array;
  try { mac = fromB64url(macB64); } catch { throw new TollError("malformed"); }
  if (!(await hmacVerify(o.secret, utf8("toll-offer-v1." + payload), mac))) throw new TollError("bad_sig");
  let c: Caveats;
  try { c = JSON.parse(fromUtf8(fromB64url(payload))); } catch { throw new TollError("malformed"); }
  if (c.v !== 1 || c.offer_id !== o.offer_id) throw new TollError("bad_sig", "offer_id does not match macaroon");
  if (c.site !== o.site) throw new TollError("wrong_site");
  if (o.now > c.exp) throw new TollError("expired");
  const hash = await sha256(fromHex(o.preimage));
  if (!timingSafeEqual(hash, fromHex(c.payment_hash))) throw new TollError("bad_solution", "preimage does not match payment hash");
  if (!(await o.firstUse("offer:" + c.offer_id, c.exp - o.now + 60))) throw new TollError("replay");
  return { cls: c.cls, amount_msat: c.amount_msat, payment_hash: c.payment_hash };
}
