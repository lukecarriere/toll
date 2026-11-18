// Owner withdrawal of stored proofs over Lightning (NUT-05 melt, NUT-08 change).
// The proofs never leave the store as a token. They are reserved in one store write, sent to the
// allowlisted mint that signed them, and settled or released in one more write:
//   reserve: proofs move out of the stored set into one withdrawal row, with blank change outputs.
//   PAID:    the change proofs are stored and the row is closed (finish).
//   refused: the mint says the quote is unpaid and every input is unspent, so they go back (release).
//   unknown: a timeout, a 5xx, or a PENDING payment keeps the row. `checkWithdrawal` settles it later.
// Responses and logs carry amounts, states and the quote id. Proofs, secrets and invoices stay out.
import { TollError, randomHex } from "../../protocol/src/index.ts";
import { decodeBolt11 } from "./bolt11.ts";
import { CASHU_UNIT } from "./cashu.ts";
import { blindMessage, inputFee, secretY, unblind } from "./cashu-crypto.ts";
import { type MintGuard, mintFetch } from "./cashu-net.ts";
import type { PendingOutput, StoredProof } from "./cashu-store.ts";

/** One melt waits on a Lightning payment, so it gets a longer bound than a swap. */
export const MELT_TIMEOUT_MS = 25_000;
/** Inputs in one melt. A larger withdrawal is split by the owner. */
export const MAX_MELT_INPUTS = 100;
const QUOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type WithdrawState = "pending" | "paid" | "released";

export interface WithdrawRow {
  quote: string;
  mint: string;
  amount: number;
  feeReserve: number;
  state: WithdrawState;
  /** Empty once the row is paid or released. */
  inputs: StoredProof[];
  outputs: PendingOutput[];
  /** Set when paid: sats the mint kept beyond the amount, and sats returned as change. */
  fee?: number;
  change?: number;
}

export type ReserveResult =
  | { ok: true; inputs: StoredProof[] }
  | { ok: false; error: "insufficient" | "too_many_inputs" | "exists" };

/** The proof store side. Each call is one atomic write (one Durable Object transaction). */
export interface WithdrawStore {
  storedAt(mint: string): Promise<number>;
  reserve(o: { quote: string; mint: string; amount: number; feeReserve: number; ppk: Record<string, number>; outputs: PendingOutput[]; maxInputs: number }): Promise<ReserveResult>;
  get(quote: string): Promise<WithdrawRow | null>;
  finish(o: { quote: string; change: StoredProof[] }): Promise<{ amount: number; fee: number; change: number } | null>;
  release(quote: string): Promise<boolean>;
}

export interface MeltDeps {
  store: WithdrawStore;
  /** Mints the owner may melt at: the configured list plus mints that hold stored proofs. */
  allowlist: string[];
  guard: MintGuard;
  meltTimeoutMs?: number;
}

export type WithdrawResult =
  | { state: "paid"; quote: string; amount_sat: number; fee_sat: number; change_sat: number }
  | { state: "pending"; quote: string; amount_sat: number }
  | { state: "released"; quote: string; amount_sat: number }
  | { state: "refused"; error: string; fee_reserve_sat?: number };

/** Default fee cap: 2% of the amount, at least 10 sat. */
export function defaultMaxFee(amount: number): number {
  return Math.max(10, Math.ceil(amount * 0.02));
}

function bitLength(n: number): number {
  return n <= 0 ? 0 : Math.floor(Math.log2(n)) + 1;
}

function hexR(r: bigint): string {
  return r.toString(16).padStart(64, "0");
}

function parseJson(text: string): any {
  try { return text === "" ? null : JSON.parse(text); } catch { return null; }
}

/** NUT-05 states, plus the older `paid` boolean. */
function meltState(body: any): "PAID" | "PENDING" | "UNPAID" | null {
  const s = typeof body?.state === "string" ? body.state.toUpperCase() : null;
  if (s === "PAID" || s === "PENDING" || s === "UNPAID") return s;
  if (body?.paid === true) return "PAID";
  if (body?.paid === false) return "UNPAID";
  return null;
}

async function call(d: MeltDeps, mint: string, path: string, body?: unknown, timeoutMs?: number) {
  const init: RequestInit = body === undefined
    ? { method: "GET" }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  return mintFetch(mint, path, init, { ...d.guard, timeoutMs }, d.allowlist);
}

async function keysetsOf(d: MeltDeps, mint: string): Promise<{ active: string; ppk: Record<string, number> }> {
  const r = await call(d, mint, "/v1/keysets");
  const rows = r.status === 200 ? parseJson(r.text)?.keysets : null;
  if (!Array.isArray(rows)) throw new TollError("store_unavailable");
  const ppk: Record<string, number> = {};
  let active = "";
  for (const k of rows) {
    const id = String(k?.id ?? "").toLowerCase();
    if (!/^[0-9a-f]{16,66}$/.test(id) || k?.unit !== CASHU_UNIT) continue;
    ppk[id] = Number.isSafeInteger(k.input_fee_ppk) && k.input_fee_ppk >= 0 ? k.input_fee_ppk : 0;
    if (k.active === true && !active) active = id;
  }
  if (!active) throw new TollError("store_unavailable");
  return { active, ppk };
}

async function keysOf(d: MeltDeps, mint: string, id: string): Promise<Record<string, string>> {
  if (!/^[0-9a-f]{16,66}$/.test(id)) throw new TollError("store_unavailable");
  const r = await call(d, mint, "/v1/keys/" + id);
  const keys = r.status === 200 ? parseJson(r.text)?.keysets?.[0]?.keys : null;
  if (!keys || typeof keys !== "object") throw new TollError("store_unavailable");
  const out: Record<string, string> = {};
  for (const [amount, pk] of Object.entries(keys)) if (typeof pk === "string") out[amount] = pk.toLowerCase();
  return out;
}

/**
 * Unblind change signatures against the row's blank outputs. `byB_` pairs restore answers by
 * blinded point; otherwise signatures pair with the outputs in the order they were sent.
 * Null when a key could not be fetched, so the caller keeps the row and retries later.
 */
async function changeProofs(d: MeltDeps, row: WithdrawRow, sigs: { amount: number; id: string; C_: string; B_?: string }[]): Promise<StoredProof[] | null> {
  const keys = new Map<string, Record<string, string>>();
  const out: StoredProof[] = [];
  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i];
    const blank = s.B_ ? row.outputs.find((o) => o.B_ === s.B_) : row.outputs[i];
    if (!blank || !Number.isSafeInteger(s.amount) || s.amount <= 0) continue;
    const id = (s.id || blank.id).toLowerCase();
    if (!keys.has(id)) {
      try { keys.set(id, await keysOf(d, row.mint, id)); } catch { return null; }
    }
    const pub = keys.get(id)![String(s.amount)];
    if (!pub) continue;
    try {
      out.push({ mint: row.mint, unit: "sat", amount: s.amount, id, secret: blank.secret, C: unblind(s.C_, BigInt("0x" + blank.r), pub) });
    } catch { /* an unusable signature is not change; finish books it as fee */ }
  }
  return out;
}

function sigList(raw: unknown): { amount: number; id: string; C_: string }[] | null {
  if (!Array.isArray(raw)) return null;
  const out: { amount: number; id: string; C_: string }[] = [];
  for (const s of raw) {
    const C_ = typeof s?.C_ === "string" ? s.C_ : typeof s?.c_ === "string" ? s.c_ : "";
    if (!C_ || !/^[0-9a-fA-F]{66}$/.test(C_)) continue;
    out.push({ amount: Number(s.amount), id: String(s.id ?? ""), C_ });
  }
  return out;
}

/** NUT-09 for the row's blank outputs. Null when the mint did not answer. */
async function restoreChange(d: MeltDeps, row: WithdrawRow): Promise<{ amount: number; id: string; C_: string; B_: string }[] | null> {
  if (row.outputs.length === 0) return [];
  let r: { status: number; text: string };
  try {
    r = await call(d, row.mint, "/v1/restore", { outputs: row.outputs.map((o) => ({ amount: o.amount, id: o.id, B_: o.B_ })) });
  } catch { return null; }
  const body = r.status === 200 ? parseJson(r.text) : null;
  if (!body || !Array.isArray(body.outputs) || !Array.isArray(body.signatures) || body.outputs.length !== body.signatures.length) return null;
  const out: { amount: number; id: string; C_: string; B_: string }[] = [];
  for (let i = 0; i < body.signatures.length; i++) {
    const B_ = typeof body.outputs[i]?.B_ === "string" ? body.outputs[i].B_ : "";
    const [sig] = sigList([body.signatures[i]]) ?? [];
    if (B_ && sig) out.push({ ...sig, B_ });
  }
  return out;
}

async function settle(d: MeltDeps, row: WithdrawRow, sigs: { amount: number; id: string; C_: string; B_?: string }[]): Promise<WithdrawResult> {
  const change = await changeProofs(d, row, sigs);
  if (!change) return { state: "pending", quote: row.quote, amount_sat: row.amount };
  const done = await d.store.finish({ quote: row.quote, change });
  if (!done) return finalOf(await d.store.get(row.quote), row.quote);
  return { state: "paid", quote: row.quote, amount_sat: done.amount, fee_sat: done.fee, change_sat: done.change };
}

/** PAID: change from the reply, else NUT-09 restore of the blanks. No answer keeps the row pending. */
async function settlePaid(d: MeltDeps, row: WithdrawRow, body: any): Promise<WithdrawResult> {
  const sigs = sigList(body?.change);
  if (sigs && sigs.length) return settle(d, row, sigs);
  const restored = await restoreChange(d, row);
  if (!restored) return { state: "pending", quote: row.quote, amount_sat: row.amount };
  return settle(d, row, restored);
}

function finalOf(row: WithdrawRow | null, quote: string): WithdrawResult {
  if (!row) return { state: "refused", error: "not_found" };
  if (row.state === "paid") return { state: "paid", quote, amount_sat: row.amount, fee_sat: row.fee ?? 0, change_sat: row.change ?? 0 };
  return { state: row.state, quote, amount_sat: row.amount };
}

/** NUT-07 for the row's inputs. */
async function inputStates(d: MeltDeps, row: WithdrawRow): Promise<string[] | null> {
  let r: { status: number; text: string };
  try {
    r = await call(d, row.mint, "/v1/checkstate", { Ys: row.inputs.map((p) => secretY(p.secret)) });
  } catch { return null; }
  const states = r.status === 200 ? parseJson(r.text)?.states : null;
  if (!Array.isArray(states) || states.length !== row.inputs.length) return null;
  return states.map((s: any) => String(s?.state ?? "").toUpperCase());
}

/**
 * Settle a pending withdrawal from the mint's own record. PAID stores the change and closes the
 * row. An unpaid or unknown quote returns the proofs only when the mint reports every input
 * UNSPENT. Anything less certain keeps the row pending.
 */
export async function checkWithdrawal(d: MeltDeps, quote: string): Promise<WithdrawResult> {
  if (!QUOTE_ID.test(quote)) return { state: "refused", error: "not_found" };
  const row = await d.store.get(quote);
  if (!row || row.state !== "pending") return finalOf(row, quote);
  const pending: WithdrawResult = { state: "pending", quote, amount_sat: row.amount };
  let r: { status: number; text: string };
  try { r = await call(d, row.mint, "/v1/melt/quote/bolt11/" + quote); } catch { return pending; }
  const body = r.status === 200 ? parseJson(r.text) : null;
  const state = body ? meltState(body) : null;
  if (state === "PAID") return settlePaid(d, row, body);
  if (state === "PENDING") return pending;
  if (state !== "UNPAID" && r.status !== 404 && !(r.status >= 400 && r.status < 500 && r.status !== 429)) return pending;
  const states = await inputStates(d, row);
  if (!states || !states.every((s) => s === "UNSPENT")) return pending;
  return (await d.store.release(quote)) ? { state: "released", quote, amount_sat: row.amount } : finalOf(await d.store.get(quote), quote);
}

/** Pay `invoice` (bolt11 with an amount) from proofs stored for `mint`. */
export async function withdrawToInvoice(d: MeltDeps, o: { mint: string; invoice: string; maxFeeSat?: number }): Promise<WithdrawResult> {
  let amountMsat: number | null;
  try { amountMsat = decodeBolt11(o.invoice).amountMsat; } catch { return { state: "refused", error: "bad_invoice" }; }
  if (amountMsat === null) return { state: "refused", error: "amount_required" };
  if (amountMsat % 1000 !== 0 || amountMsat <= 0) return { state: "refused", error: "bad_invoice" };
  const amount = amountMsat / 1000;
  const stored = await d.store.storedAt(o.mint);
  if (amount > stored) return { state: "refused", error: "insufficient" };
  let q: { status: number; text: string };
  try { q = await call(d, o.mint, "/v1/melt/quote/bolt11", { request: o.invoice, unit: CASHU_UNIT }); } catch { return { state: "refused", error: "mint_unavailable" }; }
  const qb = q.status === 200 ? parseJson(q.text) : null;
  const quote = typeof qb?.quote === "string" ? qb.quote : "";
  const feeReserve = qb?.fee_reserve;
  if (!QUOTE_ID.test(quote) || qb.amount !== amount || !Number.isSafeInteger(feeReserve) || feeReserve < 0) return { state: "refused", error: q.status === 200 ? "mint_bad_quote" : "mint_refused" };
  const maxFee = o.maxFeeSat ?? defaultMaxFee(amount);
  if (feeReserve > maxFee) return { state: "refused", error: "fee_too_high", fee_reserve_sat: feeReserve };
  let ks: { active: string; ppk: Record<string, number> };
  try { ks = await keysetsOf(d, o.mint); } catch { return { state: "refused", error: "mint_unavailable" }; }
  // Enough blank outputs for any change up to everything stored at this mint (NUT-08).
  const outputs: PendingOutput[] = Array.from({ length: Math.max(1, Math.min(64, bitLength(stored))) }, () => {
    const b = blindMessage(randomHex(32));
    return { amount: 1, id: ks.active, secret: b.secret, r: hexR(b.r), B_: b.B_ };
  });
  const reserved = await d.store.reserve({ quote, mint: o.mint, amount, feeReserve, ppk: ks.ppk, outputs, maxInputs: MAX_MELT_INPUTS });
  if (!reserved.ok) return { state: "refused", error: reserved.error };
  const inSum = reserved.inputs.reduce((n, p) => n + p.amount, 0);
  const overpaid = inSum - amount - inputFee(reserved.inputs.map((p) => ks.ppk[p.id.toLowerCase()] ?? 0));
  const sent = outputs.slice(0, bitLength(overpaid));
  const row: WithdrawRow = { quote, mint: o.mint, amount, feeReserve, state: "pending", inputs: reserved.inputs, outputs };
  let r: { status: number; text: string };
  try {
    r = await call(d, o.mint, "/v1/melt/bolt11", {
      quote,
      inputs: reserved.inputs.map((p) => ({ amount: p.amount, id: p.id, secret: p.secret, C: p.C })),
      outputs: sent.map((b) => ({ amount: b.amount, id: b.id, B_: b.B_ })),
    }, d.meltTimeoutMs ?? MELT_TIMEOUT_MS);
  } catch {
    // The payment may be in flight. The row keeps the proofs until the mint answers a check.
    return { state: "pending", quote, amount_sat: amount };
  }
  const body = r.status === 200 ? parseJson(r.text) : null;
  const state = body ? meltState(body) : null;
  if (state === "PAID") return settlePaid(d, row, body);
  if (state === "PENDING" || r.status === 429 || r.status >= 500) return { state: "pending", quote, amount_sat: amount };
  return checkWithdrawal(d, quote);
}

/**
 * LUD-16 Lightning address to a bolt11 for `amountSat`. https only, no redirects, small bodies.
 * The invoice amount must equal the request; a different amount is refused before any melt.
 */
export async function resolveLightningAddress(address: string, amountSat: number, fetchImpl: typeof fetch = fetch): Promise<string> {
  const m = /^([a-z0-9._+-]{1,64})@([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+)$/.exec(address.trim().toLowerCase());
  if (!m || !Number.isSafeInteger(amountSat) || amountSat <= 0) throw new TollError("malformed");
  const [, user, host] = m;
  if (/^[0-9.]+$/.test(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new TollError("malformed");
  const get = async (url: string) => {
    const r = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
    const text = await r.text();
    if (r.status !== 200 || text.length > 65536) throw new TollError("store_unavailable");
    const body = parseJson(text);
    if (!body || typeof body !== "object") throw new TollError("store_unavailable");
    return body;
  };
  const info = await get(`https://${host}/.well-known/lnurlp/${encodeURIComponent(user)}`);
  const msat = amountSat * 1000;
  if (info.tag !== "payRequest" || typeof info.callback !== "string") throw new TollError("malformed");
  let cb: URL;
  try { cb = new URL(info.callback); } catch { throw new TollError("malformed"); }
  if (cb.protocol !== "https:" || cb.username || cb.password) throw new TollError("malformed");
  if (!(Number(info.minSendable) <= msat && msat <= Number(info.maxSendable))) throw new TollError("malformed");
  cb.searchParams.set("amount", String(msat));
  const pay = await get(cb.href);
  const pr = typeof pay.pr === "string" ? pay.pr.trim().toLowerCase() : "";
  let got: number | null;
  try { got = decodeBolt11(pr).amountMsat; } catch { throw new TollError("malformed"); }
  if (got !== msat) throw new TollError("malformed");
  return pr;
}
