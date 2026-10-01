// HTTP layer: the /v1 API (spec §8.5), the protect middleware, and a fetch-aware helper.
// Uses only node:http primitives, so it works as Express middleware and as a plain (req, res, next).

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ActionClass, TollError, isActionClass, timingSafeEqual, utf8, verifyPassToken, classCovers } from "../../protocol/src/index.ts";
import { paymentRequired, StubSettler } from "../../settlement-ln/src/index.ts";
import type { Toll } from "./toll.ts";

export const VERSION = "1.0.0";
export const PASS_COOKIE = "toll_pass";
const MAX_BODY = 1 << 20;

type Req = IncomingMessage & { body?: any; ip?: string };
type Next = (err?: unknown) => void;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(json);
}

export function clientIp(req: Req): string {
  return req.ip ?? req.socket?.remoteAddress ?? "?";
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Read and parse a urlencoded or JSON body once, if nothing upstream already did. */
export async function readBody(req: Req): Promise<any> {
  if (req.body !== undefined) return req.body;
  const ct = String(req.headers["content-type"] ?? "").toLowerCase();
  const isForm = ct.startsWith("application/x-www-form-urlencoded");
  const isJson = ct.startsWith("application/json");
  if (!isForm && !isJson) return (req.body = {});
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new TollError("malformed", "body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    req.body = isJson ? (text ? JSON.parse(text) : {}) : Object.fromEntries(new URLSearchParams(text));
  } catch {
    throw new TollError("malformed", "bad body");
  }
  return req.body;
}

/** Pass from `Authorization: Toll <pass>` (or Bearer), the `toll-pass` form field, or the cookie. */
export function extractPass(req: Req, body?: any): string | undefined {
  const auth = String(req.headers["authorization"] ?? "");
  const m = /^(?:Toll|Bearer)\s+(\S+)$/i.exec(auth);
  if (m) return m[1];
  if (body && typeof body["toll-pass"] === "string" && body["toll-pass"]) return body["toll-pass"];
  return parseCookies(req.headers.cookie as string | undefined)[PASS_COOKIE] || undefined;
}

/** An automated client (settlement.md Q2): `client=agent` in the query or a `Toll-Client: agent` header. */
function isAgentRequest(query: URLSearchParams | null, header: string | null | undefined): boolean {
  return query?.get("client") === "agent" || String(header ?? "").trim().toLowerCase() === "agent";
}

function isSecure(toll: Toll, req: Req): boolean {
  const s = toll.config.cookie.secure;
  if (s !== "auto") return s;
  return (req.socket as any)?.encrypted === true || String(req.headers["x-forwarded-proto"] ?? "") === "https";
}

function applyCors(toll: Toll, req: Req, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && toll.config.allowed_origins.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("vary", "Origin");
  }
}

function statusFor(e: unknown): number {
  if (!(e instanceof TollError)) return 500;
  switch (e.code) {
    case "malformed":
    case "unsupported":
    case "wrong_action":
      return 400;
    case "rate_limited":
      return 429;
    case "store_unavailable":
      return 503;
    default:
      return 401;
  }
}

const WIDGET_DIST = fileURLToPath(new URL("../../widget/dist/", import.meta.url));
const assetCache = new Map<string, { mtime: number; body: Buffer }>();
function asset(name: string): Buffer | undefined {
  const p = WIDGET_DIST + name;
  if (!existsSync(p)) return undefined;
  const mtime = statSync(p).mtimeMs;
  const hit = assetCache.get(name);
  if (hit && hit.mtime === mtime) return hit.body;
  const body = readFileSync(p);
  assetCache.set(name, { mtime, body });
  return body;
}

/** The issuer API under /v1 plus the widget files under /toll/v1/. */
export function tollRouter(toll: Toll) {
  return async function router(req: Req, res: ServerResponse, next: Next) {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    try {
      if (path === "/toll/v1/toll.js" || path === "/toll/v1/toll.worker.js" || path === "/toll/v1/toll.worker-argon2id.js" || path === "/toll/v1/LICENSES.txt") {
        const body = asset(path.slice("/toll/v1/".length));
        if (!body) return send(res, 404, { error: "not_built" });
        res.statusCode = 200;
        res.setHeader("content-type", path.endsWith(".txt") ? "text/plain; charset=utf-8" : "text/javascript; charset=utf-8");
        res.setHeader("cache-control", "no-cache");
        // A dedicated worker runs under the policy of its own response. The hardened engine compiles
        // WebAssembly, so its worker (and only its worker) gets 'wasm-unsafe-eval' and nothing else:
        // no network, no imports. This overrides any page-wide policy the host app set for this path.
        if (path.endsWith("toll.worker-argon2id.js")) res.setHeader("content-security-policy", "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'");
        else if (path.endsWith("toll.worker.js")) res.setHeader("content-security-policy", "default-src 'none'; script-src 'self'");
        return res.end(body);
      }
      if (!path.startsWith("/v1/")) return next();
      applyCors(toll, req, res);
      if (req.method === "OPTIONS") {
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type, authorization, toll-client");
        res.setHeader("access-control-max-age", "600");
        res.statusCode = 204;
        return res.end();
      }

      if (path === "/v1/health" && req.method === "GET") {
        // "stub" is this build's extension of the spec's off | regtest | live: the local test backend.
        const st = toll.paid ? await toll.paid.status() : null;
        const body: Record<string, unknown> = st ? { ok: true, v: VERSION, settlement: st.mode, settlement_degraded: !st.healthy, usd_rate: st.usd } : { ok: true, v: VERSION, settlement: "off" };
        if (String(req.headers.accept ?? "").includes("text/html")) {
          res.statusCode = 200;
          res.setHeader("content-type", "text/html; charset=utf-8");
          const snap = toll.metrics.snapshot();
          const rows = Object.entries({ ...body, ...snap, by_tag: JSON.stringify(snap.by_tag) }).map(([k, v]) => `<tr><th>${k}</th><td>${String(v)}</td></tr>`).join("");
          return res.end(`<!doctype html><meta charset="utf-8"><title>Toll status</title><h1>Toll status</h1><table>${rows}</table>`);
        }
        return send(res, 200, body);
      }

      if (path === "/v1/challenge" && req.method === "GET") {
        const action = url.searchParams.get("action") ?? "write";
        if (!isActionClass(action) || action === "read") return send(res, 400, { error: "bad_action" });
        const client = isAgentRequest(url.searchParams, req.headers["toll-client"] as string | undefined) ? "agent" : "widget";
        if (!toll.allowChallenge(clientIp(req))) return send(res, 429, { error: "rate_limited" }, { "retry-after": "60" });
        // Offers only for agent clients with paid requests on and healthy; otherwise [] (spec §8.5, §19.11).
        // `offers=0`: the agent's work fallback (a 402's challenge_url) wants the challenge only.
        const workOnly = url.searchParams.get("offers") === "0";
        const input = {
          site: url.searchParams.get("site") ?? undefined,
          action,
          path: url.searchParams.get("path") ?? undefined,
          client: client as "agent" | "widget",
          userAgent: req.headers["user-agent"],
          ip: clientIp(req),
          source: "challenge_endpoint" as const,
        };
        const { challenge, offers } = workOnly ? { challenge: await toll.issueChallenge(input), offers: [] } : await toll.issueWithOffers(input);
        // The agent chose work after a 402 (it fetched challenge_url). challenge_minted still fires as usual.
        if (workOnly) toll.metrics.workAfter402({ action, site: challenge.site, cls: challenge.bound.action });
        return send(res, 200, { challenge, offers });
      }

      if (path === "/v1/redeem" && req.method === "POST") {
        const body = await readBody(req);
        if (body && body.offer_id !== undefined) {
          if (!toll.paid) return send(res, 400, { error: "unsupported", detail: "paid redeem is not enabled on this issuer" });
          // Paid pass: short (Q6), for the client's Authorization header. No cookie: agents carry it themselves.
          const r = await toll.redeemPaid(body, { ip: clientIp(req) });
          return send(res, 200, { pass: r.pass, exp: r.exp, cls: r.cls, rail: r.rail });
        }
        if (!body || typeof body.challenge_id !== "string" || typeof body.solution !== "object" || body.solution === null) return send(res, 400, { error: "malformed" });
        const challenge = body.challenge ?? toll.findIssued(body.challenge_id);
        if (!challenge) return send(res, 401, { error: "unknown_challenge" });
        if (challenge.id !== body.challenge_id) return send(res, 400, { error: "malformed", detail: "challenge_id mismatch" });
        const r = await toll.verifySolution(challenge, body.solution, { ip: clientIp(req), client: body.client === "agent" ? "agent" : "widget" });
        await setPassCookie(toll, req, res, r.pass, r.cls, r.exp);
        return send(res, 200, { pass: r.pass, exp: r.exp, cls: r.cls, rail: r.rail });
      }

      if (path === "/v1/status" && req.method === "GET") {
        const token = extractPass(req);
        if (!token) return send(res, 200, { ok: false });
        try {
          // search is the lowest gated class, so any valid pass covers it.
          const c = await toll.verifyPass(token, { action: "search", consume: false });
          return send(res, 200, { ok: true, exp: c.exp, cls: c.cls, n: c.remaining });
        } catch {
          return send(res, 200, { ok: false });
        }
      }

      // Owner API (option A, docs/settlement.md §9): a WordPress site set to "Payment server" reads its
      // balance and sends withdrawals here, server to server, with the owner key. Off unless
      // settlement.owner_key is set. Amounts are integer msat plus the owner's USD string.
      if (path === "/v1/owner/balance" || path === "/v1/owner/withdraw") {
        const key = toll.config.settlement.owner_key;
        if (!key || !toll.paid) return send(res, 404, { error: "not_found" });
        const auth = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""));
        if (!auth || !timingSafeEqual(utf8(auth[1]), utf8(key))) return send(res, 401, { error: "unauthorized" });
        const paid = toll.paid;
        if (path === "/v1/owner/balance" && req.method === "GET") {
          const st = await paid.status();
          const b = paid.balance();
          return send(res, 200, { available_msat: b.msat.available_msat, available_usd: b.usd?.available ?? null, fee_bps: paid.fee_bps, paid_requests: b.paid_requests, degraded: !st.healthy, collecting: st.collecting });
        }
        if (path === "/v1/owner/withdraw" && req.method === "POST") {
          const body = await readBody(req);
          const invoice = typeof body?.invoice === "string" ? body.invoice.trim() : "";
          const amount = StubSettler.amountOf(invoice);
          if (amount === null) return send(res, 400, { error: "bad_invoice" });
          // Checked against the balance before anything is sent.
          if (amount > paid.balance().msat.available_msat) return send(res, 400, { error: "too_much" });
          const settler = toll.stubSettler;
          if (!settler) return send(res, 503, { error: "unavailable" });
          let paidOut: { amount_msat: number; payment_hash: string };
          try {
            paidOut = settler.payOut(invoice);
          } catch (e) {
            return e instanceof TypeError ? send(res, 400, { error: "bad_invoice" }) : send(res, 503, { error: "unavailable" });
          }
          paid.ledger.withdraw({ site: toll.config.site_id, ref: paidOut.payment_hash, amount_msat: paidOut.amount_msat, at: toll.now() });
          toll.metrics.emit("owner_withdrawal", { amount_msat: paidOut.amount_msat });
          return send(res, 200, { ok: true, amount_msat: paidOut.amount_msat, amount_usd: paid.usd(paidOut.amount_msat) });
        }
        return send(res, 405, { error: "method_not_allowed" });
      }

      if (path === "/v1/siteverify" && req.method === "POST") {
        const body = await readBody(req);
        const secret = typeof body?.secret === "string" ? body.secret : "";
        if (!timingSafeEqual(utf8(secret), utf8(toll.config.secret))) return send(res, 200, { success: false, "error-codes": ["invalid-input-secret"] });
        const response = body?.response;
        try {
          let token: string;
          if (typeof response === "string" && response.trim().startsWith("{")) {
            const p = JSON.parse(response);
            const ch = p.challenge ?? toll.findIssued(p.challenge_id);
            if (!ch || ch.id !== p.challenge_id) throw new TollError("malformed");
            token = (await toll.verifySolution(ch, p.solution ?? {}, { ip: clientIp(req) })).pass;
          } else {
            token = String(response ?? "");
          }
          const action = isActionClass(body?.action) ? body.action : undefined;
          const c = await toll.verifyPass(token, { action: action ?? "search" });
          return send(res, 200, { success: true, action: c.cls, hostname: toll.config.hostname, challenge_ts: new Date(c.iat * 1000).toISOString() });
        } catch (e) {
          const code = e instanceof TollError ? e.code : "invalid-input-response";
          return send(res, 200, { success: false, "error-codes": [code === "expired" ? "timeout-or-duplicate" : "invalid-input-response"] });
        }
      }

      return send(res, 404, { error: "not_found" });
    } catch (e) {
      const status = statusFor(e);
      if (status === 500) console.error("[toll] internal error:", (e as Error)?.message);
      return send(res, status, { error: e instanceof TollError ? e.code : "internal" });
    }
  };
}

async function setPassCookie(toll: Toll, req: Req, res: ServerResponse, pass: string, cls: ActionClass, exp: number) {
  // First-party only: when the widget calls the issuer from another origin, a cookie here would be
  // a third-party cookie, so skip it; the widget then carries the pass itself (spec §10).
  const origin = req.headers.origin;
  if (origin && (() => { try { return new URL(origin).host !== req.headers.host; } catch { return true; } })()) return;
  // Keep an existing valid pass for a higher class instead of overwriting it with a lower one.
  const existing = parseCookies(req.headers.cookie as string | undefined)[PASS_COOKIE];
  if (existing) {
    try {
      const c = await verifyPassToken(toll.config.secret, existing, { now: toll.now(), site: toll.config.site_id });
      if (!classCovers(cls, c.cls)) return;
    } catch {
      /* invalid or expired: replace it */
    }
  }
  const maxAge = Math.max(0, exp - toll.now());
  const attrs = [`${PASS_COOKIE}=${encodeURIComponent(pass)}`, "Path=/", `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Lax"];
  if (isSecure(toll, req)) attrs.push("Secure");
  res.setHeader("set-cookie", attrs.join("; "));
}

function wantsHtml(req: Req): boolean {
  const accept = String(req.headers.accept ?? "");
  return accept.includes("text/html") && !accept.includes("application/json");
}

export interface ProtectOptions {
  /** Action class for this route. Defaults to the route table (unmapped POST = write). */
  action?: ActionClass;
  /** Text for the no-JavaScript 403 page. */
  noJsMessage?: string;
}

/**
 * Protect a route: requests without a valid pass for the action class are rejected (fail closed).
 * JSON clients get 403 {error:"toll_required", challenge}; browsers without JS get a short HTML page.
 */
export function protect(toll: Toll, o: ProtectOptions = {}) {
  return async function tollMiddleware(req: Req, res: ServerResponse, next: Next) {
    const method = (req.method ?? "GET").toUpperCase();
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const action = o.action ?? toll.classify((req as any).originalUrl ? new URL((req as any).originalUrl, "http://x").pathname : path, method).cls;
    if (action === "read") return next();
    let body: any;
    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, { error: "malformed" });
    }
    const token = extractPass(req, body);
    if (!token) return reject(toll, req, res, action, o.noJsMessage, true); // first contact: absent, not rejected
    try {
      const claims = await toll.verifyPass(token, { action });
      (req as any).toll = claims;
      if (body && typeof body === "object") delete body["toll-pass"];
      return next();
    } catch (e) {
      if (e instanceof TollError && e.code === "store_unavailable") return send(res, 503, { error: "unavailable" });
      return reject(toll, req, res, action, o.noJsMessage, false);
    }
  };
}

/**
 * Gate response for a request without a usable pass. `absent`: no pass was presented at all, which
 * is logged as `pass_absent` (first contact), not as a rejection; invalid passes were already logged
 * as `pass_reject` with their reason by verifyPass.
 */
async function reject(toll: Toll, req: Req, res: ServerResponse, action: ActionClass, noJsMessage: string | undefined, absent: boolean) {
  const agent = isAgentRequest(new URL(req.url ?? "/", "http://x").searchParams, req.headers["toll-client"] as string | undefined);
  if (!agent && wantsHtml(req)) {
    gateLog(toll, action, absent, 403);
    res.statusCode = 403;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(`<!doctype html><meta charset="utf-8"><title>403</title><p>${noJsMessage ?? "This form needs JavaScript."}</p>`);
  }
  const r = await gateResponse(toll, { action, path: new URL(req.url ?? "/", "http://x").pathname, agent, userAgent: req.headers["user-agent"] as string | undefined, ip: clientIp(req) });
  gateLog(toll, action, absent, r.status);
  return send(res, r.status, r.body, r.headers);
}

function gateLog(toll: Toll, action: ActionClass, absent: boolean, status: number) {
  if (absent) toll.metrics.passAbsent({ action, status });
  if (status === 403) toll.metrics.turnedAway();
}

/**
 * 402 for an agent when there is an offer to pay (settlement.md §4, Q2), with a `challenge_url` for
 * the work fallback instead of an inline challenge: nothing is minted for the work engine unless the
 * agent asks. Otherwise the work-only 403 with an inline challenge. Offers never appear in a 403.
 * Both paths count against the per-IP challenge rate limit; over it, the 403 has no challenge.
 */
async function gateResponse(toll: Toll, o: { action: ActionClass; path: string; agent: boolean; userAgent?: string | null; ip?: string }): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  if (!toll.allowChallenge(o.ip)) return { status: 403, body: { error: "toll_required" }, headers: {} };
  const input = { action: o.action, path: o.path, client: o.agent ? ("agent" as const) : ("widget" as const), userAgent: o.userAgent, ip: o.ip, source: "middleware" as const };
  if (o.agent) {
    const offers = await toll.offersFor(input).catch(() => []);
    if (offers.length > 0) {
      toll.metrics.offerShown({ cls: o.action, amount_msat: offers[0].amount_msat, offers: offers.length });
      return paymentRequired(toll.config.site_id, o.action, o.path, offers);
    }
  }
  const challenge = await toll.issueChallenge(input).catch(() => undefined);
  return { status: 403, body: challenge ? { error: "toll_required", challenge } : { error: "toll_required" }, headers: {} };
}

/**
 * Fetch-aware helper for Request/Response runtimes: wrap a handler so it only runs with a valid pass.
 *   export default { fetch: guardFetch(toll, handler, { action: "write" }) }
 */
export function guardFetch(toll: Toll, handler: (req: Request, claims: unknown) => Response | Promise<Response>, o: { action?: ActionClass } = {}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const action = o.action ?? toll.classify(url.pathname, request.method).cls;
    if (action === "read") return handler(request, null);
    const auth = request.headers.get("authorization") ?? "";
    const m = /^(?:Toll|Bearer)\s+(\S+)$/i.exec(auth);
    const token = m?.[1] ?? parseCookies(request.headers.get("cookie") ?? undefined)[PASS_COOKIE];
    const refuse = async (absent: boolean) => {
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
      const agent = isAgentRequest(url.searchParams, request.headers.get("toll-client"));
      const r = await gateResponse(toll, { action, path: url.pathname, agent, userAgent: request.headers.get("user-agent"), ip });
      gateLog(toll, action, absent, r.status);
      return Response.json(r.body, { status: r.status, headers: r.headers });
    };
    if (!token) return refuse(true);
    try {
      const claims = await toll.verifyPass(token, { action });
      return handler(request, claims);
    } catch (e) {
      if (e instanceof TollError && e.code === "store_unavailable") return Response.json({ error: "unavailable" }, { status: 503 });
      return refuse(false);
    }
  };
}
