// Challenge object, spec §8.1, plus the work fields from docs/protocol.md §3.

import { canonicalJson } from "./canonical.ts";
import { fromB64, randomBytes, randomHex, randomInt, toB64, utf8, fromHex } from "./bytes.ts";
import { hmacSha256, hmacVerify } from "./hmac.ts";
import { type ActionClass, isActionClass } from "./classes.ts";
import { TollError } from "./errors.ts";
import { type Kdf, deriveDk, nonceHex, prefixHex, subSalt, webCryptoKdf } from "./work.ts";

export const PROTOCOL_VERSION = 1;
export const MAX_CHALLENGE_TTL_S = 120;
export const MAX_SPAN = 1 << 24;

export interface Challenge {
  v: 1;
  id: string;
  site: string;
  algo: "pbkdf2-sha256";
  cost: number;
  n: number;
  bits: number;
  counter_start: number;
  counter_end: number;
  targets: string[];
  mem_kib: number;
  parallelism: number;
  salt: string;
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
  cost: number;
  n: number;
  bits: number;
  span: number;
  ttl_s: number;
  now: number;
  kdf?: Kdf;
  /** Test hooks for deterministic vectors. Never set these in production. */
  fixed?: { id?: string; salt?: string; counter_start?: number; secret_counters?: number[] };
}

export function challengeSigningBytes(c: UnsignedChallenge | Challenge): Uint8Array {
  const { sig: _sig, ...rest } = c as Challenge;
  return utf8(canonicalJson(rest));
}

export async function signChallenge(secret: string, c: UnsignedChallenge): Promise<Challenge> {
  const sig = toB64(await hmacSha256(secret, challengeSigningBytes(c)));
  return { ...c, sig };
}

export async function mintChallenge(m: MintChallengeInput): Promise<{ challenge: Challenge; secret_counters: number[] }> {
  if (!isActionClass(m.action) || m.action === "read") throw new TollError("malformed", "no challenge for read");
  if (m.ttl_s <= 0 || m.ttl_s > MAX_CHALLENGE_TTL_S) throw new TollError("malformed", "ttl must be 1..120s");
  if (!Number.isInteger(m.span) || m.span < 1 || m.span > MAX_SPAN) throw new TollError("malformed", "bad span");
  if (m.bits % 8 !== 0 || m.bits < 8 || m.bits > 64) throw new TollError("malformed", "bits must be 8..64, multiple of 8");
  const kdf = m.kdf ?? webCryptoKdf;
  const id = m.fixed?.id ?? randomHex(16);
  const salt = m.fixed?.salt ?? toB64(randomBytes(16));
  const counter_start = m.fixed?.counter_start ?? randomInt(0x100000000);
  const counter_end = counter_start + m.span;
  const secret_counters: number[] = [];
  const targets: string[] = [];
  for (let i = 0; i < m.n; i++) {
    const x = m.fixed?.secret_counters?.[i] ?? counter_start + randomInt(m.span);
    secret_counters.push(x);
    const dk = await deriveDk(nonceHex(x), await subSalt(salt, i), m.cost, kdf);
    targets.push(prefixHex(dk, m.bits));
  }
  const unsigned: UnsignedChallenge = {
    v: 1,
    id,
    site: m.site,
    algo: "pbkdf2-sha256",
    cost: m.cost,
    n: m.n,
    bits: m.bits,
    counter_start,
    counter_end,
    targets,
    mem_kib: 0,
    parallelism: 1,
    salt,
    bound: { action: m.action, path_prefix: m.path_prefix },
    iat: m.now,
    exp: m.now + m.ttl_s,
  };
  return { challenge: await signChallenge(m.secret, unsigned), secret_counters };
}

const isInt = (x: unknown, lo: number, hi: number): x is number => Number.isSafeInteger(x) && (x as number) >= lo && (x as number) <= hi;

/** Structural check. Throws TollError("malformed" | "unsupported"). */
export function assertChallengeShape(c: unknown): asserts c is Challenge {
  if (!c || typeof c !== "object") throw new TollError("malformed", "challenge must be an object");
  const o = c as Record<string, unknown>;
  const allowed = new Set(["v", "id", "site", "algo", "cost", "n", "bits", "counter_start", "counter_end", "targets", "mem_kib", "parallelism", "salt", "bound", "iat", "exp", "sig"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new TollError("malformed", "unknown field " + k);
  if (o.v !== 1) throw new TollError("unsupported", "unsupported version");
  if (o.algo !== "pbkdf2-sha256") throw new TollError("unsupported", "unsupported algo");
  if (typeof o.id !== "string" || !/^[0-9a-f]{32}$/.test(o.id)) throw new TollError("malformed", "bad id");
  if (typeof o.site !== "string" || o.site.length < 1 || o.site.length > 128) throw new TollError("malformed", "bad site");
  if (!isInt(o.cost, 1, 10_000_000)) throw new TollError("malformed", "bad cost");
  if (!isInt(o.n, 1, 16)) throw new TollError("malformed", "bad n");
  if (!isInt(o.bits, 8, 64) || (o.bits as number) % 8 !== 0) throw new TollError("malformed", "bad bits");
  if (!isInt(o.counter_start, 0, Number.MAX_SAFE_INTEGER) || !isInt(o.counter_end, 1, Number.MAX_SAFE_INTEGER)) throw new TollError("malformed", "bad counter range");
  const span = (o.counter_end as number) - (o.counter_start as number);
  if (span < 1 || span > MAX_SPAN) throw new TollError("malformed", "bad counter range");
  if (!Array.isArray(o.targets) || o.targets.length !== o.n) throw new TollError("malformed", "bad targets");
  for (const t of o.targets) if (typeof t !== "string" || !new RegExp(`^[0-9a-f]{${(o.bits as number) / 4}}$`).test(t)) throw new TollError("malformed", "bad target");
  if (o.mem_kib !== 0 || o.parallelism !== 1) throw new TollError("malformed", "bad mem_kib/parallelism");
  if (typeof o.salt !== "string") throw new TollError("malformed", "bad salt");
  let saltLen = 0;
  try { saltLen = fromB64(o.salt).length; } catch { throw new TollError("malformed", "bad salt"); }
  if (saltLen < 8 || saltLen > 64) throw new TollError("malformed", "bad salt");
  const b = o.bound as Record<string, unknown> | undefined;
  if (!b || typeof b !== "object" || Object.keys(b).length !== 2 || !isActionClass(b.action) || b.action === "read" || typeof b.path_prefix !== "string" || !b.path_prefix.startsWith("/")) throw new TollError("malformed", "bad bound");
  if (!isInt(o.iat, 0, Number.MAX_SAFE_INTEGER) || !isInt(o.exp, 0, Number.MAX_SAFE_INTEGER)) throw new TollError("malformed", "bad times");
  const ttl = (o.exp as number) - (o.iat as number);
  if (ttl <= 0 || ttl > MAX_CHALLENGE_TTL_S) throw new TollError("malformed", "ttl must be 1..120s");
  if (typeof o.sig !== "string") throw new TollError("bad_sig", "unsigned challenge");
}

/**
 * Signature, time and site checks. Cheap, so run before any work verification.
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
