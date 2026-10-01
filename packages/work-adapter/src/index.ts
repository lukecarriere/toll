// Work engine adapter (Amendment 1 §B, §C). Toll owns the /v1 envelope, replay cache, policy and
// pass. The proof-of-work puzzle itself is ALTCHA v2 (altcha-lib, MIT, pinned in package.json):
// this module only issues and verifies vendor challenges. It never calls the network
// (no Sentinel, no cloud verification): verification is local HMAC and KDF work.
//
// Mapping (docs/adapters.md):
//   Toll challenge.id  -> vendor parameters.data.tid   (bound; also covered by the Toll sig)
//   Toll challenge.exp -> enforced by Toll (signed envelope); the vendor payload has no own expiry
//   Toll policy        -> vendor algorithm, cost, memoryCost, and a secret counter in [0, counter_max)
//   vendor solution    -> verified here, then the caller mints the Toll pass

import { createHmac } from "node:crypto";
import { createChallenge, solveChallenge, verifySolution, type Challenge, type Solution } from "altcha-lib";
import { deriveKey as pbkdf2Node } from "altcha-lib/algorithms/pbkdf2";
import { argon2id } from "hash-wasm";

export type WorkAlg = "pbkdf2-sha256" | "argon2id";

/** Vendor algorithm names, kept out of the Toll wire format. */
const VENDOR_ALG: Record<WorkAlg, string> = { "pbkdf2-sha256": "PBKDF2/SHA-256", argon2id: "ARGON2ID" };
const TOLL_ALG: Record<string, WorkAlg> = { "PBKDF2/SHA-256": "pbkdf2-sha256", ARGON2ID: "argon2id" };

export interface WorkSpec {
  alg: WorkAlg;
  /** PBKDF2 iterations per try, or Argon2id passes (t). */
  cost: number;
  /** Argon2id memory in KiB (m). Ignored for PBKDF2. */
  memory_kib?: number;
  /** Argon2id lanes (p). Ignored for PBKDF2. */
  parallelism?: number;
  /** Exclusive upper bound of the secret counter: worst case is counter_max tries, mean about half. */
  counter_max: number;
}

/** Opaque to the origin and to Toll's envelope code: it is the vendor challenge object, unchanged. */
export type WorkPayload = Challenge;
export type WorkSolution = Solution;

export interface VerifyOutcome {
  ok: boolean;
  code?: "malformed" | "bad_sig" | "expired" | "bad_solution";
  verify_ms: number;
}

type DeriveKey = (parameters: any, salt: Uint8Array, password: Uint8Array) => Promise<{ parameters?: Record<string, unknown>; derivedKey: Uint8Array }>;

/**
 * Argon2id key derivation for the issuer. Node 24.7+ has argon2 in node:crypto; Node 22 does not,
 * so this uses hash-wasm (MIT), the same implementation the vendor's browser worker bundles,
 * with the same parameter mapping (iterations = cost, memorySize = memoryCost KiB).
 */
const argon2idDerive: DeriveKey = async (p, salt, password) => {
  const memoryCost = p.memoryCost ?? 16384;
  const parallelism = p.parallelism ?? 1;
  const derivedKey = await argon2id({ password, salt, parallelism, iterations: p.cost, memorySize: memoryCost, hashLength: p.keyLength ?? 32, outputType: "binary" });
  return { parameters: { memoryCost, parallelism }, derivedKey };
};

const DERIVE: Record<WorkAlg, DeriveKey> = { "pbkdf2-sha256": pbkdf2Node as DeriveKey, argon2id: argon2idDerive };

const MAX_COUNTER = 0xffffffff;

function subSecret(secret: string, label: string): string {
  return createHmac("sha256", secret).update("toll/work-adapter/v1/" + label).digest("hex");
}

function randomBelow(n: number): number {
  // Uniform in [0, n) using rejection sampling on 32-bit values.
  const lim = Math.floor(0x100000000 / n) * n;
  const b = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(b);
    if (b[0] < lim) return b[0] % n;
  }
}

export function vendorAlgToToll(a: unknown): WorkAlg | null {
  return typeof a === "string" ? TOLL_ALG[a] ?? null : null;
}

export function createWorkAdapter(secret: string) {
  if (typeof secret !== "string" || secret.length < 16) throw new Error("work adapter: secret too short");
  const hmacSignatureSecret = subSecret(secret, "challenge");
  const hmacKeySignatureSecret = subSecret(secret, "key");

  /** Issue a vendor challenge bound to a Toll challenge id. Costs one KDF call (the secret counter). */
  async function issue(o: { tid: string; exp?: number; spec: WorkSpec; counter?: number }): Promise<WorkPayload> {
    const { spec } = o;
    if (!(spec.alg in VENDOR_ALG)) throw new Error("work adapter: unsupported alg " + spec.alg);
    if (!Number.isInteger(spec.counter_max) || spec.counter_max < 1 || spec.counter_max > MAX_COUNTER) throw new Error("work adapter: bad counter_max");
    const counter = o.counter ?? randomBelow(spec.counter_max);
    return createChallenge({
      algorithm: VENDOR_ALG[spec.alg],
      cost: spec.cost,
      memoryCost: spec.alg === "argon2id" ? spec.memory_kib ?? 32768 : undefined,
      parallelism: spec.alg === "argon2id" ? spec.parallelism ?? 1 : undefined,
      counter,
      deriveKey: DERIVE[spec.alg],
      // No vendor expiresAt: the Toll envelope carries exp under the Toll signature and the Toll
      // replay cache makes the id single-use, so the vendor payload never outlives its envelope.
      data: { tid: o.tid },
      hmacSignatureSecret,
      hmacKeySignatureSecret,
    });
  }

  /**
   * Verify a vendor solution for the challenge bound to `tid`. With the key signature the vendor
   * issues, this is one HMAC (no KDF call), so a flood of bad solutions costs the issuer little.
   */
  async function verify(payload: unknown, solution: unknown, o: { tid: string; alg?: WorkAlg }): Promise<VerifyOutcome> {
    const t0 = performance.now();
    const done = (ok: boolean, code?: VerifyOutcome["code"]): VerifyOutcome => ({ ok, code, verify_ms: Math.round((performance.now() - t0) * 10) / 10 });
    const p = payload as WorkPayload;
    const s = solution as WorkSolution;
    if (!p || typeof p !== "object" || !p.parameters || typeof p.parameters !== "object") return done(false, "malformed");
    const alg = vendorAlgToToll(p.parameters.algorithm);
    if (!alg || (o.alg !== undefined && o.alg !== alg)) return done(false, "malformed");
    if (p.parameters.data?.tid !== o.tid) return done(false, "bad_sig");
    if (!s || typeof s !== "object" || !Number.isSafeInteger(s.counter) || s.counter < 0 || s.counter > MAX_COUNTER || typeof s.derivedKey !== "string" || !/^[0-9a-f]{2,128}$/.test(s.derivedKey) || s.derivedKey.length % 2 !== 0) return done(false, "bad_solution");
    let r;
    try {
      r = await verifySolution({ challenge: p, solution: { counter: s.counter, derivedKey: s.derivedKey, time: 0 } as any, deriveKey: DERIVE[alg], hmacSignatureSecret, hmacKeySignatureSecret });
    } catch {
      return done(false, "malformed");
    }
    if (r.verified) return done(true);
    if (r.expired) return done(false, "expired");
    if (r.invalidSignature) return done(false, "bad_sig");
    return done(false, "bad_solution");
  }

  return { issue, verify };
}

export type WorkAdapter = ReturnType<typeof createWorkAdapter>;

/**
 * Solve an engine payload in Node with the engine's own solver (single thread). For the agent SDK,
 * tests and vector generation; browsers use the widget's workers instead.
 */
export async function solveWork(payload: unknown, o: { timeoutMs?: number; counterStart?: number } = {}): Promise<{ counter: number; derivedKey: string; time: number } | null> {
  const p = payload as WorkPayload;
  const alg = vendorAlgToToll(p?.parameters?.algorithm);
  if (!alg) throw new Error("work adapter: unsupported payload");
  const s = await solveChallenge({ challenge: p, deriveKey: DERIVE[alg] as any, timeout: o.timeoutMs ?? 90_000, counterStart: o.counterStart ?? 0 });
  return s ? { counter: s.counter, derivedKey: s.derivedKey, time: s.time ?? 0 } : null;
}
