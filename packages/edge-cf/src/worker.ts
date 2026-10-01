// Toll edge worker (spec §11). One Worker is both issuer (/v1/*) and gate in front of an origin:
//   GET / HEAD and free paths   -> proxied to ORIGIN untouched
//   POST/PUT/PATCH/DELETE to a gated path:
//     valid toll_pass cookie or Authorization: Toll <pass> -> one use spent, request proxied
//     else Accept: application/json -> 403 {"error":"toll_required","challenge":{...}}
//     else -> 403 HTML interstitial that runs the check and re-sends a urlencoded form (last resort)
//   /v1/challenge, /v1/redeem, /v1/siteverify, /v1/status, /v1/health -> the Toll facade
//   /toll/v1/toll.js and its worker -> the widget, served same-origin
// Runs locally only (wrangler dev / miniflare); no deploy, no account. Never logs bodies, cookies or
// Authorization values. Work-only at the edge: standard mode, no paid offers (see README).
import { TollError, isActionClass, timingSafeEqual, utf8, type ActionClass } from "../../protocol/src/index.ts";
import { createToll } from "../../server-node/src/toll.ts";
import { normalizeConfig } from "../../server-node/src/config.ts";
import { Metrics } from "../../server-node/src/metrics.ts";
import { MemoryStore } from "../../server-node/src/stores.ts";
import { buildManifest, agentsPointer, priceBody, PAID_CLASSES } from "../../server-node/src/manifest.ts";
import { KVStore, type KVLike } from "./kv-store.ts";
// Widget files, bundled as text by build.mjs.
import TOLL_JS from "../../widget/dist/toll.js";
import TOLL_WORKER_JS from "../../widget/dist/toll.worker.js";

export interface Env {
  SITE_ID: string;
  SITE_SECRET: string;
  ORIGIN: string;
  WRITE_PATHS?: string;
  SEARCH_PATHS?: string;
  ACCOUNT_PATHS?: string;
  FREE_PATHS?: string;
  ALLOWED_ORIGINS?: string;
  TOLL_KV?: KVLike;
}

const PASS_COOKIE = "toll_pass";
const list = (s: string | undefined, d: string[]): string[] => {
  if (!s) return d;
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : d; } catch { return d; }
};

let cached: { key: string; toll: ReturnType<typeof createToll>; free: string[] } | null = null;

async function getToll(env: Env) {
  const routesFromKv = env.TOLL_KV ? await env.TOLL_KV.get("toll_routes").catch(() => null) : null;
  const key = [env.SITE_ID, env.SITE_SECRET?.length, env.WRITE_PATHS, env.SEARCH_PATHS, env.ACCOUNT_PATHS, env.FREE_PATHS, routesFromKv].join("|");
  if (cached && cached.key === key) return cached;
  let routes: { prefix: string; class: ActionClass }[];
  try { routes = routesFromKv ? JSON.parse(routesFromKv) : []; } catch { routes = []; }
  if (!routes.length) {
    routes = [
      { prefix: "/", class: "read" as const }, // explicit: page views stay free (Amendment 2 §C)
      ...list(env.WRITE_PATHS, ["/contact", "/wp-comments-post.php", "/api/"]).map((prefix) => ({ prefix, class: "write" as const })),
      ...list(env.SEARCH_PATHS, ["/search"]).map((prefix) => ({ prefix, class: "search" as const })),
      ...list(env.ACCOUNT_PATHS, ["/wp-login.php"]).map((prefix) => ({ prefix, class: "account" as const })),
    ];
  }
  const config = normalizeConfig({
    site_id: env.SITE_ID,
    secret: env.SITE_SECRET,
    issuer_public_url: "http://edge.local",
    hostname: new URL(env.ORIGIN).hostname,
    allowed_origins: list(env.ALLOWED_ORIGINS, []),
    routes,
    // Standard engine only: Argon2id needs runtime WASM compilation, which Workers do not allow
    // (README "Limits"). Escalation is therefore off at the edge.
    work: { mode: "standard", escalate: { at_velocity: Number.MAX_SAFE_INTEGER, classes: [] } },
  }, {});
  const toll = createToll(config, {
    store: env.TOLL_KV ? new KVStore(env.TOLL_KV) : new MemoryStore(() => Math.floor(Date.now() / 1000)),
    metrics: new Metrics((l) => console.log(l)),
  });
  cached = { key, toll, free: list(env.FREE_PATHS, ["/", "/blog"]) };
  return cached;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function passFrom(req: Request): string | undefined {
  const a = req.headers.get("authorization");
  if (a && /^Toll\s+/i.test(a)) return a.replace(/^Toll\s+/i, "").trim();
  return cookies(req)[PASS_COOKIE];
}

const ip = (req: Request) => req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "?";

async function body(req: Request): Promise<Record<string, any>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await req.json().catch(() => ({}))) as Record<string, any>;
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const f = await req.formData().catch(() => null);
    const o: Record<string, any> = {};
    f?.forEach((v, k) => { if (typeof v === "string") o[k] = v; });
    return o;
  }
  return {};
}

function proxy(req: Request, env: Env, url: URL): Promise<Response> {
  const target = new URL(url.pathname + url.search, env.ORIGIN);
  return fetch(new Request(target, req));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Last-resort interstitial: the widget binds the form, runs the check, and re-sends the fields. */
async function interstitial(req: Request, url: URL, action: ActionClass): Promise<Response> {
  let fields = "";
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded") && Number(req.headers.get("content-length") ?? 0) <= 16384) {
    const f = await req.formData().catch(() => null);
    f?.forEach((v, k) => { if (typeof v === "string" && k !== "toll-pass") fields += `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`; });
  }
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>403</title>
<form method="post" action="${esc(url.pathname + url.search)}" data-toll="${action}">${fields}<button type="submit">Send</button></form>
<noscript>This form needs JavaScript.</noscript><script src="/toll/v1/toll.js" defer></script>`;
  return new Response(html, { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function cookieFor(pass: string, exp: number, now: number, secure: boolean) {
  return `${PASS_COOKIE}=${encodeURIComponent(pass)}; Path=/; Max-Age=${Math.max(0, exp - now)}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

const discoveryMetrics = new Metrics((l) => console.log(l));

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();
    // Agent discovery (Amendment 3): free, served before any config or store is touched. The edge
    // is work-only, so prices are null with status "stub".
    if ((path === "/.well-known/toll.json" || path === "/.well-known/agents.json") && (method === "GET" || method === "HEAD")) {
      const doc = path === "/.well-known/toll.json" ? buildManifest({ api: url.origin + "/v1", docs: null, status: "stub", prices: null }) : agentsPointer(url.origin + "/.well-known/toll.json");
      discoveryMetrics.discovery(path === "/.well-known/toll.json" ? "manifest" : "agents_json");
      return json(doc, 200, { "access-control-allow-origin": "*", "cache-control": "public, max-age=60" });
    }
    // Page loads are never gated at the edge (Amendment 2 §A): proxied before any config or store
    // is touched, so a bad route list or a store outage can't block reading.
    if ((method === "GET" || method === "HEAD" || method === "OPTIONS") && !path.startsWith("/v1/") && !path.startsWith("/toll/v1/")) return proxy(req, env, url);
    const { toll, free } = await getToll(env);
    try {
      if (path === "/toll/v1/toll.js") return new Response(TOLL_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" } });
      if (path === "/toll/v1/toll.worker.js") return new Response(TOLL_WORKER_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" } });
      if (path.startsWith("/v1/")) return await facade(req, env, url, toll);

      if (free.some((p) => path === p)) return proxy(req, env, url);
      const action = toll.classify(path, method).cls as ActionClass | "read";
      if (action === "read") return proxy(req, env, url);

      const token = passFrom(req);
      if (token) {
        try {
          await toll.verifyPass(token, { action });
          return proxy(req, env, url);
        } catch (e) {
          if (e instanceof TollError && e.code === "store_unavailable") return json({ error: "unavailable" }, 503);
          // fall through to a fresh challenge (verifyPass already logged pass_reject with its reason)
        }
      } else {
        toll.metrics.passAbsent({ action, status: 403 });
      }
      toll.metrics.turnedAway();
      if ((req.headers.get("accept") ?? "").includes("text/html") && !(req.headers.get("accept") ?? "").includes("application/json")) return interstitial(req, url, action);
      if (!toll.allowChallenge(ip(req))) return json({ error: "toll_required" }, 403);
      const challenge = await toll.issueChallenge({ action, path, client: "widget", userAgent: req.headers.get("user-agent"), ip: ip(req), source: "middleware" });
      return json({ error: "toll_required", challenge }, 403);
    } catch (e) {
      if (e instanceof TollError) return json({ error: e.code }, e.code === "store_unavailable" ? 503 : 400);
      console.log(JSON.stringify({ event: "edge_error", message: (e as Error)?.message }));
      return json({ error: "internal" }, 500);
    }
  },
};

async function facade(req: Request, env: Env, url: URL, toll: ReturnType<typeof createToll>): Promise<Response> {
  const path = url.pathname;
  if (path === "/v1/health") return json({ ok: true, v: "1.0.0", settlement: "off", edge: true });
  if (path === "/v1/price" && req.method === "GET") {
    const action = url.searchParams.get("action") ?? "write";
    if (!(PAID_CLASSES as readonly string[]).includes(action)) return json({ error: "bad_action" }, 400);
    const cls = action as (typeof PAID_CLASSES)[number];
    return json(priceBody({ action: cls, status: "stub", p: null, challenge_url: toll.challengeUrl(cls, url.searchParams.get("path") ?? "/") }));
  }
  if (path === "/v1/challenge" && req.method === "GET") {
    const action = url.searchParams.get("action") ?? "write";
    if (!isActionClass(action) || action === "read") return json({ error: "bad_action" }, 400);
    if (!toll.allowChallenge(ip(req))) return json({ error: "rate_limited" }, 429, { "retry-after": "60" });
    const client = url.searchParams.get("client") === "agent" || req.headers.get("toll-client") === "agent" ? "agent" : "widget";
    const challenge = await toll.issueChallenge({ site: url.searchParams.get("site") ?? undefined, action, path: url.searchParams.get("path") ?? undefined, client, userAgent: req.headers.get("user-agent"), ip: ip(req), source: "challenge_endpoint" });
    return json({ challenge, offers: [] });
  }
  if (path === "/v1/redeem" && req.method === "POST") {
    const b = await body(req);
    if (b.offer_id !== undefined) return json({ error: "unsupported", detail: "paid redeem is not enabled at the edge" }, 400);
    if (typeof b.challenge_id !== "string" || typeof b.solution !== "object" || b.solution === null) return json({ error: "malformed" }, 400);
    const ch = b.challenge ?? toll.findIssued(b.challenge_id);
    if (!ch) return json({ error: "unknown_challenge" }, 401);
    if (ch.id !== b.challenge_id) return json({ error: "malformed" }, 400);
    try {
      const r = await toll.verifySolution(ch, b.solution, { ip: ip(req), client: b.client === "agent" ? "agent" : "widget" });
      return json({ pass: r.pass, exp: r.exp, cls: r.cls, rail: r.rail }, 200, { "set-cookie": cookieFor(r.pass, r.exp, toll.now(), url.protocol === "https:") });
    } catch (e) {
      const code = e instanceof TollError ? e.code : "error";
      return json({ error: code }, code === "replay" ? 401 : code === "store_unavailable" ? 503 : 400);
    }
  }
  if (path === "/v1/status" && req.method === "GET") {
    const token = passFrom(req);
    if (!token) return json({ ok: false });
    try {
      const c = await toll.verifyPass(token, { action: "search", consume: false });
      return json({ ok: true, exp: c.exp, cls: c.cls, n: c.remaining });
    } catch {
      return json({ ok: false });
    }
  }
  if (path === "/v1/siteverify" && req.method === "POST") {
    // Recaptcha-compatible subset (spec §8.5): form or JSON, secret + response (+ optional action).
    const b = await body(req);
    const secret = typeof b.secret === "string" ? b.secret : "";
    if (!timingSafeEqual(utf8(secret), utf8(env.SITE_SECRET))) return json({ success: false, "error-codes": ["invalid-input-secret"] });
    try {
      let token: string;
      const response = b.response;
      if (typeof response === "string" && response.trim().startsWith("{")) {
        const p = JSON.parse(response);
        const ch = p.challenge ?? toll.findIssued(p.challenge_id);
        if (!ch || ch.id !== p.challenge_id) throw new TollError("malformed");
        token = (await toll.verifySolution(ch, p.solution ?? {}, { ip: ip(req) })).pass;
      } else {
        token = String(response ?? "");
      }
      const action = isActionClass(b.action) ? b.action : undefined;
      const c = await toll.verifyPass(token, { action: action ?? "search" });
      return json({ success: true, action: c.cls, hostname: toll.config.hostname, challenge_ts: new Date(c.iat * 1000).toISOString() });
    } catch (e) {
      const code = e instanceof TollError ? e.code : "invalid-input-response";
      return json({ success: false, "error-codes": [code === "expired" || code === "exhausted" || code === "replay" ? "timeout-or-duplicate" : "invalid-input-response"] });
    }
  }
  return json({ error: "not_found" }, 404);
}
