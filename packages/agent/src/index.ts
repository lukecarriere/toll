// Toll client for automated callers (spec §8.5-8.6, docs/settlement.md §4).
//
//   const agent = createAgent({ base: "http://localhost:8787", pay: async (offer) => preimageHex });
//   const r = await agent.fetch("/contact", { method: "POST", body: ... });
//
// Every request carries `Toll-Client: agent`. On 402 the agent pays `offers[0]` through the caller's
// `pay` function (a payment app or, in the demo, the local test backend), redeems the preimage at
// `POST /v1/redeem` for a short pass (one use, 60 s by default) and retries once with
// `Authorization: Toll <pass>`. On a 403 with only a work challenge (paid requests off or paused),
// it does the work with the engine's Node solver when `work: true`, otherwise returns the 403.
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
  /** Issuer and site origin, e.g. http://localhost:8787 */
  base: string;
  /** Pay an offer's invoice and return the 64-hex preimage. Throw to decline. */
  pay?: (offer: AgentOffer) => Promise<string>;
  /** Fall back to doing the work when no offer is available. Default true. */
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
  const url = (p: string) => (/^https?:/.test(p) ? p : base + p);

  function withHeaders(init: RequestInit | undefined, extra: Record<string, string>): RequestInit {
    const h = new Headers(init?.headers);
    h.set("toll-client", "agent");
    if (!h.has("accept")) h.set("accept", "application/json");
    for (const [k, v] of Object.entries(extra)) h.set(k, v);
    return { ...init, headers: h };
  }

  async function redeemPaid(offer: AgentOffer, preimage: string): Promise<{ pass: string; exp: number; cls: string; rail: string }> {
    const r = await f(url("/v1/redeem"), { method: "POST", headers: { "content-type": "application/json", "toll-client": "agent" }, body: JSON.stringify({ offer_id: offer.id, kind: offer.kind, preimage, macaroon: offer.macaroon }) });
    const j: any = await r.json().catch(() => ({}));
    if (r.status !== 200 || typeof j.pass !== "string") throw new AgentError("redeem", j.error ?? "rejected", r.status);
    return j;
  }

  async function redeemWork(challenge: any): Promise<string> {
    const s = await solveWork(challenge.work);
    if (!s) throw new AgentError("work", "no solution in time");
    const r = await f(url("/v1/redeem"), { method: "POST", headers: { "content-type": "application/json", "toll-client": "agent" }, body: JSON.stringify({ challenge_id: challenge.id, challenge, client: "agent", solution: { work: { counter: s.counter, derivedKey: s.derivedKey }, took_ms: Math.round(s.time) } }) });
    const j: any = await r.json().catch(() => ({}));
    if (r.status !== 200 || typeof j.pass !== "string") throw new AgentError("redeem", j.error ?? "rejected", r.status);
    return j.pass;
  }

  /** Fetch a protected resource, paying (or working) once if the gate asks. Bodies must be replayable (string/bytes). */
  async function agentFetch(path: string, init?: RequestInit): Promise<AgentResult> {
    const first = await f(url(path), withHeaders(init, {}));
    if (first.status !== 402 && first.status !== 403) return { response: first, via: "none" };
    const gate: any = await first.clone().json().catch(() => null);
    if (first.status === 402 && Array.isArray(gate?.offers) && gate.offers.length > 0 && o.pay) {
      const offer: AgentOffer = gate.offers[0];
      if (o.maxAmountMsat !== undefined && offer.amount_msat > o.maxAmountMsat) throw new AgentError("offer", `amount ${offer.amount_msat} msat is over the limit`);
      const preimage = (await o.pay(offer)).toLowerCase();
      const r = await redeemPaid(offer, preimage);
      const response = await f(url(path), withHeaders(init, { authorization: "Toll " + r.pass }));
      return { response, via: "paid", offer, preimage, pass: r.pass, gate: 402 };
    }
    if (gate?.challenge && o.work !== false) {
      const pass = await redeemWork(gate.challenge);
      const response = await f(url(path), withHeaders(init, { authorization: "Toll " + pass }));
      return { response, via: "work", pass, gate: first.status };
    }
    return { response: first, via: "none", gate: first.status };
  }

  /** Offers for an action without touching a protected route (GET /v1/challenge?client=agent). */
  async function offers(action = "write"): Promise<{ challenge: unknown; offers: AgentOffer[] }> {
    const r = await f(url(`/v1/challenge?action=${encodeURIComponent(action)}&client=agent`), { headers: { "toll-client": "agent" } });
    if (r.status !== 200) throw new AgentError("challenge", "status " + r.status, r.status);
    return (await r.json()) as any;
  }

  return { fetch: agentFetch, offers, redeemPaid };
}

/** Payer for the demo's local test backend (POST /demo/stub-pay). Test only: no real money moves. */
export function testBackendPayer(base: string, f: typeof fetch = fetch) {
  return async (offer: AgentOffer): Promise<string> => {
    const r = await f(base.replace(/\/$/, "") + "/demo/stub-pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invoice: offer.invoice }) });
    const j: any = await r.json().catch(() => ({}));
    if (r.status !== 200 || typeof j.preimage !== "string") throw new AgentError("pay", j.error ?? "test payment failed", r.status);
    return j.preimage;
  };
}
