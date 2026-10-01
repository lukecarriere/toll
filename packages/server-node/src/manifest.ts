// Agent discovery (Amendment 3): /.well-known/toll.json, the /.well-known/agents.json pointer and
// GET /v1/price. Copy is docs/copy.md "Amendment 3", verbatim. Prices are never hard-coded: every
// USD figure comes from the settlement rail's price() (the same function and round-up to $0.0001
// as the 402 offer) and always carries a status, "test" or "stub". Reads are never priced.
import type { ActionClass } from "../../protocol/src/index.ts";

/** Catalog description seed (Luke, verbatim, 147 characters). */
export const MANIFEST_DESCRIPTION = "Invisible check for writes. A person does not notice. A program that fires thousands of writes pays for each one, or stops. Public pages stay free.";
export const NOT_FOR = ["page views", "crawler blocking", "citation licensing"] as const;
export const PAID_CLASSES = ["write", "search", "account", "admin"] as const;
export type PriceStatus = "test" | "stub";

/** Tool names and descriptions (PM copy, verbatim). The description is the ranking signal. */
export const TOOLS = [
  {
    name: "price_write_action",
    description: "Returns the current USD price, and the work alternative, for one write on a Toll-protected site: a comment, signup, login, form post, or state-changing API call. Use it before a write to choose between paying and doing the work. Not for page views, which are free and need no call. Does not identify the caller.",
  },
  {
    name: "gate_form_write",
    description: "Gets a one-use pass for one write on a Toll-protected site. With no payment it returns the payment offer and a work challenge. With proof of payment it returns the pass. Use only for writes. Does not block public reads, does not detect who the caller is, and does not license or price content.",
  },
  {
    name: "verify_write_pass",
    description: "For the site's own server: checks that a pass sent with a write is valid, unused, and for this site and action. Returns valid or invalid with a reason. Does not score the caller or say whether it is a person or a program.",
  },
] as const;
export type ToolName = (typeof TOOLS)[number]["name"];

const site = { type: "string", description: "Origin of the Toll-protected site, e.g. https://example.com" };
const action = { type: "string", enum: [...PAID_CLASSES], default: "write" };
/** JSON Schemas for the tool inputs (machine-facing). */
export const INPUT_SCHEMAS: Record<ToolName, Record<string, unknown>> = {
  price_write_action: { type: "object", properties: { site, action }, required: ["site"], additionalProperties: false },
  gate_form_write: {
    type: "object",
    properties: {
      site,
      action,
      path: { type: "string", default: "/" },
      payment: {
        type: "object",
        properties: { offer_id: { type: "string" }, kind: { type: "string" }, preimage: { type: "string" }, macaroon: { type: "string" } },
        required: ["offer_id", "kind", "preimage", "macaroon"],
        additionalProperties: false,
      },
    },
    required: ["site"],
    additionalProperties: false,
  },
  verify_write_pass: {
    type: "object",
    properties: { site, secret: { type: "string" }, pass: { type: "string" }, action },
    required: ["site", "secret", "pass"],
    additionalProperties: false,
  },
};

export interface Price { amount_msat: number | null; usd: string | null; status: PriceStatus; display: string | null }

/**
 * docs/copy.md "Base price label" (PM, verbatim). Every manifest price is labelled `basis: "base"`
 * (the 402 at load multiplier 1); each priced tool carries this note. /v1/price and the MCP
 * price_write_action answer with `basis: "current"`: the price that applies right now, load included.
 */
export const BASE_PRICE_NOTE = "Base price. The 402 offer is the price that applies, and it can go up while the site is under load.";
const base = (p: Price) => ({ ...p, basis: "base" as const });

/** "$0.0100 (test)". Never a bare number; null when there is no USD to show (no paid offer, or the rate is unavailable). */
export function priceDisplay(usd: string | null | undefined, status: PriceStatus): string | null {
  return usd ? `$${usd} (${status})` : null;
}
export function price(amount_msat: number | null, usd: string | null | undefined, status: PriceStatus): Price {
  return { amount_msat, usd: usd ?? null, status, display: priceDisplay(usd, status) };
}
const FREE = (status: PriceStatus) => price(0, "0.0000", status);

/** What the agent can actually complete. x402 is not wired (docs/adapters.md "Agent discovery"). */
export function payment(status: PriceStatus, paid: boolean) {
  return paid
    ? { status: "stub" as const, protocol: "HTTP 402", methods: [{ kind: "ln402", status }], x402: { status: "stub" as const } }
    : { status: "stub" as const, protocol: "none", methods: [] as { kind: string; status: PriceStatus }[], x402: { status: "stub" as const } };
}

export type PriceTable = Partial<Record<Exclude<ActionClass, "read">, { amount_msat: number; usd: string | undefined }>> | null;

/**
 * The manifest. `prices` null means no paid offer on this host (work only): prices are null with
 * status "stub". `api` is the /v1 facade base (Node and edge `<origin>/v1`, WordPress
 * `<home>/wp-json/toll/v1`).
 */
export function buildManifest(o: { api: string; docs: string | null; status: PriceStatus; prices: PriceTable }) {
  const paid = !!o.prices;
  const by_action: Record<string, Price & { basis: "base" }> = {};
  for (const c of PAID_CLASSES) {
    const p = o.prices?.[c];
    by_action[c] = base(p ? price(p.amount_msat, p.usd, o.status) : price(null, null, "stub"));
  }
  const tool = (name: ToolName) => TOOLS.find((t) => t.name === name)!;
  return {
    name: "Toll",
    description: MANIFEST_DESCRIPTION,
    docs: o.docs,
    api: o.api,
    reads_free: true,
    not_for: [...NOT_FOR],
    tools: [
      { ...tool("price_write_action"), input_schema: INPUT_SCHEMAS.price_write_action, endpoint: o.api + "/price?action={action}", price: base(FREE(o.status)), payment: payment(o.status, false) },
      { ...tool("gate_form_write"), input_schema: INPUT_SCHEMAS.gate_form_write, endpoint: o.api + "/challenge?action={action}&path={path}&client=agent", price: { ...by_action.write, ...(paid ? { note: BASE_PRICE_NOTE } : {}), by_action }, payment: payment(o.status, paid) },
      { ...tool("verify_write_pass"), input_schema: INPUT_SCHEMAS.verify_write_pass, endpoint: o.api + "/siteverify", price: base(FREE(o.status)), payment: payment(o.status, false) },
    ],
  };
}

/** /.well-known/agents.json: a pointer only, no second description. */
export function agentsPointer(manifestUrl: string) {
  return { manifest: manifestUrl };
}

/**
 * GET /v1/price?action= body: the price of one paid request that applies right now (`basis: "current"`,
 * the 402 offer's amount for this caller including the load multiplier), plus the free work alternative.
 * load_multiplier is null when there is no paid offer.
 */
export function priceBody(o: { action: Exclude<ActionClass, "read">; status: PriceStatus; p: { amount_msat: number; usd: string | undefined; load_multiplier: number } | null; challenge_url: string }) {
  return { action: o.action, ...(o.p ? price(o.p.amount_msat, o.p.usd, o.status) : price(null, null, "stub")), basis: "current" as const, load_multiplier: o.p ? o.p.load_multiplier : null, work: { challenge_url: o.challenge_url }, reads_free: true };
}
