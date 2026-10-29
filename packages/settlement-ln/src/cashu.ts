// NUT-24 payment requests (NUT-18 `creqA`) and NUT-00 V4 tokens (`cashuB`).
// `cashuA` (V3) is recognised only so a caller can refuse it. This build does not mint or accept it.
import { fromB64url, toB64url, toHex } from "../../protocol/src/bytes.ts";
import { cborDecode, cborEncode, type Cbor } from "./cbor.ts";

/** Request unit for this test rail. Amounts are whole units of 1,000 msat (settlement.md Q3). */
export const CASHU_UNIT = "sat" as const;

export interface PaymentRequest {
  a: number;
  u: string;
  m: string[];
  s?: boolean;
  i?: string;
}

export interface CashuProof {
  amount: number;
  secret: string;
  id: Uint8Array;
  C: Uint8Array;
}

export interface DecodedToken {
  mint: string;
  unit: string;
  proofs: CashuProof[];
}

export function stripMint(url: string): string {
  return url.replace(/\/+$/, "");
}

function b64(s: string): Uint8Array {
  return fromB64url(s.replace(/=+$/, ""));
}

function isObj(v: Cbor): v is { [k: string]: Cbor } {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array);
}

/** `creqA` + base64url(CBOR). No transport: NUT-24 payment is in-band on `X-Cashu`. */
export function encodePaymentRequest(req: PaymentRequest): string {
  const obj: { [k: string]: Cbor } = { a: req.a, u: req.u, m: req.m.map(stripMint) };
  if (req.i) obj.i = req.i;
  if (req.s === true) obj.s = true;
  return "creqA" + toB64url(cborEncode(obj));
}

export function decodePaymentRequest(s: string): PaymentRequest {
  if (!s.startsWith("creqA")) throw new Error("not a creqA payment request");
  const v = cborDecode(b64(s.slice(5)));
  if (!isObj(v) || typeof v.a !== "number" || !Number.isSafeInteger(v.a) || typeof v.u !== "string" || !Array.isArray(v.m) || !v.m.every((x) => typeof x === "string")) {
    throw new Error("payment request");
  }
  const out: PaymentRequest = { a: v.a, u: v.u, m: (v.m as string[]).map(stripMint) };
  if (v.s === true) out.s = true;
  if (typeof v.i === "string") out.i = v.i;
  return out;
}

/** `cashuB` + base64url(CBOR). One mint. Proofs are grouped by keyset id. */
export function encodeTokenV4(t: { mint: string; unit: string; proofs: CashuProof[] }): string {
  const groups = new Map<string, { i: Uint8Array; p: Cbor[] }>();
  for (const pr of t.proofs) {
    const key = toHex(pr.id);
    let g = groups.get(key);
    if (!g) {
      g = { i: pr.id, p: [] };
      groups.set(key, g);
    }
    g.p.push({ a: pr.amount, s: pr.secret, c: pr.C });
  }
  const token: { [k: string]: Cbor } = {
    m: stripMint(t.mint),
    u: t.unit,
    t: [...groups.values()].map((g) => ({ i: g.i, p: g.p })),
  };
  return "cashuB" + toB64url(cborEncode(token));
}

export function decodeTokenV4(s: string): DecodedToken {
  if (!s.startsWith("cashuB")) throw new Error("not a cashuB token");
  const v = cborDecode(b64(s.slice(6)));
  if (!isObj(v) || typeof v.m !== "string" || typeof v.u !== "string" || !Array.isArray(v.t)) throw new Error("token");
  const proofs: CashuProof[] = [];
  for (const group of v.t) {
    if (!isObj(group) || !(group.i instanceof Uint8Array) || !Array.isArray(group.p)) throw new Error("token");
    for (const p of group.p) {
      if (!isObj(p) || typeof p.a !== "number" || !Number.isSafeInteger(p.a) || p.a <= 0 || typeof p.s !== "string" || !(p.c instanceof Uint8Array)) throw new Error("token");
      proofs.push({ amount: p.a, secret: p.s, id: group.i, C: p.c });
    }
  }
  if (proofs.length === 0) throw new Error("token");
  return { mint: stripMint(v.m), unit: v.u, proofs };
}

/**
 * What a client put in `X-Cashu` on a retry. `b` is a V4 token. `a` is the older V3 token, which
 * this build refuses. A payment request (`creqA`) is not a payment.
 */
export function presentedCashu(header: string | string[] | null | undefined): { kind: "a" } | { kind: "b"; token: string } | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.startsWith("cashuB")) return { kind: "b", token: t };
  if (t.startsWith("cashuA")) return { kind: "a" };
  return null;
}
