// Cashu BDHKE (NUT-00) and keyset ids (NUT-02 v2). Version byte 01 is a 33-byte id.
// Tokens carry the first 8 bytes (the short id). The mint's full ids are required to map them.
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { concat, fromHex, toHex, utf8 } from "../../protocol/src/bytes.ts";

const DOMAIN = utf8("Secp256k1_HashToCurve_Cashu_");
const Point = secp256k1.Point;

export function pubkeyHex(secretKey: Uint8Array): string {
  return toHex(secp256k1.getPublicKey(secretKey, true));
}

/** Full v2 keyset id: "01" + SHA-256 hex of the public preimage (66 hex chars, 33 bytes). */
export function deriveKeysetIdV2(keys: Record<string, string>, unit: string, inputFeePpk?: number | null, finalExpiry?: number | null): string {
  const amounts = Object.keys(keys).map((k) => Number(k)).filter((n) => Number.isSafeInteger(n) && n > 0).sort((a, b) => a - b);
  if (amounts.length === 0 || !unit) throw new Error("keyset");
  const pairs = amounts.map((a) => {
    const pk = keys[String(a)];
    if (typeof pk !== "string" || !/^[0-9a-fA-F]{66}$/.test(pk)) throw new Error("keyset");
    return `${a}:${pk.toLowerCase()}`;
  });
  let pre = pairs.join(",") + `|unit:${unit.toLowerCase()}`;
  if (inputFeePpk) pre += `|input_fee_ppk:${inputFeePpk}`;
  if (finalExpiry) pre += `|final_expiry:${finalExpiry}`;
  return "01" + toHex(syncSha(utf8(pre)));
}

function syncSha(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

/** Stable id for a spent secret. The store keeps this, not a second copy of the secret in the spent set. */
export function secretMark(secret: string): string {
  return toHex(syncSha(utf8(secret)));
}

/** First 8 bytes of a full v2 id. This is what a token stores in `i`. */
export function shortKeysetId(fullHex: string): Uint8Array {
  const hex = fullHex.toLowerCase();
  if (!/^01[0-9a-f]{64}$/.test(hex)) throw new Error("keyset id");
  return fromHex(hex.slice(0, 16));
}

/**
 * Map a token keyset id to the mint's full id.
 * A 33-byte id starting with 01 is already full. An 8-byte id starting with 01 is the short form
 * and must match exactly one known full id. An 8-byte id starting with 00 is a legacy full id.
 */
export function resolveKeysetId(id: Uint8Array, knownFullIds: string[]): string {
  const hex = toHex(id);
  const known = knownFullIds.map((s) => s.toLowerCase());
  if (id.length === 33 && id[0] === 0x01) {
    if (!known.includes(hex)) throw new Error("unknown keyset id");
    return hex;
  }
  if (id.length === 8 && id[0] === 0x00) return hex;
  if (id.length === 8 && id[0] === 0x01) {
    const matches = known.filter((k) => k.startsWith(hex));
    if (matches.length !== 1) throw new Error("short keyset id");
    return matches[0];
  }
  throw new Error("keyset id");
}

export function hashToCurve(message: Uint8Array): InstanceType<typeof Point> {
  const msg = syncSha(concat(DOMAIN, message));
  for (let counter = 0; counter < 0x10000; counter++) {
    const ctr = new Uint8Array(4);
    new DataView(ctr.buffer).setUint32(0, counter, true);
    const hash = syncSha(concat(msg, ctr));
    try {
      return Point.fromBytes(concat(Uint8Array.of(0x02), hash));
    } catch {
      /* not a point; try the next counter */
    }
  }
  throw new Error("hash_to_curve");
}

export interface Blinded {
  secret: string;
  r: bigint;
  B_: string;
}

export function blindMessage(secret: string): Blinded {
  const Y = hashToCurve(utf8(secret));
  const r = Point.Fn.fromBytes(secp256k1.utils.randomSecretKey());
  const B_ = Y.add(Point.BASE.multiply(r));
  return { secret, r, B_: toHex(B_.toBytes(true)) };
}

/** Compressed hash-to-curve of a proof secret. NUT-07 calls this `Y`. */
export function secretY(secret: string): string {
  return toHex(hashToCurve(utf8(secret)).toBytes(true));
}

export function unblind(C_: string, r: bigint, mintPub: string): string {
  // CASHU_GUARD c-case: mint replies use either hex case. fromHex accepts lowercase only.
  const C = Point.fromBytes(fromHex(C_.toLowerCase())).subtract(Point.fromBytes(fromHex(mintPub.toLowerCase())).multiply(r));
  return toHex(C.toBytes(true));
}

/** Mint-side: C = k * hash_to_curve(secret). */
export function signSecret(secretKey: Uint8Array, secret: string): string {
  const Y = hashToCurve(utf8(secret));
  const k = Point.Fn.fromBytes(secretKey);
  return toHex(Y.multiply(k).toBytes(true));
}

export function signBlind(secretKey: Uint8Array, B_: string): string {
  const k = Point.Fn.fromBytes(secretKey);
  return toHex(Point.fromBytes(fromHex(B_)).multiply(k).toBytes(true));
}

export function proofMatches(secretKey: Uint8Array, secret: string, C: string): boolean {
  const expect = signSecret(secretKey, secret);
  return expect === C.toLowerCase();
}

/** NUT-02: fees are the sum of per-input ppk, rounded up to the next whole unit. */
export function inputFee(ppk: number[]): number {
  let sum = 0;
  for (const n of ppk) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("fee");
    sum += n;
  }
  return Math.floor((sum + 999) / 1000);
}

/** Greedy split into the keyset's denominations. Null when the amount cannot be made. */
export function splitAmount(amount: number, denoms: number[]): number[] | null {
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const coins = [...denoms].filter((d) => Number.isSafeInteger(d) && d > 0).sort((a, b) => b - a);
  const out: number[] = [];
  let left = amount;
  for (const d of coins) {
    while (left >= d) {
      out.push(d);
      left -= d;
      if (out.length > 64) return null;
    }
  }
  return left === 0 && out.length > 0 ? out : null;
}
