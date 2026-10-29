// Pay a Toll creqA from a cashuB token or from proofs you already hold.
// An exact amount is sent as it is. A larger amount is swapped at the mint first; the change,
// when there is any, is handed to `onChange` as a cashuB string.
import { AgentError, type AgentOffer } from "./index.ts";
import { CASHU_UNIT, decodePaymentRequest, decodeTokenV4, encodeTokenV4, type CashuProof } from "../../settlement-ln/src/cashu.ts";
import { blindMessage, deriveKeysetIdV2, inputFee, resolveKeysetId, shortKeysetId, splitAmount, unblind } from "../../settlement-ln/src/cashu-crypto.ts";
import { type MintGuard, mintFetch, mintKey } from "../../settlement-ln/src/cashu-net.ts";
import { fromHex, randomBytes, toHex } from "../../protocol/src/bytes.ts";

export interface CashuPaySource {
  /** A cashuB string. */
  token?: string;
  /** Proofs already held. `id` is the full or short keyset id, hex. `mint` is required with this form. */
  proofs?: { amount: number; secret: string; id: string; C: string }[];
  mint?: string;
}

export interface CashuPayerOptions {
  fetch?: typeof fetch;
  /** Called with a cashuB string for the change, when the source was larger than the request. */
  onChange?: (token: string) => void;
}

interface Held {
  mint: string;
  amount: number;
  secret: string;
  id: Uint8Array;
  C: Uint8Array;
}

export function cashuPayer(source: CashuPaySource, opts: CashuPayerOptions = {}) {
  const guard: MintGuard = { loopbackHttp: true, fetch: opts.fetch };
  return async (offer: AgentOffer): Promise<string> => {
    if (offer.kind !== "cashu") throw new AgentError("pay", "not a cashu offer");
    let req: ReturnType<typeof decodePaymentRequest>;
    try { req = decodePaymentRequest(offer.request); } catch { throw new AgentError("pay", "payment request"); }
    if (req.u !== CASHU_UNIT || !Number.isSafeInteger(req.a) || req.a <= 0) throw new AgentError("pay", "payment request");
    if (offer.amount !== req.a) throw new AgentError("pay", "payment request");
    const held = load(source);
    const mint = held.mint;
    let allowed = false;
    for (const m of req.m) {
      try { if (mintKey(m) === mint) allowed = true; } catch { /* skip a bad entry in the request */ }
    }
    if (!allowed) throw new AgentError("pay", "mint is not in the payment request");
    const sum = held.proofs.reduce((n, p) => n + p.amount, 0);
    if (sum < req.a) throw new AgentError("pay", "not enough");
    if (sum === req.a && typeof source.token === "string") return source.token;
    if (sum === req.a) return encode(mint, held.proofs);
    const list = await keysets(mint, req.m, guard);
    const known = list.map((k) => k.id);
    const inputs = held.proofs.map((p) => {
      try { return { ...p, full: resolveKeysetId(p.id, known) }; } catch { throw new AgentError("pay", "keyset id"); }
    });
    const byId = new Map(list.map((k) => [k.id, k]));
    const fee = inputFee(inputs.map((p) => byId.get(p.full)?.input_fee_ppk ?? 0));
    const active = list.find((k) => k.active && k.unit === CASHU_UNIT);
    if (!active) throw new AgentError("pay", "mint has no active keyset");
    const keys = await loadKeys(mint, active.id, req.m, guard);
    if (deriveKeysetIdV2(keys, active.unit, active.input_fee_ppk, active.final_expiry) !== active.id) throw new AgentError("pay", "keyset id");
    const spend = sum - fee;
    if (spend < req.a) throw new AgentError("pay", "not enough");
    const payAmounts = splitAmount(req.a, Object.keys(keys).map(Number));
    const changeAmounts = spend === req.a ? [] : splitAmount(spend - req.a, Object.keys(keys).map(Number));
    if (!payAmounts || (spend !== req.a && !changeAmounts)) throw new AgentError("pay", "amount");
    const blinded = [...payAmounts, ...(changeAmounts ?? [])].map((amount) => ({ amount, ...blindMessage(toHex(randomBytes(32))) }));
    const body = {
      inputs: inputs.map((p) => ({ amount: p.amount, id: p.full, secret: p.secret, C: toHex(p.C) })),
      outputs: blinded.map((b) => ({ amount: b.amount, id: active.id, B_: b.B_ })),
    };
    const r = await mintFetch(mint, "/v1/swap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, guard, req.m);
    if (r.status !== 200) throw new AgentError("pay", "mint refused", r.status);
    let signatures: { amount?: number; C_?: string }[];
    try { signatures = JSON.parse(r.text).signatures; } catch { throw new AgentError("pay", "mint refused"); }
    if (!Array.isArray(signatures) || signatures.length !== blinded.length) throw new AgentError("pay", "mint refused");
    const short = shortKeysetId(active.id);
    const out: Held[] = blinded.map((b, i) => {
      const sig = signatures[i];
      if (!sig || typeof sig.C_ !== "string" || sig.amount !== b.amount) throw new AgentError("pay", "mint refused");
      return { mint, amount: b.amount, secret: b.secret, id: short, C: fromHex(unblind(sig.C_, b.r, keys[String(b.amount)])) };
    });
    const pay = out.slice(0, payAmounts.length);
    const change = out.slice(payAmounts.length);
    if (change.length > 0 && opts.onChange) opts.onChange(encode(mint, change));
    return encode(mint, pay);
  };
}

function load(source: CashuPaySource): { mint: string; proofs: Held[] } {
  if (typeof source.token === "string" && source.token.startsWith("cashuB")) {
    let t: ReturnType<typeof decodeTokenV4>;
    try { t = decodeTokenV4(source.token); } catch { throw new AgentError("pay", "token"); }
    let mint: string;
    try { mint = mintKey(t.mint); } catch { throw new AgentError("pay", "token"); }
    return { mint, proofs: t.proofs.map((p) => ({ mint, amount: p.amount, secret: p.secret, id: p.id, C: p.C })) };
  }
  if (!source.proofs || source.proofs.length === 0 || typeof source.mint !== "string") throw new AgentError("pay", "no proofs");
  let mint: string;
  try { mint = mintKey(source.mint); } catch { throw new AgentError("pay", "mint"); }
  const proofs = source.proofs.map((p) => {
    if (!Number.isSafeInteger(p.amount) || p.amount <= 0 || typeof p.secret !== "string" || typeof p.id !== "string" || typeof p.C !== "string") throw new AgentError("pay", "proofs");
    return { mint, amount: p.amount, secret: p.secret, id: fromHex(p.id.toLowerCase()), C: fromHex(p.C.toLowerCase()) };
  });
  return { mint, proofs };
}

function encode(mint: string, proofs: Held[]): string {
  const wire: CashuProof[] = proofs.map((p) => ({ amount: p.amount, secret: p.secret, id: p.id, C: p.C }));
  return encodeTokenV4({ mint, unit: CASHU_UNIT, proofs: wire });
}

async function keysets(mint: string, allow: string[], guard: MintGuard): Promise<{ id: string; unit: string; active: boolean; input_fee_ppk: number; final_expiry: number | null }[]> {
  const r = await mintFetch(mint, "/v1/keysets", { method: "GET" }, guard, allow);
  if (r.status !== 200) throw new AgentError("pay", "mint unavailable", r.status);
  const rows = JSON.parse(r.text).keysets;
  if (!Array.isArray(rows)) throw new AgentError("pay", "mint unavailable");
  return rows.map((k: any) => ({
    id: String(k.id ?? "").toLowerCase(),
    unit: String(k.unit ?? ""),
    active: k.active === true,
    input_fee_ppk: Number.isSafeInteger(k.input_fee_ppk) ? k.input_fee_ppk : 0,
    final_expiry: Number.isSafeInteger(k.final_expiry) ? k.final_expiry : null,
  })).filter((k: { id: string }) => /^01[0-9a-f]{64}$/.test(k.id));
}

async function loadKeys(mint: string, id: string, allow: string[], guard: MintGuard): Promise<Record<string, string>> {
  const r = await mintFetch(mint, "/v1/keys/" + id, { method: "GET" }, guard, allow);
  if (r.status !== 200) throw new AgentError("pay", "mint unavailable", r.status);
  const keys = JSON.parse(r.text).keysets?.[0]?.keys;
  if (!keys || typeof keys !== "object") throw new AgentError("pay", "mint unavailable");
  const out: Record<string, string> = {};
  for (const [amount, pk] of Object.entries(keys)) if (typeof pk === "string") out[amount] = pk.toLowerCase();
  return out;
}
