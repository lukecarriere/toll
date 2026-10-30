// Production Cashu receive. A cashuA or cashuB token is swapped at an allowlisted mint into proofs
// this process keeps. Short version-01 keyset ids are mapped with the mint's keyset list first.
// Blinded outputs are durable before POST /v1/swap. A crash there is recovered with NUT-09
// restore and NUT-07 checkstate. The gate is granted only after the new proofs are stored.
// The test engine (cashu-engine.ts) is unchanged and still talks only to a loopback http mint.
import {
  type ActionClass, TollError, canonicalJson, fromB64url, fromUtf8, hmacSha256, hmacVerify, randomBytes, randomHex, sha256, toB64url, toHex, utf8,
} from "../../protocol/src/index.ts";
import { CASHU_UNIT, decodeToken, encodePaymentRequest, type DecodedToken } from "./cashu.ts";
import { blindMessage, deriveKeysetIdV2, inputFee, resolveKeysetId, secretMark, secretY, splitAmount, unblind } from "./cashu-crypto.ts";
import { type MintGuard, guardMintUrl, mintFetch, mintKey } from "./cashu-net.ts";
import { FileProofStore, type PendingOutput, type PendingSwap, type ProofStore, type StoredProof } from "./cashu-store.ts";
import type { CashuOffer, Paid, PaidClass, PaidProof, SettlementEngine } from "./engine.ts";

const SEAL_PREFIX = "toll-cashu-recv-v1.";
const MAX_TOKEN = 16384;

interface Caveats {
  v: 1;
  offer_id: string;
  site: string;
  cls: ActionClass;
  amount_msat: number;
  mints: string[];
  amount: number;
  exp: number;
}

interface KeysetInfo {
  id: string;
  unit: string;
  active: boolean;
  input_fee_ppk: number;
  final_expiry: number | null;
  keys?: Record<string, string>;
}

type SwapOutcome =
  | { kind: "sigs"; signatures: { amount: number; C_: string }[] }
  | { kind: "http"; status: number; text: string }
  | { kind: "unknown" };

type RestoreOutcome =
  | { kind: "proofs"; proofs: StoredProof[] }
  | { kind: "none" }
  | { kind: "inconclusive" };

/**
 * A label for the caller after the outputs are already resolved.
 * Any 4xx other than 429 is a refusal, including a body that is not JSON.
 * 11001 is replay. 429 and 5xx stay an outage. A code never decides whether the row is deleted.
 */
function messageFor(outcome: SwapOutcome): "bad_solution" | "replay" | "store_unavailable" {
  if (outcome.kind !== "http") return "store_unavailable";
  if (outcome.status === 429 || outcome.status < 400 || outcome.status >= 500) return "store_unavailable";
  let code = Number.NaN;
  try { code = Number(JSON.parse(outcome.text)?.code); } catch { /* a 4xx that is not JSON is still a refusal */ }
  if (code === 11001) return "replay";
  return "bad_solution";
}

async function seal(secret: string, c: Caveats): Promise<string> {
  const payload = toB64url(utf8(canonicalJson(c)));
  const mac = await hmacSha256(secret, utf8(SEAL_PREFIX + payload));
  return payload + "." + toB64url(mac);
}

async function open(secret: string, credential: string): Promise<Caveats> {
  const [payload, macB64, extra] = credential.split(".");
  if (!payload || !macB64 || extra !== undefined) throw new TollError("malformed");
  let mac: Uint8Array;
  try { mac = fromB64url(macB64); } catch { throw new TollError("malformed"); }
  if (!(await hmacVerify(secret, utf8(SEAL_PREFIX + payload), mac))) throw new TollError("bad_sig");
  let c: Caveats;
  try { c = JSON.parse(fromUtf8(fromB64url(payload))); } catch { throw new TollError("malformed"); }
  if (c.v !== 1 || typeof c.offer_id !== "string" || !Array.isArray(c.mints)) throw new TollError("malformed");
  return c;
}

function sameMarks(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((h) => set.has(h));
}

function hexR(r: bigint): string {
  return r.toString(16).padStart(64, "0");
}

function parseR(h: string): bigint {
  if (!/^[0-9a-f]{64}$/.test(h)) throw new TollError("store_unavailable");
  return BigInt("0x" + h);
}

/** `C_` or `c_`, either hex case. Null when the signature is not usable. */
function signatureC(sig: unknown, amount: number): string | null {
  if (!sig || typeof sig !== "object") return null;
  const row = sig as { amount?: unknown; C_?: unknown; c_?: unknown };
  const raw = row.C_ ?? row.c_;
  if (row.amount !== amount || typeof raw !== "string") return null;
  // CASHU_GUARD c-case
  const C_ = raw.toLowerCase();
  if (!/^[0-9a-f]+$/.test(C_) || C_.length % 2 !== 0) return null;
  return C_;
}

export interface ReceiveEngineOptions extends MintGuard {
  secret: string;
  mints: string[];
  store: string | ProofStore;
  /** Runs after the pending swap is durable and before POST /v1/swap. Tests use it to crash there. */
  beforeSwap?: () => Promise<void> | void;
  /** Runs after the swap response is in hand and before the proofs are stored. */
  afterSwap?: () => Promise<void> | void;
}

export class CashuReceiveEngine implements SettlementEngine {
  readonly kind = "cashu" as const;
  private secret: string;
  readonly mints: string[];
  private guard: MintGuard;
  private store: ProofStore;
  private beforeSwap?: () => Promise<void> | void;
  private afterSwap?: () => Promise<void> | void;

  constructor(o: ReceiveEngineOptions) {
    if (!o.secret || o.secret.length < 16) throw new Error("cashu engine: secret too short");
    if (!Array.isArray(o.mints) || o.mints.length === 0) throw new Error("cashu engine: allowlist is empty");
    this.secret = o.secret;
    this.mints = o.mints.map((m) => mintKey(m));
    this.guard = { loopbackHttp: o.loopbackHttp, lookup: o.lookup, fetch: o.fetch };
    this.beforeSwap = o.beforeSwap;
    this.afterSwap = o.afterSwap;
    this.store = typeof o.store === "string" ? new FileProofStore(o.store) : o.store;
  }

  private async useStore(): Promise<ProofStore> {
    return this.store;
  }

  async offer(o: { site: string; cls: PaidClass; amount_msat: number; now: number; ttl_s?: number }): Promise<CashuOffer> {
    if (!Number.isSafeInteger(o.amount_msat) || o.amount_msat <= 0 || o.amount_msat % 1000 !== 0) throw new Error("offer amount must be a positive whole number of 1,000 msat");
    const live = await this.liveMints();
    if (live.length === 0) throw new TollError("store_unavailable");
    const ttl = Math.min(o.ttl_s ?? 120, 120);
    const id = "off_" + randomHex(12);
    const amount = o.amount_msat / 1000;
    const exp = o.now + ttl;
    const request = encodePaymentRequest({ a: amount, u: CASHU_UNIT, m: live, s: true, i: id });
    const credential = await seal(this.secret, { v: 1, offer_id: id, site: o.site, cls: o.cls, amount_msat: o.amount_msat, mints: live, amount, exp });
    return { id, kind: "cashu", amount_msat: o.amount_msat, amount, unit: CASHU_UNIT, mint: live[0], request, credential, exp };
  }

  async verifyPaid(o: { site: string; proof: PaidProof; now: number; firstUse: (key: string, ttl_s: number) => Promise<boolean> }): Promise<Paid> {
    if (o.proof.kind !== "cashu") throw new TollError("unsupported");
    if (o.proof.token.length > MAX_TOKEN) throw new TollError("malformed");
    const c = await open(this.secret, o.proof.credential);
    if (c.offer_id !== o.proof.offer_id) throw new TollError("bad_sig");
    if (c.site !== o.site) throw new TollError("wrong_site");
    if (o.now > c.exp) throw new TollError("expired");
    if (c.amount * 1000 !== c.amount_msat) throw new TollError("bad_sig");
    let token: DecodedToken;
    try { token = decodeToken(o.proof.token); } catch { throw new TollError("malformed"); }
    if (token.proofs.length > 32) throw new TollError("malformed");
    if (token.unit !== CASHU_UNIT) throw new TollError("malformed");
    let mint: string;
    try { mint = mintKey(token.mint); } catch { throw new TollError("malformed"); }
    const sealed = c.mints.map((m) => { try { return mintKey(m); } catch { return ""; } });
    // CASHU_GUARD allowlist: a V3 token and a V4 token must name a mint on the offer and the allowlist before any request.
    if (!sealed.includes(mint)) throw new TollError("malformed");
    try { await guardMintUrl(mint, this.mints, this.guard); } catch (e) {
      if (e instanceof TollError) throw e;
      throw new TollError("malformed");
    }
    const sum = token.proofs.reduce((n, p) => n + p.amount, 0);
    if (!Number.isSafeInteger(sum) || sum < c.amount) throw new TollError("malformed");
    const marks = token.proofs.map((p) => secretMark(p.secret));
    const store = await this.useStore();
    // Other in-flight swaps are recovered here. This token's pending swap is finished below, so a
    // retry still receives the gate once its proofs are stored.
    await this.recoverSaved(marks);
    const snap = await store.read();
    // CASHU_GUARD replay: a spent input is refused from the store, before another swap.
    if (marks.some((h) => snap.spent.includes(h))) throw new TollError("replay");
    let pending = snap.pending.find((p) => sameMarks(p.marks, marks) && p.mint === mint);
    if (!pending) {
      const prepared = await this.prepare(mint, token, marks);
      // CASHU_GUARD persist-before-swap: outputs and secrets are durable before the mint is asked to swap.
      pending = await store.begin(prepared);
    }
    if (this.beforeSwap) await this.beforeSwap();
    const proofs = await this.complete(pending);
    // CASHU_GUARD grant-only-stored: the pass is minted only after this returns and the read-back matches.
    await store.commit({ id: pending.id, proofs, marks: pending.marks });
    if (!(await this.proofsDurable(proofs))) throw new TollError("store_unavailable");
    if (proofs.reduce((n, p) => n + p.amount, 0) <= 0) throw new TollError("store_unavailable");
    const ttl = Math.max(1, c.exp - o.now + 60);
    if (!(await o.firstUse("offer:" + c.offer_id, ttl))) throw new TollError("replay");
    const ref = toHex(await sha256(utf8(marks.slice().sort().join("\n"))));
    if (!(await o.firstUse("cashu:" + ref, ttl))) throw new TollError("replay");
    return { cls: c.cls, amount_msat: c.amount_msat, payment_ref: ref };
  }

  async healthy(): Promise<boolean> {
    return (await this.liveMints()).length > 0;
  }

  /**
   * NUT-09 then NUT-07 for swaps that were saved and not finished. Stores proofs, or deletes the row
   * when restore is empty and every input is unspent. Does not grant a gate.
   * `skip` leaves that input set for the request in progress, which grants the gate itself.
   * `minAgeMs` skips the delete for a row younger than that. The alarm uses it so a swap still
   * in flight is not deleted. Commit of a signature the mint already returned is not delayed.
   */
  async recoverSaved(skip?: string[], minAgeMs = 0): Promise<void> {
    const store = await this.useStore();
    const snap = await store.read();
    const now = Date.now();
    for (const pending of snap.pending) {
      if (skip && sameMarks(pending.marks, skip)) continue;
      const restored = await this.tryRestore(pending);
      if (restored.kind === "proofs") {
        await store.commit({ id: pending.id, proofs: restored.proofs, marks: pending.marks });
        continue;
      }
      // A restore that did not return an empty signature list is inconclusive. Leave the row.
      if (restored.kind !== "none") continue;
      if (minAgeMs > 0 && now - (pending.at ?? 0) < minAgeMs) continue;
      if ((await this.tryCheck(pending)) === "unspent") await store.abort(pending.id);
    }
  }

  private async proofsDurable(proofs: StoredProof[]): Promise<boolean> {
    const store = await this.useStore();
    const snap = await store.read();
    const want = proofs.reduce((n, p) => n + p.amount, 0);
    const got = snap.proofs.filter((p) => proofs.some((q) => q.secret === p.secret)).reduce((n, p) => n + p.amount, 0);
    return got === want && want > 0;
  }

  private async liveMints(): Promise<string[]> {
    const out: string[] = [];
    for (const mint of this.mints) {
      try {
        const r = await mintFetch(mint, "/v1/info", { method: "GET" }, this.guard, this.mints);
        if (r.status === 200) out.push(mint);
      } catch {
        /* this mint is down; another allowlisted mint may still answer */
      }
    }
    return out;
  }

  private async prepare(mint: string, token: DecodedToken, marks: string[]): Promise<PendingSwap> {
    const listed = await this.keysets(mint);
    const known = listed.map((k) => k.id);
    let proofs: { amount: number; secret: string; id: string; C: string }[];
    try {
      proofs = token.proofs.map((p) => ({ amount: p.amount, secret: p.secret, id: resolveKeysetId(p.id, known), C: toHex(p.C).toLowerCase() }));
    } catch {
      throw new TollError("malformed");
    }
    const byId = new Map(listed.map((k) => [k.id.toLowerCase(), k]));
    const fees = inputFee(proofs.map((p) => byId.get(p.id)?.input_fee_ppk ?? 0));
    const outAmount = proofs.reduce((n, p) => n + p.amount, 0) - fees;
    const active = listed.find((k) => k.active && k.unit === CASHU_UNIT);
    if (!active || outAmount <= 0) throw new TollError("store_unavailable");
    const keys = await this.keys(mint, active.id);
    const derived = deriveKeysetIdV2(keys, active.unit, active.input_fee_ppk, active.final_expiry);
    if (derived !== active.id.toLowerCase()) throw new TollError("bad_solution");
    const denoms = Object.keys(keys).map(Number);
    const amounts = splitAmount(outAmount, denoms);
    if (!amounts) throw new TollError("bad_solution");
    const outputs: PendingOutput[] = amounts.map((amount) => {
      const blinded = blindMessage(toHex(randomBytes(32)));
      return { amount, id: active.id.toLowerCase(), secret: blinded.secret, r: hexR(blinded.r), B_: blinded.B_ };
    });
    return {
      id: "pend_" + randomHex(8),
      at: Date.now(),
      mint,
      unit: "sat",
      inSats: proofs.reduce((n, p) => n + p.amount, 0),
      outSats: outputs.reduce((n, p) => n + p.amount, 0),
      marks,
      inputs: proofs,
      outputs,
    };
  }

  private async complete(pending: PendingSwap): Promise<StoredProof[]> {
    const outcome = await this.postSwap(pending);
    if (this.afterSwap) await this.afterSwap();
    if (outcome.kind === "sigs") {
      const proofs = await this.unblindOutputs(pending, outcome.signatures);
      if (proofs) return proofs;
    }
    const first = await this.tryRestore(pending);
    if (first.kind === "proofs") return first.proofs;
    // The swap did not return signatures. Post the same blinded outputs once more, then restore again.
    const again = await this.postSwap(pending);
    if (again.kind === "sigs") {
      const proofs = await this.unblindOutputs(pending, again.signatures);
      if (proofs) return proofs;
    }
    const second = await this.tryRestore(pending);
    if (second.kind === "proofs") return second.proofs;
    const empty = first.kind === "none" || second.kind === "none";
    const unclear = first.kind === "inconclusive" || second.kind === "inconclusive";
    const state = await this.tryCheck(pending);
    const notice = messageFor(outcome.kind === "http" ? outcome : again);
    // CASHU_GUARD abort-only-empty-restore: a mint code never deletes the outputs.
    // Abort only when restore returned zero signatures and every input is UNSPENT.
    if (empty && !unclear && state === "unspent") {
      await (await this.useStore()).abort(pending.id);
      throw new TollError(notice);
    }
    throw new TollError("store_unavailable");
  }

  private async postSwap(pending: PendingSwap): Promise<SwapOutcome> {
    const body = {
      inputs: pending.inputs.map((p) => ({ amount: p.amount, id: p.id, secret: p.secret, C: p.C })),
      outputs: pending.outputs.map((b) => ({ amount: b.amount, id: b.id, B_: b.B_ })),
    };
    let r: { status: number; text: string };
    try {
      r = await mintFetch(pending.mint, "/v1/swap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, this.guard, this.mints);
    } catch {
      // CASHU_GUARD transport-not-4xx: a dropped connection is not a mint 4xx.
      return { kind: "unknown" };
    }
    if (r.status !== 200) return { kind: "http", status: r.status, text: r.text };
    let rows: unknown;
    try { rows = JSON.parse(r.text).signatures; } catch { return { kind: "unknown" }; }
    if (!Array.isArray(rows) || rows.length !== pending.outputs.length) return { kind: "unknown" };
    const signatures: { amount: number; C_: string }[] = [];
    for (let i = 0; i < pending.outputs.length; i++) {
      const C_ = signatureC(rows[i], pending.outputs[i].amount);
      if (!C_) return { kind: "unknown" };
      signatures.push({ amount: pending.outputs[i].amount, C_ });
    }
    return { kind: "sigs", signatures };
  }

  /**
   * NUT-09. Proofs when every blinded output has a signature. `none` only for a 200 whose
   * outputs and signatures are both empty. A null signature, a partial list, or a transport
   * failure is inconclusive and must not delete the row.
   */
  private async tryRestore(pending: PendingSwap): Promise<RestoreOutcome> {
    let r: { status: number; text: string };
    try {
      const body = { outputs: pending.outputs.map((b) => ({ amount: b.amount, id: b.id, B_: b.B_ })) };
      r = await mintFetch(pending.mint, "/v1/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, this.guard, this.mints);
    } catch {
      // CASHU_GUARD transport-not-4xx: a dropped connection is not a conclusive empty restore.
      return { kind: "inconclusive" };
    }
    if (r.status !== 200) return { kind: "inconclusive" };
    let parsed: unknown;
    try { parsed = JSON.parse(r.text); } catch { return { kind: "inconclusive" }; }
    const outputs = parsed && typeof parsed === "object" ? (parsed as { outputs?: unknown; signatures?: unknown }).outputs : undefined;
    const rows = parsed && typeof parsed === "object" ? (parsed as { signatures?: unknown }).signatures : undefined;
    // CASHU_GUARD inconclusive-restore: only paired arrays are an answer. Empty arrays mean zero signatures.
    if (!Array.isArray(outputs) || !Array.isArray(rows) || outputs.length !== rows.length) return { kind: "inconclusive" };
    if (outputs.length === 0) return { kind: "none" };
    const got: ({ amount: number; C_: string } | undefined)[] = new Array(pending.outputs.length);
    let usable = 0;
    for (let i = 0; i < rows.length; i++) {
      const out = outputs[i] as { amount?: unknown; B_?: unknown };
      const B_ = typeof out?.B_ === "string" ? out.B_ : "";
      const amount = typeof out?.amount === "number" ? out.amount : Number.NaN;
      const C_ = signatureC(rows[i], amount);
      if (!C_ || !B_) continue;
      const idx = pending.outputs.findIndex((b) => b.B_ === B_ && b.amount === amount);
      if (idx < 0 || got[idx]) continue;
      got[idx] = { amount, C_ };
      usable++;
    }
    if (usable === 0) return { kind: "inconclusive" };
    if (usable !== pending.outputs.length || got.some((g) => !g)) return { kind: "inconclusive" };
    const proofs = await this.unblindOutputs(pending, got as { amount: number; C_: string }[]);
    if (!proofs) return { kind: "inconclusive" };
    return { kind: "proofs", proofs };
  }

  private async tryCheck(pending: PendingSwap): Promise<"spent" | "unspent" | "pending" | "unknown"> {
    let r: { status: number; text: string };
    try {
      const body = { Ys: pending.inputs.map((p) => secretY(p.secret)) };
      r = await mintFetch(pending.mint, "/v1/checkstate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, this.guard, this.mints);
    } catch {
      return "unknown";
    }
    if (r.status !== 200) return "unknown";
    let states: unknown;
    try { states = JSON.parse(r.text).states; } catch { return "unknown"; }
    if (!Array.isArray(states) || states.length !== pending.inputs.length) return "unknown";
    let spent = 0;
    let unspent = 0;
    let waiting = 0;
    for (const row of states) {
      const state = row && typeof row === "object" ? (row as { state?: unknown }).state : undefined;
      if (state === "SPENT") spent++;
      else if (state === "PENDING") waiting++;
      // CASHU_GUARD pending-not-unspent: PENDING is not an unspent input.
      else if (state === "UNSPENT") unspent++;
    }
    if (waiting > 0) return "pending";
    if (spent === pending.inputs.length) return "spent";
    if (unspent === pending.inputs.length) return "unspent";
    return "unknown";
  }

  private async unblindOutputs(pending: PendingSwap, signatures: { amount: number; C_: string }[]): Promise<StoredProof[] | null> {
    const id = pending.outputs[0]?.id;
    if (!id) return null;
    let keys: Record<string, string>;
    try { keys = await this.keys(pending.mint, id); } catch { return null; }
    try {
      return pending.outputs.map((b, i) => {
        const sig = signatures[i];
        const pub = keys[String(b.amount)];
        if (!sig || !pub) throw new Error("sig");
        const C = unblind(sig.C_, parseR(b.r), pub);
        return { mint: pending.mint, unit: "sat" as const, amount: b.amount, id: b.id, secret: b.secret, C };
      });
    } catch {
      return null;
    }
  }

  private async keysets(mint: string): Promise<KeysetInfo[]> {
    const r = await mintFetch(mint, "/v1/keysets", { method: "GET" }, this.guard, this.mints);
    if (r.status !== 200) throw new TollError("store_unavailable");
    let rows: any[];
    try { rows = JSON.parse(r.text).keysets; } catch { throw new TollError("store_unavailable"); }
    if (!Array.isArray(rows)) throw new TollError("store_unavailable");
    return rows.map((k) => ({
      id: String(k.id ?? "").toLowerCase(),
      unit: String(k.unit ?? ""),
      active: k.active === true,
      input_fee_ppk: Number.isSafeInteger(k.input_fee_ppk) ? k.input_fee_ppk : 0,
      final_expiry: Number.isSafeInteger(k.final_expiry) ? k.final_expiry : null,
    })).filter((k) => k.id.startsWith("01") && k.id.length === 66);
  }

  private async keys(mint: string, id: string): Promise<Record<string, string>> {
    const r = await mintFetch(mint, "/v1/keys/" + id, { method: "GET" }, this.guard, this.mints);
    if (r.status !== 200) throw new TollError("store_unavailable");
    let row: any;
    try { row = JSON.parse(r.text).keysets?.[0]; } catch { throw new TollError("store_unavailable"); }
    const keys = row?.keys;
    if (!keys || typeof keys !== "object") throw new TollError("store_unavailable");
    const out: Record<string, string> = {};
    for (const [amount, pk] of Object.entries(keys)) {
      if (typeof pk === "string") out[amount] = pk.toLowerCase();
    }
    return out;
  }
}
