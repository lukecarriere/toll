// Pass token, spec §8.3. Compact HMAC JWT (HS256) signed with the site secret.
// header = {"alg":"HS256","typ":"JWT"}; header and payload are canonical JSON, base64url, no padding.

import { canonicalJson } from "./canonical.ts";
import { fromB64url, fromUtf8, randomHex, toB64url, utf8 } from "./bytes.ts";
import { hmacSha256, hmacVerify } from "./hmac.ts";
import { type ActionClass, classCovers, isActionClass } from "./classes.ts";
import { TollError } from "./errors.ts";

export interface PassClaims {
  v: 1;
  site: string;
  sub: string;
  cls: ActionClass;
  n: number;
  iat: number;
  exp: number;
  jti: string;
}

const HEADER_B64 = toB64url(utf8(canonicalJson({ alg: "HS256", typ: "JWT" })));

export async function signPass(secret: string, claims: PassClaims): Promise<string> {
  const payload = toB64url(utf8(canonicalJson(claims)));
  const input = HEADER_B64 + "." + payload;
  const mac = await hmacSha256(secret, utf8(input));
  return input + "." + toB64url(mac);
}

export function newPassClaims(o: { site: string; cls: ActionClass; n: number; ttl_s: number; now: number }): PassClaims {
  return { v: 1, site: o.site, sub: "pass_" + randomHex(8), cls: o.cls, n: o.n, iat: o.now, exp: o.now + o.ttl_s, jti: randomHex(16) };
}

/** Verify signature, site, expiry and class. Does not track `n` (the issuer's pass store does). */
export async function verifyPassToken(secret: string, token: unknown, opts: { now: number; site?: string; action?: ActionClass }): Promise<PassClaims> {
  if (typeof token !== "string" || token.length > 2048) throw new TollError("malformed", "bad pass");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== HEADER_B64) throw new TollError("malformed", "bad pass");
  let mac: Uint8Array;
  try { mac = fromB64url(parts[2]); } catch { throw new TollError("malformed", "bad pass"); }
  if (!(await hmacVerify(secret, utf8(parts[0] + "." + parts[1]), mac))) throw new TollError("bad_sig");
  let claims: PassClaims;
  try { claims = JSON.parse(fromUtf8(fromB64url(parts[1]))); } catch { throw new TollError("malformed", "bad pass"); }
  if (!claims || claims.v !== 1 || !isActionClass(claims.cls) || typeof claims.jti !== "string" || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.n)) throw new TollError("malformed", "bad pass");
  if (opts.now >= claims.exp) throw new TollError("expired");
  if (opts.site !== undefined && claims.site !== opts.site) throw new TollError("wrong_site");
  if (opts.action !== undefined && !classCovers(claims.cls, opts.action)) throw new TollError("class_too_low");
  return claims;
}
