// Test-only Cashu engine. Offers are NUT-24 payment requests. A payment is a cashuB token, and it
// is accepted only after the configured test mint spends it (POST /v1/swap). There is no local
// hash check that can stand in for that call. A mint outage fails the health check, so the rail
// offers nothing and the work challenge still flows.
import {
  type ActionClass, TollError, canonicalJson, fromB64url, fromUtf8, hmacSha256, hmacVerify, randomHex, sha256, toB64url, toHex, utf8,
} from "../../protocol/src/index.ts";
import { CASHU_UNIT, decodeTokenV4, encodePaymentRequest, stripMint, type DecodedToken } from "./cashu.ts";
import type { CashuOffer, Paid, PaidClass, PaidProof, SettlementEngine } from "./engine.ts";

const SEAL_PREFIX = "toll-cashu-v1.";
const MINT_TIMEOUT_MS = 1500;

interface Caveats {
  v: 1;
  offer_id: string;
  site: string;
  cls: ActionClass;
  amount_msat: number;
  mint: string;
  amount: number;
  exp: number;
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
  if (c.v !== 1 || typeof c.offer_id !== "string" || typeof c.mint !== "string") throw new TollError("malformed");
  return c;
}

/** Spend the proofs at the test mint. `replay` means the mint already spent them. */
async function spendAtMint(mint: string, proofs: DecodedToken["proofs"]): Promise<"ok" | "replay"> {
  let r: Response;
  try {
    r = await fetch(stripMint(mint) + "/v1/swap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inputs: proofs.map((p) => ({ amount: p.amount, id: toHex(p.id), secret: p.secret, C: toHex(p.C) })),
        outputs: [],
      }),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
  } catch {
    throw new TollError("store_unavailable");
  }
  const text = await r.text();
  if (r.status === 200) return "ok";
  let code = 0;
  try { code = Number(JSON.parse(text).code); } catch { /* not JSON */ }
  if (r.status >= 500 || (code === 0 && r.status !== 400)) throw new TollError("store_unavailable");
  if (code === 11001) return "replay";
  throw new TollError("bad_solution");
}

export class CashuTestEngine implements SettlementEngine {
  readonly kind = "cashu" as const;
  private secret: string;
  readonly mint: string;

  constructor(o: { secret: string; mint: string }) {
    if (!o.secret || o.secret.length < 16) throw new Error("cashu engine: secret too short");
    this.secret = o.secret;
    this.mint = stripMint(o.mint);
  }

  async offer(o: { site: string; cls: PaidClass; amount_msat: number; now: number; ttl_s?: number }): Promise<CashuOffer> {
    if (!Number.isSafeInteger(o.amount_msat) || o.amount_msat <= 0 || o.amount_msat % 1000 !== 0) throw new Error("offer amount must be a positive whole number of 1,000 msat");
    const ttl = Math.min(o.ttl_s ?? 120, 120);
    const id = "off_" + randomHex(12);
    const amount = o.amount_msat / 1000;
    const exp = o.now + ttl;
    const request = encodePaymentRequest({ a: amount, u: CASHU_UNIT, m: [this.mint], s: true, i: id });
    const credential = await seal(this.secret, { v: 1, offer_id: id, site: o.site, cls: o.cls, amount_msat: o.amount_msat, mint: this.mint, amount, exp });
    return { id, kind: "cashu", amount_msat: o.amount_msat, amount, unit: CASHU_UNIT, mint: this.mint, request, credential, exp };
  }

  async verifyPaid(o: { site: string; proof: PaidProof; now: number; firstUse: (key: string, ttl_s: number) => Promise<boolean> }): Promise<Paid> {
    if (o.proof.kind !== "cashu") throw new TollError("unsupported");
    const c = await open(this.secret, o.proof.credential);
    if (c.offer_id !== o.proof.offer_id) throw new TollError("bad_sig");
    if (c.site !== o.site) throw new TollError("wrong_site");
    if (o.now > c.exp) throw new TollError("expired");
    if (c.mint !== this.mint || c.amount * 1000 !== c.amount_msat) throw new TollError("bad_sig");
    let token: DecodedToken;
    try { token = decodeTokenV4(o.proof.token); } catch { throw new TollError("malformed"); }
    if (token.proofs.length > 32) throw new TollError("malformed");
    // Shape is checked here. Acceptance is the mint call below, not a local hash of the secret.
    if (token.mint !== c.mint || token.unit !== CASHU_UNIT) throw new TollError("malformed");
    const sum = token.proofs.reduce((n, p) => n + p.amount, 0);
    if (!Number.isSafeInteger(sum) || sum < c.amount) throw new TollError("malformed");
    const spent = await spendAtMint(this.mint, token.proofs);
    if (spent === "replay") throw new TollError("replay");
    const ttl = Math.max(1, c.exp - o.now + 60);
    if (!(await o.firstUse("offer:" + c.offer_id, ttl))) throw new TollError("replay");
    const ref = toHex(await sha256(utf8(token.proofs.map((p) => p.secret).sort().join("\n"))));
    if (!(await o.firstUse("cashu:" + ref, ttl))) throw new TollError("replay");
    return { cls: c.cls, amount_msat: c.amount_msat, payment_ref: ref };
  }

  async healthy(): Promise<boolean> {
    try {
      const r = await fetch(this.mint + "/v1/info", { signal: AbortSignal.timeout(MINT_TIMEOUT_MS) });
      await r.arrayBuffer();
      return r.ok;
    } catch {
      return false;
    }
  }
}
