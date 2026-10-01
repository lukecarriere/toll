// Challenge envelope, spec §8.1 as amended (Amendment 1 §C). Toll owns id, site, binding, times
// and the signature. The puzzle is the work engine's payload, carried opaque in `work`.

import { canonicalJson } from "./canonical.ts";
import { fromB64, randomHex, toB64, utf8, fromHex } from "./bytes.ts";
import { hmacSha256, hmacVerify } from "./hmac.ts";
import { type ActionClass, isActionClass } from "./classes.ts";
import { TollError } from "./errors.ts";
import type { WorkAlg } from "./policy.ts";

export const PROTOCOL_VERSION = 1;
export const MAX_CHALLENGE_TTL_S = 120;
/** Upper bound on the canonical JSON size of the engine payload. */
export const MAX_WORK_BYTES = 4096;
export const WORK_ALGS: readonly WorkAlg[] = ["pbkdf2-sha256", "argon2id"];

export interface Challenge {
  v: 1;
  id: string;
  site: string;
  /** Engine algorithm, so clients can pick a solver before looking inside `work`. */
  alg: WorkAlg;
  /** Opaque engine payload (docs/adapters.md). Covered by `sig`. */
  work: Record<string, unknown>;
  bound: { action: ActionClass; path_prefix: string };
  iat: number;
  exp: number;
  sig: string;
}

export type UnsignedChallenge = Omit<Challenge, "sig">;

export interface MintChallengeInput {
  secret: string;
  site: string;
  action: ActionClass;
  path_prefix: string;
  alg: WorkAlg;
  ttl_s: number;
  now: number;
  /** Builds the engine payload for this challenge id and expiry (the work adapter). */
  makeWork: (tid: string, exp: number) => Promise<Record<string, unknown>>;
  /** Test hook for deterministic vectors. Never set in production. */
  fixed?: { id?: string };
}

export function challengeSigningBytes(c: UnsignedChallenge | Challenge): Uint8Array {
  const { sig: _sig, ...rest } = c as Challenge;
  return utf8(canonicalJson(rest));
}

export async function signChallenge(secret: string, c: UnsignedChallenge): Promise<Challenge> {
  const sig = toB64(await hmacSha256(secret, challengeSigningBytes(c)));
  return { ...c, sig };
}

export async function mintChallenge(m: MintChallengeInput): Promise<Challenge> {
  if (!isActionClass(m.action) || m.action === "read") throw new TollError("malformed", "no challenge for read");
  if (m.ttl_s <= 0 || m.ttl_s > MAX_CHALLENGE_TTL_S) throw new TollError("malformed", "ttl must be 1..120s");
  if (!WORK_ALGS.includes(m.alg)) throw new TollError("unsupported", "unsupported alg");
  const id = m.fixed?.id ?? randomHex(16);
  const exp = m.now + m.ttl_s;
  const work = await m.makeWork(id, exp);
  const unsigned: UnsignedChallenge = {
    v: 1,
    id,
    site: m.site,
    alg: m.alg,
    work,
    bound: { action: m.action, path_prefix: m.path_prefix },
    iat: m.now,
    exp,
  };
  return signChallenge(m.secret, unsigned);
}

const isInt = (x: unknown, lo: number, hi: number): x is number => Number.isSafeInteger(x) && (x as number) >= lo && (x as number) <= hi;

/** Structural check. Throws TollError("malformed" | "unsupported" | "bad_sig"). */
export function assertChallengeShape(c: unknown): asserts c is Challenge {
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new TollError("malformed", "challenge must be an object");
  const o = c as Record<string, unknown>;
  const allowed = new Set(["v", "id", "site", "alg", "work", "bound", "iat", "exp", "sig"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new TollError("malformed", "unknown field " + k);
  if (o.v !== 1) throw new TollError("unsupported", "unsupported version");
  if (!WORK_ALGS.includes(o.alg as WorkAlg)) throw new TollError("unsupported", "unsupported alg");
  if (typeof o.id !== "string" || !/^[0-9a-f]{32}$/.test(o.id)) throw new TollError("malformed", "bad id");
  if (typeof o.site !== "string" || o.site.length < 1 || o.site.length > 128) throw new TollError("malformed", "bad site");
  if (!o.work || typeof o.work !== "object" || Array.isArray(o.work)) throw new TollError("malformed", "bad work");
  let workLen = 0;
  try { workLen = canonicalJson(o.work).length; } catch { throw new TollError("malformed", "bad work"); }
  if (workLen > MAX_WORK_BYTES) throw new TollError("malformed", "work payload too large");
  const b = o.bound as Record<string, unknown> | undefined;
  if (!b || typeof b !== "object" || Object.keys(b).length !== 2 || !isActionClass(b.action) || b.action === "read" || typeof b.path_prefix !== "string" || !b.path_prefix.startsWith("/")) throw new TollError("malformed", "bad bound");
  if (!isInt(o.iat, 0, Number.MAX_SAFE_INTEGER) || !isInt(o.exp, 0, Number.MAX_SAFE_INTEGER)) throw new TollError("malformed", "bad times");
  const ttl = (o.exp as number) - (o.iat as number);
  if (ttl <= 0 || ttl > MAX_CHALLENGE_TTL_S) throw new TollError("malformed", "ttl must be 1..120s");
  if (typeof o.sig !== "string") throw new TollError("bad_sig", "unsigned challenge");
}

/**
 * Signature, time and site checks. Cheap, so run before the engine verifies any work.
 * Clock skew: iat may be up to `skew_s` in the future.
 */
export async function checkChallenge(secret: string, c: unknown, opts: { now: number; site?: string; skew_s?: number }): Promise<Challenge> {
  assertChallengeShape(c);
  let mac: Uint8Array;
  try { mac = fromB64(c.sig); } catch { throw new TollError("bad_sig"); }
  if (!(await hmacVerify(secret, challengeSigningBytes(c), mac))) throw new TollError("bad_sig");
  const skew = opts.skew_s ?? 5;
  if (c.iat > opts.now + skew) throw new TollError("not_yet_valid");
  if (opts.now > c.exp) throw new TollError("expired");
  if (opts.site !== undefined && c.site !== opts.site) throw new TollError("wrong_site");
  return c;
}

export { fromHex };
