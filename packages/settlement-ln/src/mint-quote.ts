// Second offer beside Cashu. The invoice is a NUT-04 quote on the mint the Cashu offer already uses.
// A NUT-04 quote is quote, request, state, and expiry. It has no preimage field. Whether a public
// mint adds one is unverified, so this path never asks the mint for it. The payer proves
// sha256(preimage) equals the payment hash sealed with the price, the action, and the expiry.
// Mint state ISSUED is not payment. Toll's own quote row, written with the proofs and the
// single-use mark, is the proof. No node, and no second place that holds funds.
// The loopback invoice is the test mint's stand-in. A real invoice is read only in bolt11 mode,
// which production turns on with L402_ENABLED and leaves off otherwise.
import {
  type ActionClass, TollError, canonicalJson, fromB64url, fromHex, fromUtf8, hmacSha256, hmacVerify, randomBytes, randomHex, sha256, timingSafeEqual, toB64url, toHex, utf8,
} from "../../protocol/src/index.ts";
import { decodeBolt11 } from "./bolt11.ts";
import { blindMessage, deriveKeysetIdV2, splitAmount, unblind } from "./cashu-crypto.ts";
import { type MintGuard, mintFetch } from "./cashu-net.ts";
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

/**
 * Payment hash of a real invoice whose amount is exactly `amountMsat`.
 * A loopback stand-in does not decode and is refused. Mainnet only: a testnet invoice is not this price.
 */
export function paymentHashOfBolt11(invoice: string, amountMsat: number): string {
  const decoded = decodeBolt11(invoice);
  if (decoded.network !== "bc" || decoded.amountMsat !== amountMsat) throw new TollError("malformed");
  return decoded.paymentHash;
}

/** `L402_ENABLED=1` is the only on value. Anything else, including unset, is off. */
export function l402Enabled(flag: string | undefined): boolean {
  return flag === "1";
}

/**
 * Which quote invoice this process may offer.
 * The production flag wins over the test hook so a hooked worker can still exercise a real invoice.
 * Neither flag: no quote offer, and the 402 stays the cashu offer alone.
 */
export function quoteMode(flags: { L402_ENABLED?: string; TOLL_TEST_HOOKS?: string }): "off" | "loopback" | "bolt11" {
  if (l402Enabled(flags.L402_ENABLED)) return "bolt11";
  if (flags.TOLL_TEST_HOOKS === "1") return "loopback";
  return "off";
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
  mode?: "loopback" | "bolt11";
  guard?: MintGuard;
  allowlist?: string[];
}): Promise<QuoteOffer> {
  const mode = o.mode ?? "loopback";
  const fetchImpl = o.fetchImpl ?? fetch;
  const created = await readMint(o.mint, "/v1/mint/quote/bolt11", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount: o.amount_msat / 1000, unit: "sat" }),
  }, fetchImpl, mode, o.guard, o.allowlist);
  const quote = created.body.quote;
  const request = created.body.request;
  if (created.status !== 200 || typeof quote !== "string" || typeof request !== "string") throw new TollError("store_unavailable");
  if ("preimage" in created.body || "payment_preimage" in created.body) throw new TollError("store_unavailable");
  const ttl = Math.min(o.ttl_s ?? 120, 120);
  const exp = o.now + ttl;
  const id = "off_" + randomHex(12);
  const payment_hash = mode === "bolt11" ? paymentHashOfBolt11(request, o.amount_msat) : paymentHashOf(request);
  const macaroon = await seal(o.secret, {
    v: 1, offer_id: id, site: o.site, cls: o.cls, amount_msat: o.amount_msat,
    payment_hash, quote, mint: o.mint, exp,
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
  mode?: "loopback" | "bolt11";
  guard?: MintGuard;
  allowlist?: string[];
  has: (quote: string) => Promise<boolean>;
  reserve: (row: { quote: string; action: string; amount: number; mint: string }) => Promise<boolean>;
  finish: (row: { quote: string; proofs: HeldProof[] }) => Promise<boolean>;
  noteLoss: (x: { quote: string; action: string; amount: number }) => Promise<void>;
}): Promise<Paid> {
  const bare = o.preimage === "";
  if (!bare && !/^[0-9a-f]{64}$/.test(o.preimage)) throw new TollError("malformed");
  const mode = o.mode ?? "loopback";
  const fetchImpl = o.fetchImpl ?? fetch;
  const c = await open(o.secret, o.macaroon);
  if (c.offer_id !== o.offer_id || c.mint !== o.mint) throw new TollError("bad_sig");
  if (c.site !== o.site) throw new TollError("wrong_site");
  if (c.cls !== o.action) throw new TollError("wrong_action");
  if (!Number.isSafeInteger(c.amount_msat) || c.amount_msat % 1000 !== 0) throw new TollError("bad_sig");
  if (!bare) {
    const got = await sha256(fromHex(o.preimage));
    // MINT_QUOTE_GUARD preimage: the payer's preimage must hash to the sealed payment hash.
    if (!timingSafeEqual(got, fromHex(c.payment_hash))) throw new TollError("bad_solution");
  }
  const looked = await readMint(o.mint, "/v1/mint/quote/bolt11/" + encodeURIComponent(c.quote), undefined, fetchImpl, mode, o.guard, o.allowlist);
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
  // The single-use mark lands before the mint is asked to sign, so eight retries mint once.
  if (!(await o.reserve({ quote: c.quote, action: c.cls, amount, mint: c.mint }))) throw new TollError("replay");
  try {
    const proofs = mode === "bolt11"
      ? await mintBlinded(o.mint, c.quote, amount, fetchImpl, o.guard, o.allowlist)
      : await mintLoopback(o.mint, c.quote, amount, fetchImpl);
    if (!proofs) throw new TollError("store_unavailable");
    // The proofs and the used mark are one store call. A second finish is a replay.
    if (!(await o.finish({ quote: c.quote, proofs }))) throw new TollError("replay");
  } catch (e) {
    if (e instanceof TollError && e.code === "replay") throw e;
    await o.noteLoss({ quote: c.quote, action: c.cls, amount });
    throw e;
  }
  return { cls: c.cls, amount_msat: c.amount_msat, payment_ref: c.payment_hash };
}

/** Adds the quote offer onto a Cashu engine. `bolt11` talks to an allowlisted mint. `loopback` is the test stand-in. */
export function withQuoteOffer(base: SettlementEngine, o: {
  secret: string; mint: string; fetchImpl: typeof fetch;
  mode?: "loopback" | "bolt11";
  guard?: MintGuard;
  allowlist?: string[];
}): SettlementEngine {
  const mode = o.mode ?? "loopback";
  const bound = { secret: o.secret, mint: o.mint, fetchImpl: o.fetchImpl, mode, guard: o.guard, allowlist: o.allowlist };
  return {
    kind: base.kind,
    offer: (x) => base.offer(x),
    healthy: () => base.healthy(),
    mintQuote: (x) => mintQuoteOffer({ ...x, ...bound }),
    async verifyPaid(x) {
      if (x.proof.kind === "cashu" || !("preimage" in x.proof)) return base.verifyPaid(x);
      if (!x.action || !x.hasMintQuote || !x.reserveMintQuote || !x.finishMintQuote || !x.noteMintQuoteLoss) throw new TollError("malformed");
      return verifyMintQuote({
        ...bound, site: x.site, action: x.action, offer_id: x.proof.offer_id,
        macaroon: x.proof.credential, preimage: x.proof.preimage, now: x.now,
        has: x.hasMintQuote, reserve: x.reserveMintQuote, finish: x.finishMintQuote, noteLoss: x.noteMintQuoteLoss,
      });
    },
  };
}

async function readMint(
  mint: string, path: string, init: RequestInit | undefined, fetchImpl: typeof fetch,
  mode: "loopback" | "bolt11", guard: MintGuard | undefined, allowlist: string[] | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (mode !== "bolt11") return readJson(mint + path, init, fetchImpl);
  const got = await mintFetch(mint, path, init ?? { method: "GET" }, { ...guard, fetch: fetchImpl }, allowlist ?? [mint]);
  return { status: got.status, body: objectBody(got.text) };
}

async function mintLoopback(mint: string, quote: string, amount: number, fetchImpl: typeof fetch): Promise<HeldProof[] | null> {
  const minted = await readJson(mint + "/v1/mint/bolt11", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quote }),
  }, fetchImpl);
  return minted.status === 200 ? asProofs(minted.body.proofs, amount) : null;
}

/**
 * NUT-04 mint. The mint returns blind signatures, not proofs. Outputs are built here, unblinded,
 * and only then handed to the one store call. A failure before that call stores nothing.
 */
async function mintBlinded(
  mint: string, quote: string, amount: number, fetchImpl: typeof fetch,
  guard: MintGuard | undefined, allowlist: string[] | undefined,
): Promise<HeldProof[] | null> {
  const listed = await mintFetch(mint, "/v1/keysets", { method: "GET" }, { ...guard, fetch: fetchImpl }, allowlist ?? [mint]);
  if (listed.status !== 200) return null;
  const rows = objectBody(listed.text).keysets;
  if (!Array.isArray(rows)) return null;
  const active = rows.map((k) => {
    const row = k as { id?: unknown; unit?: unknown; active?: unknown; input_fee_ppk?: unknown; final_expiry?: unknown; keys?: unknown };
    return {
      id: typeof row.id === "string" ? row.id.toLowerCase() : "",
      unit: typeof row.unit === "string" ? row.unit : "",
      active: row.active === true,
      input_fee_ppk: Number.isSafeInteger(row.input_fee_ppk) ? row.input_fee_ppk as number : 0,
      final_expiry: Number.isSafeInteger(row.final_expiry) ? row.final_expiry as number : null,
    };
  }).find((k) => k.active && k.unit === "sat" && k.id.startsWith("01") && k.id.length === 66);
  if (!active) return null;
  const keysRes = await mintFetch(mint, "/v1/keys/" + active.id, { method: "GET" }, { ...guard, fetch: fetchImpl }, allowlist ?? [mint]);
  if (keysRes.status !== 200) return null;
  const keyRow = objectBody(keysRes.text).keysets;
  const keysRaw = Array.isArray(keyRow) && keyRow[0] && typeof keyRow[0] === "object" ? (keyRow[0] as { keys?: unknown }).keys : undefined;
  if (!keysRaw || typeof keysRaw !== "object") return null;
  const keys: Record<string, string> = {};
  for (const [amt, pk] of Object.entries(keysRaw)) if (typeof pk === "string") keys[amt] = pk.toLowerCase();
  let derived: string;
  try { derived = deriveKeysetIdV2(keys, "sat", active.input_fee_ppk, active.final_expiry); } catch { return null; }
  if (derived !== active.id) return null;
  const amounts = splitAmount(amount, Object.keys(keys).map(Number));
  if (!amounts) return null;
  const blinded = amounts.map((amt) => {
    const b = blindMessage(toHex(randomBytes(32)));
    return { amount: amt, id: active.id, secret: b.secret, r: b.r, B_: b.B_ };
  });
  const minted = await mintFetch(mint, "/v1/mint/bolt11", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quote, outputs: blinded.map((b) => ({ amount: b.amount, id: b.id, B_: b.B_ })) }),
  }, { ...guard, fetch: fetchImpl }, allowlist ?? [mint]);
  if (minted.status !== 200) return null;
  const signatures = objectBody(minted.text).signatures;
  if (!Array.isArray(signatures) || signatures.length !== blinded.length) return null;
  const proofs: HeldProof[] = [];
  for (let i = 0; i < blinded.length; i++) {
    const sig = signatures[i] as { amount?: unknown; C_?: unknown; c_?: unknown };
    const raw = sig?.C_ ?? sig?.c_;
    if (sig?.amount !== blinded[i].amount || typeof raw !== "string") return null;
    const pub = keys[String(blinded[i].amount)];
    if (!pub) return null;
    try {
      proofs.push({ amount: blinded[i].amount, secret: blinded[i].secret, id: blinded[i].id, C: unblind(raw, blinded[i].r, pub) });
    } catch { return null; }
  }
  return proofs.reduce((n, p) => n + p.amount, 0) === amount ? proofs : null;
}

function objectBody(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}
