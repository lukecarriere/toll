#!/usr/bin/env node
// Toll MCP server (Amendment 3): stdio JSON-RPC, exactly three tools, names and descriptions from
// docs/copy.md via packages/server-node/src/manifest.ts. Each tool finds the site's /v1 API from its
// /.well-known/toll.json and calls the existing contract: GET /v1/price, GET /v1/challenge
// (client=agent), POST /v1/redeem, POST /v1/siteverify. No second pay protocol, no reads gating, no
// caller identification: nothing about the caller is sent or stored. Counters are per UTC day with
// no ids (M11), written to stderr as JSON lines (stdout carries the protocol).
import { createInterface } from "node:readline";
import { realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TOOLS, INPUT_SCHEMAS, PAID_CLASSES, type ToolName } from "../../server-node/src/manifest.ts";

export const MCP_COUNTERS = ["mcp_tools_list", "mcp_call_price_write_action", "mcp_call_gate_form_write", "mcp_call_verify_write_pass", "mcp_offer_returned", "mcp_paid"] as const;
type Counter = (typeof MCP_COUNTERS)[number];
const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = Number(process.env.TOLL_MCP_TIMEOUT_MS ?? 5000);

/** Per-UTC-day counters, same scheme as the issuers: integers by day, no visitor ids. */
export class DayCounters {
  days: Record<string, Record<Counter, number>> = {};
  private now: () => Date;
  private file: string | undefined;
  constructor(now: () => Date = () => new Date(), file = process.env.TOLL_MCP_COUNTERS_FILE) {
    this.now = now;
    this.file = file;
  }
  bump(c: Counter) {
    const day = this.now().toISOString().slice(0, 10);
    const d = (this.days[day] ??= Object.fromEntries(MCP_COUNTERS.map((k) => [k, 0])) as Record<Counter, number>);
    d[c]++;
    process.stderr.write(JSON.stringify({ ts: this.now().toISOString(), event: "counters", day, timezone: "UTC", ...d }) + "\n");
    if (this.file) writeFileSync(this.file, JSON.stringify(this.days));
  }
}

class ToolError extends Error {}

async function getJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json", "toll-client": "agent", ...(init.headers ?? {}) } });
  const text = await r.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { throw new ToolError(`${url} did not return JSON (HTTP ${r.status})`); }
  return { status: r.status, body };
}

function origin(site: unknown): string {
  if (typeof site !== "string") throw new ToolError("site must be the site's origin, e.g. https://example.com");
  let u: URL;
  try { u = new URL(site); } catch { throw new ToolError("site must be an absolute http(s) URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ToolError("site must be an http(s) URL");
  return u.origin;
}

/** The site's /v1 base, from its manifest (cached for 60 s per origin). */
const apiCache = new Map<string, { api: string; until: number }>();
async function apiFor(site: unknown): Promise<string> {
  const o = origin(site);
  const hit = apiCache.get(o);
  if (hit && hit.until > Date.now()) return hit.api;
  const { status, body } = await getJson(o + "/.well-known/toll.json");
  if (status !== 200 || typeof body.api !== "string") throw new ToolError(`${o}/.well-known/toll.json is not a Toll manifest (HTTP ${status})`);
  const api = new URL(body.api, o).toString().replace(/\/$/, "");
  if (new URL(api).origin !== o) throw new ToolError("the manifest's api is on another origin");
  apiCache.set(o, { api, until: Date.now() + 60_000 });
  return api;
}

function action(a: unknown): string {
  const v = a ?? "write";
  if (typeof v !== "string" || !(PAID_CLASSES as readonly string[]).includes(v)) throw new ToolError(`action must be one of ${PAID_CLASSES.join(", ")}`);
  return v;
}

export async function callTool(name: ToolName, args: Record<string, any>, counters: DayCounters): Promise<Record<string, unknown>> {
  if (name === "price_write_action") {
    counters.bump("mcp_call_price_write_action");
    const api = await apiFor(args.site);
    const { status, body } = await getJson(`${api}/price?` + new URLSearchParams({ action: action(args.action) }));
    if (status !== 200) throw new ToolError(`price lookup failed (HTTP ${status}${body.error ? ", " + body.error : ""})`);
    // The price that applies right now (basis "current", load multiplier included), straight from the
    // site's live pricing, never the manifest's base figure: the description says "current".
    return { action: body.action, price: { amount_msat: body.amount_msat, usd: body.usd, status: body.status, display: body.display, basis: body.basis ?? "current", load_multiplier: body.load_multiplier ?? null }, work: body.work, reads_free: body.reads_free === true };
  }
  if (name === "gate_form_write") {
    counters.bump("mcp_call_gate_form_write");
    const api = await apiFor(args.site);
    const act = action(args.action);
    if (args.payment) {
      const p = args.payment;
      for (const k of ["offer_id", "kind", "preimage", "macaroon"]) if (typeof p[k] !== "string" || p[k] === "") throw new ToolError(`payment.${k} is required`);
      const { status, body } = await getJson(`${api}/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offer_id: p.offer_id, kind: p.kind, preimage: p.preimage, macaroon: p.macaroon }) });
      if (status !== 200 || typeof body.pass !== "string") return { paid: false, error: body.error ?? `HTTP ${status}` };
      counters.bump("mcp_paid");
      return { paid: true, pass: body.pass, exp: body.exp, cls: body.cls, uses: 1, send_as: "Authorization: Toll <pass>" };
    }
    const path = typeof args.path === "string" && args.path.startsWith("/") ? args.path : "/";
    const { status, body } = await getJson(`${api}/challenge?` + new URLSearchParams({ action: act, path, client: "agent" }));
    if (status !== 200) throw new ToolError(`challenge failed (HTTP ${status}${body.error ? ", " + body.error : ""})`);
    const offers = Array.isArray(body.offers) ? body.offers : [];
    if (offers.length) counters.bump("mcp_offer_returned");
    return { offers, challenge: body.challenge, redeem_url: `${api}/redeem` };
  }
  if (name === "verify_write_pass") {
    counters.bump("mcp_call_verify_write_pass");
    const api = await apiFor(args.site);
    if (typeof args.secret !== "string" || typeof args.pass !== "string") throw new ToolError("secret and pass are required");
    const body: Record<string, string> = { secret: args.secret, response: args.pass };
    if (args.action !== undefined) body.action = action(args.action);
    const r = await getJson(`${api}/siteverify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const ok = r.status === 200 && r.body.success === true;
    return ok ? { valid: true, action: r.body.action, hostname: r.body.hostname } : { valid: false, reason: (r.body["error-codes"] ?? [r.body.error ?? `HTTP ${r.status}`])[0] };
  }
  throw new ToolError("unknown tool " + name);
}

export function toolList() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: INPUT_SCHEMAS[t.name] }));
}

/** One JSON-RPC message in, zero or one out. */
export async function handle(msg: any, counters: DayCounters): Promise<object | null> {
  const id = msg?.id;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "invalid request");
  if (id === undefined) return null; // notification (e.g. notifications/initialized)
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "toll", version: "0.1.0" } });
    case "ping":
      return reply({});
    case "tools/list":
      counters.bump("mcp_tools_list");
      return reply({ tools: toolList() });
    case "tools/call": {
      const name = msg.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, "unknown tool");
      try {
        const out = await callTool(name, msg.params?.arguments ?? {}, counters);
        return reply({ content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: false });
      } catch (e) {
        const m = e instanceof ToolError ? e.message : "the site did not answer";
        return reply({ content: [{ type: "text", text: m }], isError: true });
      }
    }
    default:
      return fail(-32601, "method not found");
  }
}

/** True when this file is the process entrypoint, including a symlinked bin. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const counters = new DayCounters();
  const rl = createInterface({ input: process.stdin });
  let pending = 0;
  let closed = false;
  const finish = () => {
    if (closed && pending === 0) process.exit(0);
  };
  rl.on("line", async (line) => {
    pending++;
    try {
      if (!line.trim()) return;
      let msg: any;
      try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n"); return; }
      const out = await handle(msg, counters);
      if (out) process.stdout.write(JSON.stringify(out) + "\n");
    } finally {
      pending--;
      finish();
    }
  });
  rl.on("close", () => {
    closed = true;
    finish();
  });
}
