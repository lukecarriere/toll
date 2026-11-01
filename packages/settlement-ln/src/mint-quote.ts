// Second offer beside Cashu. The invoice is a NUT-04 quote on the mint the Cashu offer already uses.
// A NUT-04 quote is quote, request, state, and expiry. It has no preimage field. Whether a public
// mint adds one is unverified, so this path never asks the mint for it. The payer proves
// sha256(preimage) equals the payment hash sealed with the price, the action, and the expiry.
// Mint state ISSUED is not payment. Toll's own quote row, written with the proofs and the
// single-use mark, is the proof. No node, and no second place that holds funds.
// Blinded outputs are stored on that row before POST /v1/mint/bolt11. A mint error that leaves
// the quote PAID releases the row. A lost response is recovered from those outputs.
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

/** One blinded output saved before POST /v1/mint/bolt11. `r` is the blinding factor, 32 bytes hex. */
export interface MintQuoteOutput {
  amount: number;
  id: string;
  secret: string;
  r: string;
  B_: string;
}

/** Body detail when the mint has signed and neither a re-mint nor a restore returned signatures. */
export const MINT_SIGNED_UNRECOVERABLE = "mint signed; signatures were not recovered";

/** Retry-After seconds on a retryable quote 503. Short against the 120 s quote lifetime. */
export const MINT_RETRY_AFTER_S = "5";

/** Retry-After for a quote 503: set unless the mint signed and the signatures are gone. */
export function quoteRetryHeaders(detail: string): Record<string, string> {
  return detail === MINT_SIGNED_UNRECOVERABLE ? {} : { "retry-after": MINT_RETRY_AFTER_S };
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

/**
 * A paid quote whose sats did not reach the store. `reason` says why. The store reverses it when the
 * quote's proofs are stored later (finishMintQuote), so a recovered quote is counted once, as stored.
 */
/**
 * Refusals of an expired PAID quote before Toll books it as lost and answers 401 expired instead of
 * a retryable 503. Each refused presentation posts the mint twice, so reaching the cap takes 10
 * posts, about 25 s of Retry-After: 5 retries. Only expired presentations count: an unexpired caller
 * can still earn a pass, and the macaroon lifetime bounds those. The count lives in the store's
 * consume counter (key f:mqr:<quote>, one day), so isolates share it. Past the cap, posts follow
 * the re-check schedule below, not each presentation, and a refused re-check answers 401 expired
 * whether or not the refusal count is still held.
 */
export const EXPIRED_REFUSAL_CAP = 5;
export const REFUSAL_COUNT_TTL_S = 86_400;

/**
 * Re-checks of a quote past the refusal cap. The first opens 60 s after the cap, and each later one
 * waits twice as long as the one before: 60, 120, 240, ... 7680 s, eight in all, so the last can come
 * about 4.3 hours after the cap. A presentation outside an open window answers 401 expired with no
 * mint post (the quote state GET still runs). A re-check that mints stores the proofs and reverses
 * the loss. After the eighth the loss stands. The marks last 30 days from the last re-check; after
 * that a returning quote starts the refusal count again, and the loss is still booked only once.
 */
export const RECHECK_BASE_S = 60;
export const RECHECK_MAX = 8;
export const RECHECK_TTL_S = 30 * 86_400;

export interface RecheckCounters {
  consume(key: string, initial: number, ttl_s: number): Promise<number>;
  peek(key: string): Promise<number | undefined>;
  firstUse(key: string, ttl_s: number): Promise<boolean>;
}

/** `uncapped`: the quote never hit the cap. `open`: this caller may post once. `closed`: no post now. */
export type RecheckGate = "uncapped" | "open" | "closed";

export interface MintQuoteRechecks {
  /** The quote reached the cap: start the schedule. A second call is a no-op. */
  arm(quote: string): Promise<void>;
  /** Spends one re-check when its window is open. One caller wins a window. */
  gate(quote: string): Promise<RecheckGate>;
}

/** The re-check schedule over a store's shared counters, so isolates and the sweep share it. */
export function mintQuoteRechecks(store: RecheckCounters): MintQuoteRechecks {
  const left = (quote: string) => store.peek("f:mqk:" + quote);
  return {
    async arm(quote) {
      if ((await left(quote)) !== undefined) return;
      await store.consume("f:mqk:" + quote, RECHECK_MAX + 1, RECHECK_TTL_S);
      await store.firstUse("f:mqw:" + quote, RECHECK_BASE_S);
    },
    async gate(quote) {
      const n = await left(quote);
      if (n === undefined) return "uncapped";
      // MINT_QUOTE_GUARD recheck-max: after the last re-check the loss stands and nothing is posted.
      if (n <= 0) return "closed";
      const used = RECHECK_MAX - n;
      // MINT_QUOTE_GUARD recheck-window: one post per window, and each window is twice the last.
      if (!(await store.firstUse("f:mqw:" + quote, RECHECK_BASE_S * 2 ** (used + 1)))) return "closed";
      await store.consume("f:mqk:" + quote, RECHECK_MAX + 1, RECHECK_TTL_S);
      return "open";
    },
  };
}

/** `mint` is the mint that holds the quote, so a later sweep can retry it. Empty on rows booked before it was recorded. */
export interface LossNote { quote: string; action: string; amount: number; reason: string; mint?: string }

/** The mint and the store calls the recovery tail needs. A presentation and the sweep both supply them. */
export interface MintQuoteDeps {
  mint: string;
  fetchImpl?: typeof fetch;
  mode?: "loopback" | "bolt11";
  guard?: MintGuard;
  allowlist?: string[];
  has: (quote: string) => Promise<boolean>;
  reserve: (row: { quote: string; action: string; amount: number; mint: string; outputs?: MintQuoteOutput[] }) => Promise<boolean>;
  claimOpen: (quote: string) => Promise<MintQuoteOutput[] | null>;
  release: (quote: string) => Promise<boolean>;
  unlock: (quote: string) => Promise<void>;
  finish: (row: { quote: string; proofs: HeldProof[] }) => Promise<boolean>;
  noteLoss: (x: LossNote) => Promise<void>;
  /** Spends one expired-refusal slot for the quote; returns what is left (0 on the slot that reaches the cap). Absent: no cap. */
  refusalsLeft?: (quote: string, cap: number) => Promise<number>;
  /** Backoff for quotes past the refusal cap. Absent: every presentation may post. */
  rechecks?: MintQuoteRechecks;
}

/** One quote as the tail sees it: sealed facts (or a stored row) plus the mint's state answer. */
export interface MintQuoteFacts { quote: string; cls: string; mint: string; amount: number; state: string; expired: boolean }

export async function verifyMintQuote(o: MintQuoteDeps & {
  secret: string; site: string; action: ActionClass; offer_id: string; macaroon: string; preimage: string; now: number;
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
  const paid = (): Paid => ({ cls: c.cls, amount_msat: c.amount_msat, payment_ref: c.payment_hash });
  // An expired macaroon never earns a pass, but a reservation it left open is still settled into the books.
  const expired = o.now > c.exp;
  const granted = (): Paid => {
    // MINT_QUOTE_GUARD expired-grant: proofs recovered after expiry are stored, and the caller still gets expired.
    if (expired) throw new TollError("expired");
    return paid();
  };
  await settleMintQuote(o, { quote: c.quote, cls: c.cls, mint: c.mint, amount, state, expired });
  return granted();
}

/**
 * Everything after the quote is known and its mint state read: finish an open row, or reserve and
 * mint, booking losses as it goes. Throws the same errors a presentation answers with; returns once
 * the proofs are stored. Needs no request, so the sweep runs it too.
 */
export async function settleMintQuote(deps: MintQuoteDeps, c: MintQuoteFacts): Promise<void> {
  // MINT_QUOTE_GUARD loss-mint: every loss this quote books names its mint, so the sweep can retry it.
  const o: MintQuoteDeps = { ...deps, noteLoss: (x) => deps.noteLoss({ ...x, mint: c.mint }) };
  const { amount, state, expired } = c;
  const mode = o.mode ?? "loopback";
  const fetchImpl = o.fetchImpl ?? fetch;
  const ctx: MintCtx = { mint: o.mint, quote: c.quote, amount, mode, fetchImpl, guard: o.guard, allowlist: o.allowlist };
  // A previous attempt stored outputs and dropped the lease. Finish from those, or give the row up.
  const pending = await o.claimOpen(c.quote);
  if (pending) {
    const recovered = await recoverOpen(ctx, pending);
    if (recovered === "unsigned") {
      // MINT_QUOTE_GUARD release: the mint did not sign, so this presentation may mint.
      if (!(await o.release(c.quote))) throw new TollError("replay");
    } else if (recovered === "unrecoverable") {
      await o.noteLoss({ quote: c.quote, action: c.cls, amount, reason: "unrecoverable" });
      await o.unlock(c.quote);
      throw new TollError("store_unavailable", MINT_SIGNED_UNRECOVERABLE);
    } else if (recovered === "later") {
      await o.unlock(c.quote);
      throw new TollError("store_unavailable");
    } else {
      await commitProofs(o, c.quote, c.cls, amount, recovered);
      return;
    }
  } else if (await o.has(c.quote)) {
    throw new TollError(expired ? "expired" : "replay");
  }
  // An expired PAID quote with no row is still minted into the store below; only the pass is withheld.
  if (expired && state !== "PAID") {
    // MINT_QUOTE_GUARD expired-loss: an issued quote this store holds no row for is booked as a loss, once.
    if (state === "ISSUED") await o.noteLoss({ quote: c.quote, action: c.cls, amount, reason: "issued_no_row" });
    throw new TollError("expired");
  }
  if (state !== "PAID" && state !== "ISSUED") throw new TollError("bad_solution");
  if (state === "ISSUED") {
    // MINT_QUOTE_GUARD issued-loss: a paid quote this store holds no row for is booked as a loss, once.
    await o.noteLoss({ quote: c.quote, action: c.cls, amount, reason: "issued_no_row" });
    // MINT_QUOTE_GUARD issued: mint state ISSUED is not payment when this store has no row.
    throw new TollError("bad_solution");
  }
  // MINT_QUOTE_GUARD recheck-gate: past the refusal cap an expired quote posts only on its re-check schedule.
  const gate = expired && o.rechecks ? await o.rechecks.gate(c.quote) : "uncapped";
  if (gate === "closed") throw new TollError("expired");
  let outputs: MintQuoteOutput[] = [];
  if (mode === "bolt11") {
    const built = await buildOutputs(o.mint, amount, fetchImpl, o.guard, o.allowlist);
    if (!built) throw new TollError("store_unavailable");
    outputs = built;
  }
  // The single-use mark lands before the mint is asked to sign, so eight retries mint once.
  // MINT_QUOTE_GUARD replay: the reservation is the single-use mark.
  if (!(await o.reserve({ quote: c.quote, action: c.cls, amount, mint: c.mint, outputs }))) throw new TollError("replay");
  const first = await mintOnce(ctx, outputs);
  if (first.proofs) {
    await commitProofs(o, c.quote, c.cls, amount, first.proofs);
    return;
  }
  // One more post while the lease is held. A single 500 among concurrent retries still yields one pass.
  const missed = await afterMiss(ctx, outputs, first.outcome);
  if (missed === "released") {
    // MINT_QUOTE_GUARD release: a mint refusal that did not sign drops the reservation.
    if (!(await o.release(c.quote))) throw new TollError("replay");
    // MINT_QUOTE_GUARD refusal-cap: an expired quote the mint keeps refusing is booked once at the cap and no longer invited to retry.
    // MINT_QUOTE_GUARD recheck-final: a refused re-check is final even after the one-day refusal count has lapsed.
    if (expired && (gate === "open" || (o.refusalsLeft && (await o.refusalsLeft(c.quote, EXPIRED_REFUSAL_CAP)) <= 0))) {
      await o.noteLoss({ quote: c.quote, action: c.cls, amount, reason: "mint_refused" });
      await o.rechecks?.arm(c.quote);
      throw new TollError("expired");
    }
    throw new TollError("store_unavailable");
  }
  if (missed !== "kept") {
    await commitProofs(o, c.quote, c.cls, amount, missed);
    return;
  }
  await o.unlock(c.quote);
  throw new TollError("store_unavailable");
}

/**
 * One stored quote retried with no presentation (the sweep). Reads the mint's quote state, then runs
 * the same tail as an expired presentation: restore an open row, or mint where the re-check schedule
 * allows. It never grants a pass. Resolves once the proofs are stored; throws what a presentation
 * would answer otherwise (a held lease reads as expired).
 */
export async function recoverMintQuote(o: MintQuoteDeps, row: { quote: string; action: string; amount: number; mint: string }): Promise<void> {
  if (row.mint !== o.mint) throw new TollError("bad_sig");
  const looked = await readMint(o.mint, "/v1/mint/quote/bolt11/" + encodeURIComponent(row.quote), undefined, o.fetchImpl ?? fetch, o.mode ?? "loopback", o.guard, o.allowlist);
  const state = typeof looked.body.state === "string" ? looked.body.state : "";
  if (looked.status !== 200 || looked.body.quote !== row.quote) throw new TollError(looked.status === 200 ? "bad_solution" : "store_unavailable");
  await settleMintQuote(o, { quote: row.quote, cls: row.action, mint: row.mint, amount: row.amount, state, expired: true });
}

async function commitProofs(
  o: { finish: (row: { quote: string; proofs: HeldProof[] }) => Promise<boolean>; noteLoss: (x: LossNote) => Promise<void> },
  quote: string, action: string, amount: number, proofs: HeldProof[],
): Promise<void> {
  try {
    if (!(await o.finish({ quote, proofs }))) throw new TollError("replay");
  } catch (e) {
    if (e instanceof TollError && e.code === "replay") throw e;
    await o.noteLoss({ quote, action, amount, reason: "commit_failed" });
    throw e;
  }
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
      if (!x.action || !x.hasMintQuote || !x.reserveMintQuote || !x.claimOpenMintQuote || !x.releaseMintQuote || !x.unlockMintQuote || !x.finishMintQuote || !x.noteMintQuoteLoss) throw new TollError("malformed");
      return verifyMintQuote({
        ...bound, site: x.site, action: x.action, offer_id: x.proof.offer_id,
        macaroon: x.proof.credential, preimage: x.proof.preimage, now: x.now,
        has: x.hasMintQuote, reserve: x.reserveMintQuote, claimOpen: x.claimOpenMintQuote, release: x.releaseMintQuote, unlock: x.unlockMintQuote, finish: x.finishMintQuote, noteLoss: x.noteMintQuoteLoss,
        refusalsLeft: x.mintQuoteRefusalsLeft, rechecks: x.mintQuoteRechecks,
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

/**
 * How one mint post ended. `refused` is a mint error reply (a JSON `detail` or `code`), so nothing was signed.
 * `unknown` is a timeout, a dropped call, or a reply that is not the mint's: it may have signed.
 */
type MintOutcome = "signed" | "refused" | "unknown";
interface Minted { proofs: HeldProof[] | null; outcome: MintOutcome }

function refusal(status: number, body: Record<string, unknown>): MintOutcome {
  if (status === 200) return "unknown";
  return typeof body.detail === "string" || typeof body.code === "number" ? "refused" : "unknown";
}

async function mintLoopback(mint: string, quote: string, amount: number, fetchImpl: typeof fetch): Promise<Minted> {
  let minted: { status: number; body: Record<string, unknown> };
  try {
    minted = await readJson(mint + "/v1/mint/bolt11", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quote }),
    }, fetchImpl);
  } catch { return { proofs: null, outcome: "unknown" }; }
  const proofs = minted.status === 200 ? asProofs(minted.body.proofs, amount) : null;
  return proofs ? { proofs, outcome: "signed" } : { proofs: null, outcome: refusal(minted.status, minted.body) };
}

interface MintCtx {
  mint: string;
  quote: string;
  amount: number;
  mode: "loopback" | "bolt11";
  fetchImpl: typeof fetch;
  guard: MintGuard | undefined;
  allowlist: string[] | undefined;
}

type OpenResult = HeldProof[] | "unsigned" | "unrecoverable" | "later";

/**
 * Continue an open reservation. The quote state comes first: ISSUED is fetched back with the
 * stored outputs, PAID is posted again with the same outputs. `unsigned` means the mint refused
 * and still has not signed these outputs, so the row may be given up.
 */
async function recoverOpen(ctx: MintCtx, outputs: MintQuoteOutput[]): Promise<OpenResult> {
  const state = await quoteState(ctx);
  const bolt11 = ctx.mode === "bolt11" && outputs.length > 0;
  // MINT_QUOTE_GUARD issued-first: an issued quote is restored, never treated as unsigned.
  if (state === "ISSUED") {
    if (bolt11) {
      const restored = await restoreBolt11(ctx, outputs);
      if (restored.kind === "proofs") return restored.proofs;
      if (restored.kind === "none") return "unrecoverable";
    }
    // No restore answer (or loopback): the same outputs posted again return the signatures on a NUT-04 mint.
    const again = await mintOnce(ctx, outputs);
    if (again.proofs) return again.proofs;
    return again.outcome === "refused" && !bolt11 ? "unrecoverable" : "later";
  }
  if (state !== "PAID") return "later";
  const posted = await mintOnce(ctx, outputs);
  if (posted.proofs) return posted.proofs;
  return (await unsignedAfter(ctx, outputs, [posted.outcome])) ?? "later";
}

/**
 * The mint call failed while this request holds the lease.
 * A quote that is still PAID is posted once more with the same outputs.
 * Only refusals followed by an empty restore release the row; anything ambiguous keeps it.
 */
async function afterMiss(ctx: MintCtx, outputs: MintQuoteOutput[], first: MintOutcome): Promise<HeldProof[] | "released" | "kept"> {
  const state = await quoteState(ctx);
  if (state !== "PAID") return "kept";
  const again = await mintOnce(ctx, outputs);
  if (again.proofs) return again.proofs;
  const settled = await unsignedAfter(ctx, outputs, [first, again.outcome]);
  if (settled === "unsigned") return "released";
  return Array.isArray(settled) ? settled : "kept";
}

/**
 * After failed posts: proofs if restore finds them, `unsigned` when every post was refused,
 * restore shows nothing and the quote is still PAID. Null keeps the row.
 */
async function unsignedAfter(ctx: MintCtx, outputs: MintQuoteOutput[], outcomes: MintOutcome[]): Promise<HeldProof[] | "unsigned" | null> {
  let empty = true;
  if (ctx.mode === "bolt11" && outputs.length > 0) {
    const restored = await restoreBolt11(ctx, outputs);
    if (restored.kind === "proofs") return restored.proofs;
    empty = restored.kind === "none";
  }
  // MINT_QUOTE_GUARD ambiguous: a timeout or dropped call may have signed, so it never releases the row.
  if (!outcomes.every((x) => x === "refused")) return null;
  return empty && (await quoteState(ctx)) === "PAID" ? "unsigned" : null;
}

async function mintOnce(ctx: MintCtx, outputs: MintQuoteOutput[]): Promise<Minted> {
  if (ctx.mode === "bolt11") return postBolt11(ctx, outputs);
  return mintLoopback(ctx.mint, ctx.quote, ctx.amount, ctx.fetchImpl);
}

async function quoteState(ctx: MintCtx): Promise<string | null> {
  try {
    const looked = await readMint(ctx.mint, "/v1/mint/quote/bolt11/" + encodeURIComponent(ctx.quote), undefined, ctx.fetchImpl, ctx.mode, ctx.guard, ctx.allowlist);
    if (looked.status !== 200) return null;
    return typeof looked.body.state === "string" ? looked.body.state : "";
  } catch {
    return null;
  }
}

function hexR(r: bigint): string {
  return r.toString(16).padStart(64, "0");
}

function parseR(h: string): bigint {
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("r");
  return BigInt("0x" + h);
}

interface ActiveKeys { id: string; keys: Record<string, string> }

/** Active sat keyset. Null when the mint does not answer or the id does not match its keys. */
async function loadKeys(mint: string, fetchImpl: typeof fetch, guard: MintGuard | undefined, allowlist: string[] | undefined): Promise<ActiveKeys | null> {
  const list = allowlist ?? [mint];
  const guardWith = { ...guard, fetch: fetchImpl };
  let listed: { status: number; text: string };
  try { listed = await mintFetch(mint, "/v1/keysets", { method: "GET" }, guardWith, list); } catch { return null; }
  if (listed.status !== 200) return null;
  const rows = objectBody(listed.text).keysets;
  if (!Array.isArray(rows)) return null;
  const active = rows.map((k) => {
    const row = k as { id?: unknown; unit?: unknown; active?: unknown; input_fee_ppk?: unknown; final_expiry?: unknown };
    return {
      id: typeof row.id === "string" ? row.id.toLowerCase() : "",
      unit: typeof row.unit === "string" ? row.unit : "",
      active: row.active === true,
      input_fee_ppk: Number.isSafeInteger(row.input_fee_ppk) ? row.input_fee_ppk as number : 0,
      final_expiry: Number.isSafeInteger(row.final_expiry) ? row.final_expiry as number : null,
    };
  }).find((k) => k.active && k.unit === "sat" && k.id.startsWith("01") && k.id.length === 66);
  if (!active) return null;
  let keysRes: { status: number; text: string };
  try { keysRes = await mintFetch(mint, "/v1/keys/" + active.id, { method: "GET" }, guardWith, list); } catch { return null; }
  if (keysRes.status !== 200) return null;
  const keyRow = objectBody(keysRes.text).keysets;
  const keysRaw = Array.isArray(keyRow) && keyRow[0] && typeof keyRow[0] === "object" ? (keyRow[0] as { keys?: unknown }).keys : undefined;
  if (!keysRaw || typeof keysRaw !== "object") return null;
  const keys: Record<string, string> = {};
  for (const [amt, pk] of Object.entries(keysRaw)) if (typeof pk === "string") keys[amt] = pk.toLowerCase();
  let derived: string;
  try { derived = deriveKeysetIdV2(keys, "sat", active.input_fee_ppk, active.final_expiry); } catch { return null; }
  if (derived !== active.id) return null;
  return { id: active.id, keys };
}

/** Blinded outputs for `amount`. Stored before the mint is asked to sign. */
async function buildOutputs(mint: string, amount: number, fetchImpl: typeof fetch, guard: MintGuard | undefined, allowlist: string[] | undefined): Promise<MintQuoteOutput[] | null> {
  const active = await loadKeys(mint, fetchImpl, guard, allowlist);
  if (!active) return null;
  const amounts = splitAmount(amount, Object.keys(active.keys).map(Number));
  if (!amounts) return null;
  return amounts.map((amt) => {
    const b = blindMessage(toHex(randomBytes(32)));
    return { amount: amt, id: active.id, secret: b.secret, r: hexR(b.r), B_: b.B_ };
  });
}

function outputBody(outputs: MintQuoteOutput[]): { amount: number; id: string; B_: string }[] {
  return outputs.map((b) => ({ amount: b.amount, id: b.id, B_: b.B_ }));
}

function unblindAll(outputs: MintQuoteOutput[], signatures: unknown, keys: Record<string, string>, amount: number): HeldProof[] | null {
  if (!Array.isArray(signatures) || signatures.length !== outputs.length) return null;
  const proofs: HeldProof[] = [];
  for (let i = 0; i < outputs.length; i++) {
    const sig = signatures[i] as { amount?: unknown; C_?: unknown; c_?: unknown };
    const raw = sig?.C_ ?? sig?.c_;
    if (sig?.amount !== outputs[i].amount || typeof raw !== "string") return null;
    const pub = keys[String(outputs[i].amount)];
    if (!pub) return null;
    try {
      proofs.push({ amount: outputs[i].amount, secret: outputs[i].secret, id: outputs[i].id, C: unblind(raw, parseR(outputs[i].r), pub) });
    } catch { return null; }
  }
  return proofs.reduce((n, p) => n + p.amount, 0) === amount ? proofs : null;
}

/** NUT-04 with the outputs this store already saved. Keys that do not load mean nothing was sent. */
async function postBolt11(ctx: MintCtx, outputs: MintQuoteOutput[]): Promise<Minted> {
  const active = await loadKeys(ctx.mint, ctx.fetchImpl, ctx.guard, ctx.allowlist);
  if (!active) return { proofs: null, outcome: "unknown" };
  let minted: { status: number; text: string };
  try {
    minted = await mintFetch(ctx.mint, "/v1/mint/bolt11", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ quote: ctx.quote, outputs: outputBody(outputs) }),
    }, { ...ctx.guard, fetch: ctx.fetchImpl }, ctx.allowlist ?? [ctx.mint]);
  } catch { return { proofs: null, outcome: "unknown" }; }
  const body = objectBody(minted.text);
  const proofs = minted.status === 200 ? unblindAll(outputs, body.signatures, active.keys, ctx.amount) : null;
  return proofs ? { proofs, outcome: "signed" } : { proofs: null, outcome: refusal(minted.status, body) };
}

type RestoreResult = { kind: "proofs"; proofs: HeldProof[] } | { kind: "none" } | { kind: "inconclusive" };

/**
 * NUT-09 for the saved outputs. `none` is a 200 whose outputs and signatures are both empty.
 * Anything else that is not a full signature list is inconclusive and must not release the row.
 */
async function restoreBolt11(ctx: MintCtx, outputs: MintQuoteOutput[]): Promise<RestoreResult> {
  const active = await loadKeys(ctx.mint, ctx.fetchImpl, ctx.guard, ctx.allowlist);
  if (!active) return { kind: "inconclusive" };
  let r: { status: number; text: string };
  try {
    r = await mintFetch(ctx.mint, "/v1/restore", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ outputs: outputBody(outputs) }),
    }, { ...ctx.guard, fetch: ctx.fetchImpl }, ctx.allowlist ?? [ctx.mint]);
  } catch { return { kind: "inconclusive" }; }
  if (r.status !== 200) return { kind: "inconclusive" };
  const parsed = objectBody(r.text);
  const outs = parsed.outputs;
  const rows = parsed.signatures;
  if (!Array.isArray(outs) || !Array.isArray(rows) || outs.length !== rows.length) return { kind: "inconclusive" };
  if (outs.length === 0) return { kind: "none" };
  const got: unknown[] = new Array(outputs.length);
  let usable = 0;
  for (let i = 0; i < rows.length; i++) {
    const out = outs[i] as { amount?: unknown; B_?: unknown };
    const B_ = typeof out?.B_ === "string" ? out.B_ : "";
    const amt = typeof out?.amount === "number" ? out.amount : Number.NaN;
    const idx = outputs.findIndex((b) => b.B_ === B_ && b.amount === amt);
    if (idx < 0 || got[idx]) continue;
    got[idx] = rows[i];
    usable++;
  }
  if (usable !== outputs.length) return { kind: "inconclusive" };
  const proofs = unblindAll(outputs, got, active.keys, ctx.amount);
  return proofs ? { kind: "proofs", proofs } : { kind: "inconclusive" };
}

function objectBody(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}
