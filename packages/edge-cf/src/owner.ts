// Owner routes on the site worker: GET /v1/owner/books (amounts and counts) and
// POST /v1/owner/withdraw, /v1/owner/withdraw/check (melt stored proofs over Lightning).
// Off unless the OWNER_KEY Worker secret is set (32+ characters). Off, every /v1/owner/ path is
// the same 404 as any unknown /v1 path. The key is compared as SHA-256 digests in constant time.
// Nothing here logs or returns a proof, a secret, the key, or an invoice.
import { sha256, timingSafeEqual, utf8 } from "../../protocol/src/index.ts";
import { assertProductionMint, mintKey, parseCashuMints } from "../../settlement-ln/src/cashu-net.ts";
import { checkWithdrawal, resolveLightningAddress, withdrawToInvoice, type MeltDeps, type WithdrawResult, type WithdrawStore } from "../../settlement-ln/src/cashu-melt.ts";
import { cashuFetch, type CashuEnv } from "./cashu-edge.ts";
import type { TollDoStub } from "./do-store.ts";

export interface OwnerEnv extends CashuEnv {
  /** Worker secret. Unset (the default): the owner routes do not exist. */
  OWNER_KEY?: string;
}

export const OWNER_KEY_MIN = 32;
/** Failed owner calls per client address per minute before 429. */
const AUTH_FAILS_PER_MIN = 10;
const MAX_BODY = 8192;

export function ownerEnabled(env: OwnerEnv): boolean {
  return typeof env.OWNER_KEY === "string" && env.OWNER_KEY.length >= OWNER_KEY_MIN;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function keyMatches(given: string, key: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(utf8(given)), sha256(utf8(key))]);
  return timingSafeEqual(a, b);
}

/** The store side of a withdrawal, one Durable Object call each. */
export function withdrawStoreOf(stub: TollDoStub): WithdrawStore {
  return {
    storedAt: (mint) => stub.withdrawStoredAt(mint),
    reserve: (o) => stub.withdrawReserve(o),
    get: (quote) => stub.withdrawGet(quote),
    finish: (o) => stub.withdrawFinish(o),
    release: (quote) => stub.withdrawRelease(quote),
  };
}

/** Configured mints plus every mint that holds stored proofs, so a removed mint can still be emptied. */
export function ownerMints(env: OwnerEnv, held: string[]): string[] {
  const hooks = env.TOLL_TEST_HOOKS === "1";
  const out = new Set(parseCashuMints(env.CASHU_MINTS, hooks));
  for (const m of held) {
    try { out.add(hooks ? mintKey(m) : assertProductionMint(m)); } catch { /* not fetched */ }
  }
  return [...out];
}

function statusOf(r: WithdrawResult): number {
  if (r.state === "paid") return 200;
  if (r.state === "pending") return 202;
  if (r.state === "released") return 502;
  return r.error === "not_found" ? 404 : r.error === "mint_unavailable" ? 503 : 400;
}

function logResult(kind: string, r: WithdrawResult): void {
  const line: Record<string, unknown> = { event: "owner_withdraw", kind, state: r.state };
  if (r.state === "refused") line.error = r.error;
  else line.amount_sat = r.amount_sat;
  if (r.state === "paid") line.fee_sat = r.fee_sat;
  console.log(JSON.stringify(line));
}

/** Null when this is not an owner path or the owner key is unset. The caller then answers as before. */
export async function ownerRoute(req: Request, env: OwnerEnv, stub: TollDoStub, clientIp: string | null): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith("/v1/owner/") || !ownerEnabled(env)) return null;
  const method = req.method.toUpperCase();
  const limitKey = "owner-auth:" + (clientIp ?? "?");
  if ((await stub.windowCount(limitKey, 60)) >= AUTH_FAILS_PER_MIN) return json({ error: "rate_limited" }, 429);
  const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!auth || !(await keyMatches(auth[1], env.OWNER_KEY!))) {
    await stub.windowHit(limitKey, 60);
    return json({ error: "unauthorized" }, 401);
  }
  if (path === "/v1/owner/books" && method === "GET") return json(await stub.ownerBooks());
  if ((path === "/v1/owner/withdraw" || path === "/v1/owner/withdraw/check") && method === "POST") {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json({ error: "malformed" }, 400);
    let b: Record<string, unknown>;
    try { b = JSON.parse(raw); } catch { return json({ error: "malformed" }, 400); }
    if (!b || typeof b !== "object") return json({ error: "malformed" }, 400);
    const books = await stub.ownerBooks();
    const allowlist = ownerMints(env, books.mints.map((m) => m.mint));
    const hooks = env.TOLL_TEST_HOOKS === "1";
    const deps: MeltDeps = {
      store: withdrawStoreOf(stub),
      allowlist,
      guard: { lookup: hooks ? async () => ["1.1.1.1"] : undefined, fetch: cashuFetch(env, allowlist) },
    };
    if (path === "/v1/owner/withdraw/check") {
      if (typeof b.quote !== "string") return json({ error: "malformed" }, 400);
      const r = await checkWithdrawal(deps, b.quote);
      logResult("check", r);
      return json({ ok: r.state === "paid", ...r }, statusOf(r));
    }
    // Default mint: the one holding the most stored sats.
    const mint = typeof b.mint === "string" ? b.mint : [...books.mints].sort((x, y) => y.stored_sat - x.stored_sat)[0]?.mint;
    if (!mint || !books.mints.some((m) => m.mint === mint)) return json({ error: "insufficient" }, 400);
    const maxFeeSat = b.max_fee_sat === undefined ? undefined : Number(b.max_fee_sat);
    if (maxFeeSat !== undefined && (!Number.isSafeInteger(maxFeeSat) || maxFeeSat < 0)) return json({ error: "malformed" }, 400);
    let invoice = typeof b.invoice === "string" ? b.invoice.trim().toLowerCase() : "";
    if (!invoice && typeof b.lightning_address === "string") {
      const amount = Number(b.amount_sat);
      try {
        invoice = await resolveLightningAddress(b.lightning_address, amount);
      } catch {
        return json({ error: "bad_address" }, 400);
      }
    }
    if (!invoice) return json({ error: "malformed" }, 400);
    const r = await withdrawToInvoice(deps, { mint, invoice, maxFeeSat });
    logResult("melt", r);
    return json({ ok: r.state === "paid", ...r }, statusOf(r));
  }
  return json({ error: "not_found" }, 404);
}
