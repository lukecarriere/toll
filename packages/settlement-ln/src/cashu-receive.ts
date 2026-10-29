// Production Cashu receive. A cashuB token is swapped at an allowlisted mint into proofs this
// process keeps. Short version-01 keyset ids are mapped with the mint's keyset list first.
// The test engine (cashu-engine.ts) is unchanged and still talks only to a loopback http mint.
import {
  type ActionClass, TollError, canonicalJson, fromB64url, fromUtf8, hmacSha256, hmacVerify, randomBytes, randomHex, sha256, toB64url, toHex, utf8,
} from "../../protocol/src/index.ts";
import { CASHU_UNIT, decodeTokenV4, encodePaymentRequest, type DecodedToken } from "./cashu.ts";
import { blindMessage, deriveKeysetIdV2, inputFee, resolveKeysetId, secretMark, splitAmount, unblind } from "./cashu-crypto.ts";
import { type MintGuard, guardMintUrl, mintFetch, mintKey } from "./cashu-net.ts";
import { FileProofStore, type StoredProof } from "./cashu-store.ts";
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

export interface ReceiveEngineOptions extends MintGuard {
  secret: string;
  mints: string[];
  store: string | FileProofStore;
}

export class CashuReceiveEngine implements SettlementEngine {
  readonly kind = "cashu" as const;
  private secret: string;
  readonly mints: string[];
  private guard: MintGuard;
  private store: FileProofStore;

  constructor(o: ReceiveEngineOptions) {
    if (!o.secret || o.secret.length < 16) throw new Error("cashu engine: secret too short");
    if (!Array.isArray(o.mints) || o.mints.length === 0) throw new Error("cashu engine: allowlist is empty");
    this.secret = o.secret;
    this.mints = o.mints.map((m) => mintKey(m));
    this.guard = { loopbackHttp: o.loopbackHttp, lookup: o.lookup, fetch: o.fetch };
    this.store = typeof o.store === "string" ? new FileProofStore(o.store) : o.store;
  }

  async offer(o: { site: string; cls: PaidClass; amount_msat: number; now: number; ttl_s?: number }): Promise<CashuOffer> {
    if (!Number.isSafeInteger(o.amount_msat) || o.amount_msat <= 0 || o.amount_msat % 1000 !== 0) throw new Error("offer amount must be a positive whole number of 1,000 msat");
    const live = await this.liveMints();
    if (live.length === 0) throw new Error("mint unavailable");
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
    try { token = decodeTokenV4(o.proof.token); } catch { throw new TollError("malformed"); }
    if (token.proofs.length > 32) throw new TollError("malformed");
    if (token.unit !== CASHU_UNIT) throw new TollError("malformed");
    let mint: string;
    try { mint = mintKey(token.mint); } catch { throw new TollError("malformed"); }
    const sealed = c.mints.map((m) => { try { return mintKey(m); } catch { return ""; } });
    if (!sealed.includes(mint)) throw new TollError("malformed");
    // Allowlist and https/SSRF before any request. A removed check would call a mint that is not listed.
    try { await guardMintUrl(mint, this.mints, this.guard); } catch (e) {
      if (e instanceof TollError) throw e;
      throw new TollError("malformed");
    }
    const sum = token.proofs.reduce((n, p) => n + p.amount, 0);
    if (!Number.isSafeInteger(sum) || sum < c.amount) throw new TollError("malformed");
    const marks = token.proofs.map((p) => secretMark(p.secret));
    const received = await this.store.transaction(async (s) => {
      if (marks.some((h) => s.spent.has(h))) throw new TollError("replay");
      const proofs = await this.swapIn(mint, token);
      s.addProofs(proofs);
      s.addSpent(marks);
      return proofs;
    });
    if (received.reduce((n, p) => n + p.amount, 0) <= 0) throw new TollError("store_unavailable");
    const ttl = Math.max(1, c.exp - o.now + 60);
    if (!(await o.firstUse("offer:" + c.offer_id, ttl))) throw new TollError("replay");
    const ref = toHex(await sha256(utf8(marks.slice().sort().join("\n"))));
    if (!(await o.firstUse("cashu:" + ref, ttl))) throw new TollError("replay");
    return { cls: c.cls, amount_msat: c.amount_msat, payment_ref: ref };
  }

  async healthy(): Promise<boolean> {
    return (await this.liveMints()).length > 0;
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

  private async swapIn(mint: string, token: DecodedToken): Promise<StoredProof[]> {
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
    if (!active) throw new TollError("store_unavailable");
    const keys = await this.keys(mint, active.id);
    const derived = deriveKeysetIdV2(keys, active.unit, active.input_fee_ppk, active.final_expiry);
    if (derived !== active.id.toLowerCase()) throw new TollError("bad_solution");
    const denoms = Object.keys(keys).map(Number);
    const amounts = splitAmount(outAmount, denoms);
    if (!amounts) throw new TollError("bad_solution");
    const blinded = amounts.map((amount) => ({ amount, ...blindMessage(toHex(randomBytes(32))) }));
    const body = {
      inputs: proofs.map((p) => ({ amount: p.amount, id: p.id, secret: p.secret, C: p.C })),
      outputs: blinded.map((b) => ({ amount: b.amount, id: active.id, B_: b.B_ })),
    };
    const r = await mintFetch(mint, "/v1/swap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, this.guard, this.mints);
    if (r.status !== 200) {
      let code = 0;
      try { code = Number(JSON.parse(r.text).code); } catch { /* not JSON */ }
      if (code === 11001) throw new TollError("replay");
      if (r.status >= 500 || code === 0) throw new TollError("store_unavailable");
      throw new TollError("bad_solution");
    }
    let signatures: { amount?: number; C_?: string }[];
    try { signatures = JSON.parse(r.text).signatures; } catch { throw new TollError("store_unavailable"); }
    if (!Array.isArray(signatures) || signatures.length !== blinded.length) throw new TollError("store_unavailable");
    return blinded.map((b, i) => {
      const sig = signatures[i];
      if (!sig || sig.amount !== b.amount || typeof sig.C_ !== "string") throw new TollError("store_unavailable");
      const C = unblind(sig.C_, b.r, keys[String(b.amount)]);
      return { mint, unit: "sat" as const, amount: b.amount, id: active.id.toLowerCase(), secret: b.secret, C };
    });
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
