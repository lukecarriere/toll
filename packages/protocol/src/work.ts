// Work rule for algo "pbkdf2-sha256" (spec §9.1, formulation documented in docs/protocol.md §3).
//
//   salt_i   = SHA256(salt || uint32be(i))
//   nonce_i  = 16 lowercase hex chars of a uint64 counter, counter_start <= counter < counter_end
//   DK_i     = PBKDF2-HMAC-SHA256(password = ASCII(nonce_i), salt = salt_i, iter = cost, dkLen = 32)
//   valid    iff the first `bits` bits of DK_i equal targets[i]
//
// The issuer picks a secret counter per sub-puzzle uniformly in the range and publishes the
// prefix of its DK as the target, so effort is bounded: at most (counter_end - counter_start)
// KDF calls per sub-puzzle, on average half that. Verifying costs one KDF call per sub-puzzle.

import { concat, fromB64, toHex, uint32be, utf8 } from "./bytes.ts";
import { sha256 } from "./hmac.ts";

export interface WorkParams {
  salt: string; // base64
  cost: number;
  n: number;
  bits: number;
  counter_start: number;
  counter_end: number;
  targets: string[];
}

export type Kdf = (password: Uint8Array, salt: Uint8Array, iterations: number) => Promise<Uint8Array>;

/** Default KDF: WebCrypto PBKDF2-HMAC-SHA256, 32-byte output. Native in Node, browsers and workers. */
export const webCryptoKdf: Kdf = async (password, salt, iterations) => {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey("raw", password as BufferSource, "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
};

export function nonceHex(counter: number): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("bad counter");
  return counter.toString(16).padStart(16, "0");
}

export function parseNonce(nonce: unknown): number | null {
  if (typeof nonce !== "string" || !/^[0-9a-f]{16}$/.test(nonce)) return null;
  const v = parseInt(nonce, 16);
  return Number.isSafeInteger(v) ? v : null;
}

export async function subSalt(saltB64: string, i: number): Promise<Uint8Array> {
  return sha256(concat(fromB64(saltB64), uint32be(i)));
}

export function prefixHex(dk: Uint8Array, bits: number): string {
  return toHex(dk.subarray(0, bits / 8));
}

export async function deriveDk(nonce: string, salt_i: Uint8Array, cost: number, kdf: Kdf = webCryptoKdf): Promise<Uint8Array> {
  return kdf(utf8(nonce), salt_i, cost);
}

/** Check a full solution. Returns false on the first wrong sub-puzzle (stops early). */
export async function verifyWork(p: WorkParams, nonces: unknown, kdf: Kdf = webCryptoKdf): Promise<boolean> {
  if (!Array.isArray(nonces) || nonces.length !== p.n) return false;
  for (let i = 0; i < p.n; i++) {
    const c = parseNonce(nonces[i]);
    if (c === null || c < p.counter_start || c >= p.counter_end) return false;
    const dk = await deriveDk(nonces[i], await subSalt(p.salt, i), p.cost, kdf);
    if (prefixHex(dk, p.bits) !== p.targets[i]) return false;
  }
  return true;
}

export interface SolveOptions {
  kdf?: Kdf;
  /** KDF calls kept in flight per sub-puzzle. */
  inflight?: number;
  /** Solve all sub-puzzles at the same time instead of one after another. */
  parallel?: boolean;
  signal?: AbortSignal;
}

export interface SolveResult {
  nonces: string[];
  tries: number;
}

async function solveOne(p: WorkParams, i: number, o: SolveOptions): Promise<{ nonce: string; tries: number }> {
  const kdf = o.kdf ?? webCryptoKdf;
  const inflight = Math.max(1, o.inflight ?? 1);
  const salt_i = await subSalt(p.salt, i);
  const target = p.targets[i];
  let next = p.counter_start;
  let tries = 0;
  while (next < p.counter_end) {
    if (o.signal?.aborted) throw new Error("aborted");
    const batch: number[] = [];
    while (batch.length < inflight && next < p.counter_end) batch.push(next++);
    const dks = await Promise.all(batch.map((c) => deriveDk(nonceHex(c), salt_i, p.cost, kdf)));
    for (let k = 0; k < batch.length; k++) {
      tries++;
      if (prefixHex(dks[k], p.bits) === target) return { nonce: nonceHex(batch[k]), tries };
    }
  }
  throw new Error("no solution in range");
}

export async function solveWork(p: WorkParams, o: SolveOptions = {}): Promise<SolveResult> {
  const idx = Array.from({ length: p.n }, (_, i) => i);
  let parts: { nonce: string; tries: number }[];
  if (o.parallel) {
    parts = await Promise.all(idx.map((i) => solveOne(p, i, o)));
  } else {
    parts = [];
    for (const i of idx) parts.push(await solveOne(p, i, o));
  }
  return { nonces: parts.map((x) => x.nonce), tries: parts.reduce((a, x) => a + x.tries, 0) };
}
