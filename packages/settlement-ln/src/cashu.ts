// NUT-24 payment requests (NUT-18 `creqA`) and NUT-00 tokens.
// `cashuA` (V3 JSON) and `cashuB` (V4 CBOR) are both payments. Change is encoded as `cashuB`.
// A `creqA` string is a request, not a payment.
import { fromB64url, fromHex, fromUtf8, toB64url, toHex, utf8 } from "../../protocol/src/bytes.ts";
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
  if (!isObj(v) || typeof v.m !== "string" || !Array.isArray(v.t)) throw new Error("token");
  if (v.u !== undefined && typeof v.u !== "string") throw new Error("token");
  const unit = typeof v.u === "string" && v.u !== "" ? v.u : CASHU_UNIT;
  const proofs: CashuProof[] = [];
  for (const group of v.t) {
    if (!isObj(group) || !(group.i instanceof Uint8Array) || !Array.isArray(group.p)) throw new Error("token");
    for (const p of group.p) {
      if (!isObj(p) || typeof p.a !== "number" || !Number.isSafeInteger(p.a) || p.a <= 0 || typeof p.s !== "string" || !(p.c instanceof Uint8Array)) throw new Error("token");
      proofs.push({ amount: p.a, secret: p.s, id: group.i, C: p.c });
    }
  }
  if (proofs.length === 0) throw new Error("token");
  return { mint: stripMint(v.m), unit, proofs };
}

/**
 * `cashuA` + base64url(JSON). One mint. Keyset ids are the short form (first 8 bytes, 16 hex chars).
 * Several proofs from that mint may be split across `token` entries; decode merges those.
 */
export function encodeTokenV3(t: { mint: string; unit: string; proofs: CashuProof[] }): string {
  if (t.proofs.length === 0) throw new Error("token");
  const proofs = t.proofs.map((p) => ({
    amount: p.amount,
    id: toHex(p.id).slice(0, 16),
    secret: p.secret,
    C: toHex(p.C),
  }));
  const obj = { token: [{ mint: stripMint(t.mint), proofs }], unit: t.unit };
  return "cashuA" + toB64url(utf8(JSON.stringify(obj)));
}

function proofFromV3(p: unknown): CashuProof {
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("token");
  const row = p as Record<string, unknown>;
  const C = row.C ?? row.c;
  if (typeof row.amount !== "number" || !Number.isSafeInteger(row.amount) || row.amount <= 0) throw new Error("token");
  if (typeof row.secret !== "string" || typeof row.id !== "string" || typeof C !== "string") throw new Error("token");
  const idHex = row.id.toLowerCase();
  const cHex = C.toLowerCase();
  if (!/^[0-9a-f]+$/.test(idHex) || idHex.length % 2 !== 0) throw new Error("token");
  if (!/^[0-9a-f]+$/.test(cHex) || cHex.length % 2 !== 0 || cHex.length === 0) throw new Error("token");
  const id = fromHex(idHex);
  // 8 bytes: short version-01 id, or a legacy version-00 id. 33 bytes: the full version-01 id.
  if (id.length !== 8 && id.length !== 33) throw new Error("token");
  return { amount: row.amount, secret: row.secret, id, C: fromHex(cHex) };
}

/** `cashuA` + base64url(JSON). Entries from one mint are merged. Two mints in one string are refused. */
export function decodeTokenV3(s: string): DecodedToken {
  if (!s.startsWith("cashuA")) throw new Error("not a cashuA token");
  let v: unknown;
  try { v = JSON.parse(fromUtf8(b64(s.slice(6)))); } catch { throw new Error("token"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("token");
  const obj = v as Record<string, unknown>;
  if (!Array.isArray(obj.token) || obj.token.length === 0) throw new Error("token");
  if (obj.unit !== undefined && typeof obj.unit !== "string") throw new Error("token");
  let mint = "";
  let unit = typeof obj.unit === "string" ? obj.unit : "";
  const proofs: CashuProof[] = [];
  for (const entry of obj.token) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("token");
    const row = entry as Record<string, unknown>;
    if (typeof row.mint !== "string" || !Array.isArray(row.proofs)) throw new Error("token");
    const m = stripMint(row.mint);
    if (m === "") throw new Error("token");
    if (!mint) mint = m;
    else if (mint !== m) throw new Error("token");
    if (row.unit !== undefined && typeof row.unit !== "string") throw new Error("token");
    if (typeof row.unit === "string") {
      if (unit !== "" && unit !== row.unit) throw new Error("token");
      if (unit === "") unit = row.unit;
    }
    for (const p of row.proofs) proofs.push(proofFromV3(p));
  }
  if (proofs.length === 0) throw new Error("token");
  if (unit === "") unit = CASHU_UNIT;
  return { mint, unit, proofs };
}

/** A V3 or V4 payment. A URI prefix (`cashu:`, `cashu://`, `web+cashu://`) is stripped first. */
export function decodeToken(s: string): DecodedToken {
  const token = asCashuPayment(s);
  if (!token) throw new Error("token");
  return token.startsWith("cashuA") ? decodeTokenV3(token) : decodeTokenV4(token);
}

const URI_PREFIXES = ["web+cashu://", "cashu://", "cashu:"];

/**
 * The payment string inside a header or redeem field. Null when it is not a V3 or V4 token.
 * A payment request (`creqA`) is not a payment.
 */
export function asCashuPayment(header: string): string | null {
  let t = header.trim();
  for (;;) {
    const prefix = URI_PREFIXES.find((p) => t.startsWith(p));
    if (!prefix) break;
    t = t.slice(prefix.length).trim();
  }
  if (t.startsWith("cashuA") || t.startsWith("cashuB")) return t;
  return null;
}

/**
 * What a client put in `X-Cashu` on a retry. `a` is a V3 token and `b` is a V4 token.
 * A payment request (`creqA`) is not a payment.
 */
export function presentedCashu(header: string | string[] | null | undefined): { kind: "a" | "b"; token: string } | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return null;
  const token = asCashuPayment(raw);
  if (!token) return null;
  return { kind: token.startsWith("cashuA") ? "a" : "b", token };
}
