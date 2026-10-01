// Toll client for automated callers (spec §8.5-8.6, docs/settlement.md §4).
//
//   const agent = createAgent({ base: "http://localhost:8787", pay: async (offer) => preimageHex });
//   const r = await agent.fetch("/contact", { method: "POST", body: ... });
//
// Every request carries `Toll-Client: agent`. On 402 the agent pays `offers[0]` through the caller's
// `pay` function (a payment app or, in the demo, the local test backend), redeems the preimage at
// `POST /v1/redeem` for a short pass (one use, 60 s by default) and retries once with
// `Authorization: Toll <pass>`; the paid path never fetches a work challenge. When it cannot pay
// (no `pay`, payment declined, offer over `maxAmountMsat`) and `work` is on, it fetches the 402's
// `challenge_url` on demand and does the work with the engine's Node solver. On a 403 with an inline
// work challenge (paid requests off or paused) it does the work directly.
// The agent never parses invoices or macaroons: both are opaque strings from the issuer.
import { solveWork } from "../../work-adapter/src/index.ts";

export interface AgentOffer {
  id: string;
  kind: "ln402";
  amount_msat: number;
  display?: { usd: string; label: string };
  invoice: string;
  macaroon: string;
  exp: number;
}

export interface AgentOptions {
  /** Site origin for protected paths, e.g. http://localhost:8787 */
  base: string;
  /**
   * Issuer root that serves /v1/redeem and /v1/challenge. Default: `base` (the Node issuer). For the
   * WordPress plugin: `<site>/wp-json/toll`. A 402's `challenge_url` is resolved against it.
   */
  issuer?: string;
  /** Pay an offer's invoice and return the 64-hex preimage. Throw to decline. */
  pay?: (offer: AgentOffer) => Promise<string>;
  /** Fall back to doing the work when it cannot pay (or no offer is available). Default true. */
  work?: boolean;
  /** Refuse offers above this amount (msat). Default: no limit. */
  maxAmountMsat?: number;
  fetch?: typeof fetch;
}

export interface AgentResult {
  response: Response;
  /** How the pass for this request was obtained. "none": the first response was final. */
  via: "none" | "paid" | "work";
  offer?: AgentOffer;
  preimage?: string;
  pass?: string;
  /** Status of the gate response before the retry (402 or 403), when there was one. */
  gate?: number;
  /** What /v1/redeem said: rail ("settle" | "work") and class of the pass. */
  redeemed?: { rail: string; cls: string; exp: number };
  /** Client-side timings in ms: payment (test backend), work solve, redeem call, whole request. */
  timings?: { pay_ms?: number; challenge_ms?: number; solve_ms?: number; redeem_ms?: number; total_ms: number };
}

export class AgentError extends Error {
  readonly step: string;
  readonly status?: number;
  constructor(step: string, message: string, status?: number) {
    super(`${step}: ${message}`);
    this.step = step;
    this.status = status;
  }
}

export function createAgent(o: AgentOptions) {
  const f = o.fetch ?? fetch;
  const base = o.base.replace(/\/$/, "");
  const issuer = (o.issuer ?? o.base).replace(/\/$/, "");
  const url = (p: string) => (/^https?:/.test(p) ? p : base + p);
  const iurl = (p: string) => (/^https?:/.test(p) ? p : p.startsWith("/v1/") ? issuer + p : new URL(p, issuer + "/").toString());

  function withHeaders(init: RequestInit | undefined, extra: Record<string, string>): RequestInit {
    const h = new Headers(init?.headers);
    h.set("toll-client", "agent");
    if (!h.has("accept")) h.set("accept", "application/json");
    for (const [k, v] of Object.entries(extra)) h.set(k, v);
    return { ...init, headers: h };
  }

  async function redeemPaid(offer: AgentOffer, preimage: string): Promise<{ pass: string; exp: number; cls: string; rail: string }> {
    const r = await f(iurl("/v1/redeem"), { method: "POST", headers: { "content-type": "application/json", "toll-client": "agent" }, body: JSON.stringify({ offer_id: offer.id, kind: offer.kind, preimage, macaroon: offer.macaroon }) });
    const j: any = await r.json().catch(() => ({}));
    if (r.status !== 200 || typeof j.pass !== "string") throw new AgentError("redeem", j.error ?? "rejected", r.status);
    return j;
  }

  async function redeemWork(challenge: any): Promise<{ pass: string; rail: string; cls: string; exp: number; solve_ms: number; redeem_ms: number }> {
    const t0 = performance.now();
    const s = await solveWork(challenge.work);
    const solve_ms = performance.now() - t0;
    if (!s) throw new AgentError("work", "no solution in time");
    const t1 = performance.now();
    const r = await f(iurl("/v1/redeem"), { method: "POST", headers: { "content-type": "application/json", "toll-client": "agent" }, body: JSON.stringify({ challenge_id: challenge.id, challenge, client: "agent", solution: { work: { counter: s.counter, derivedKey: s.derivedKey }, took_ms: Math.round(s.time) } }) });
    const j: any = await r.json().catch(() => ({}));
    if (r.status !== 200 || typeof j.pass !== "string") throw new AgentError("redeem", j.error ?? "rejected", r.status);
    return { pass: j.pass, rail: j.rail, cls: j.cls, exp: j.exp, solve_ms, redeem_ms: performance.now() - t1 };
  }

  /** Fetch a protected resource, paying (or working) once if the gate asks. Bodies must be replayable (string/bytes). */
  async function agentFetch(path: string, init?: RequestInit): Promise<AgentResult> {
    const t0 = performance.now();
    const ms = (x: number) => Math.round(x * 10) / 10;
    const first = await f(url(path), withHeaders(init, {}));
    if (first.status !== 402 && first.status !== 403) return { response: first, via: "none", timings: { total_ms: ms(performance.now() - t0) } };
    const gate: any = await first.clone().json().catch(() => null);
    const canWork = o.work !== false;
    if (first.status === 402 && Array.isArray(gate?.offers) && gate.offers.length > 0 && o.pay) {
      const offer: AgentOffer = gate.offers[0];
      const overLimit = o.maxAmountMsat !== undefined && offer.amount_msat > o.maxAmountMsat;
      if (overLimit && !(canWork && gate.challenge_url)) throw new AgentError("offer", `amount ${offer.amount_msat} msat is over the limit`);
      if (!overLimit) {
        const tp = performance.now();
        let preimage: string | undefined;
        try {
          preimage = (await o.pay(offer)).toLowerCase();
        } catch (e) {
          if (!(canWork && gate.challenge_url)) throw e; // declined, and no way to do the work instead
        }
        if (preimage !== undefined) {
          const tr = performance.now();
          const r = await redeemPaid(offer, preimage);
          const redeem_ms = performance.now() - tr;
          const response = await f(url(path), withHeaders(init, { authorization: "Toll " + r.pass }));
          return { response, via: "paid", offer, preimage, pass: r.pass, gate: 402, redeemed: { rail: r.rail, cls: r.cls, exp: r.exp }, timings: { pay_ms: ms(tr - tp), redeem_ms: ms(redeem_ms), total_ms: ms(performance.now() - t0) } };
        }
      }
    }
    if (!canWork) return { response: first, via: "none", gate: first.status };
    // Work fallback. A 402 links the challenge (minted only when asked); a 403 carries it inline.
    let challenge = gate?.challenge;
    let challenge_ms: number | undefined;
    if (!challenge && first.status === 402 && typeof gate?.challenge_url === "string") {
      const tc = performance.now();
      const cr = await f(iurl(gate.challenge_url), { headers: { "toll-client": "agent", accept: "application/json" } });
      const cj: any = await cr.json().catch(() => ({}));
      if (cr.status !== 200 || !cj.challenge) throw new AgentError("challenge", cj.error ?? "status " + cr.status, cr.status);
      challenge = cj.challenge;
      challenge_ms = ms(performance.now() - tc);
    }
    if (challenge) {
      const w = await redeemWork(challenge);
      const response = await f(url(path), withHeaders(init, { authorization: "Toll " + w.pass }));
      return { response, via: "work", pass: w.pass, gate: first.status, redeemed: { rail: w.rail, cls: w.cls, exp: w.exp }, timings: { challenge_ms, solve_ms: ms(w.solve_ms), redeem_ms: ms(w.redeem_ms), total_ms: ms(performance.now() - t0) } };
    }
    return { response: first, via: "none", gate: first.status };
  }

  /** Offers for an action without touching a protected route (GET /v1/challenge?client=agent). */
  async function offers(action = "write"): Promise<{ challenge: unknown; offers: AgentOffer[] }> {
    const r = await f(iurl(`/v1/challenge?action=${encodeURIComponent(action)}&client=agent`), { headers: { "toll-client": "agent" } });
    if (r.status !== 200) throw new AgentError("challenge", "status " + r.status, r.status);
    return (await r.json()) as any;
  }

  return { fetch: agentFetch, offers, redeemPaid };
}

/**
 * Payer for the demo's local test backend (POST /demo/stub-pay). `base` is the demo origin, or the
 * full test-payer URL. Test only: no real money moves.
 */
export function testBackendPayer(base: string, f: typeof fetch = fetch) {
  const b = base.replace(/\/$/, "");
  const payUrl = /\/demo\/stub-pay$/.test(b) ? b : b + "/demo/stub-pay";
  return async (offer: AgentOffer): Promise<string> => {
    const r = await f(payUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invoice: offer.invoice }) });
    const j: any = await r.json().catch(() => ({}));
    if (r.status !== 200 || typeof j.preimage !== "string") throw new AgentError("pay", j.error ?? "test payment failed", r.status);
    return j.preimage;
  };
}
