#!/usr/bin/env node
// agent-pay: an automated client that pays per request on the demo's local test backend.
//
//   npm run agent-pay -- --writes 5            (demo running on http://localhost:8787)
//   node demo/agent-pay.mjs --writes 20 --base http://localhost:8787
//
// For each write: POST /contact as an agent -> 402 with an offer -> pay it through the test backend
// -> redeem the preimage for a one-use pass -> retry -> 200. Then two negative checks: the same
// preimage again (must be rejected as a replay) and the spent pass again (must be refused).
// Prints amounts in msat and USD (from the offer's display value) and the site ledger totals.
// No real money: the payer is the demo's test-only endpoint.
import { createAgent, testBackendPayer, type AgentOffer, AgentError } from "./index.ts";

export interface AgentPayReport {
  base: string;
  writes: { i: number; status: number; via: string; offer_id?: string; amount_msat?: number; usd?: string | null; pass_exp_in_s?: number }[];
  accepted: number;
  replay: { status: number; error?: string; rejected: boolean } | null;
  pass_reuse: { status: number; rejected: boolean } | null;
  paid_total_msat: number;
  ledger_before: Ledger | null;
  ledger_after: Ledger | null;
  ledger_delta: Ledger | null;
  usd_after: { collected: string | null; available: string | null } | null;
  ok: boolean;
}
type Ledger = { gross_msat: number; fee_held_msat: number; net_credited_msat: number; withdrawn_msat: number; available_msat: number };

function b64urlJson(s: string): any {
  return JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

async function stats(base: string): Promise<any> {
  const r = await fetch(base + "/demo/stats", { cache: "no-store" } as RequestInit);
  return r.status === 200 ? r.json() : null;
}

export async function agentPay(o: { base: string; writes: number; path?: string; log?: (s: string) => void }): Promise<AgentPayReport> {
  const base = o.base.replace(/\/$/, "");
  const log = o.log ?? (() => {});
  const path = o.path ?? "/contact";
  const agent = createAgent({ base, pay: testBackendPayer(base), work: false });
  const before = await stats(base);
  const writes: AgentPayReport["writes"] = [];
  let last: { offer: AgentOffer; preimage: string; pass: string } | null = null;
  let paidTotal = 0;
  for (let i = 1; i <= o.writes; i++) {
    const body = JSON.stringify({ message: `agent write ${i}` });
    try {
      const r = await agent.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body });
      const row: AgentPayReport["writes"][number] = { i, status: r.response.status, via: r.via };
      if (r.offer && r.preimage && r.pass) {
        row.offer_id = r.offer.id;
        row.amount_msat = r.offer.amount_msat;
        row.usd = r.offer.display?.usd ?? null;
        const claims = b64urlJson(r.pass.split(".")[1]);
        row.pass_exp_in_s = claims.exp - claims.iat;
        if (r.response.status === 200) paidTotal += r.offer.amount_msat;
        last = { offer: r.offer, preimage: r.preimage, pass: r.pass };
      }
      writes.push(row);
      log(`write ${i}: ${row.status} via ${row.via}${row.amount_msat !== undefined ? ` · ${row.amount_msat} msat · ${row.usd != null ? "$" + row.usd : "USD hidden (rate unavailable)"} · pass 1 use / ${row.pass_exp_in_s}s` : ""}`);
    } catch (e) {
      writes.push({ i, status: e instanceof AgentError ? (e.status ?? 0) : 0, via: "error" });
      log(`write ${i}: failed (${(e as Error).message})`);
    }
  }
  let replay: AgentPayReport["replay"] = null;
  let reuse: AgentPayReport["pass_reuse"] = null;
  if (last) {
    // Same offer + preimage again: one payment buys one pass.
    const r = await fetch(base + "/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offer_id: last.offer.id, kind: last.offer.kind, preimage: last.preimage, macaroon: last.offer.macaroon }) });
    const j: any = await r.json().catch(() => ({}));
    replay = { status: r.status, error: j.error, rejected: r.status === 401 && j.error === "replay" };
    log(`replayed payment: ${r.status} ${j.error ?? ""} -> ${replay.rejected ? "rejected" : "NOT rejected"}`);
    // The spent one-use pass again: refused (402 with a fresh offer for an agent).
    const p = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "toll-client": "agent", authorization: "Toll " + last.pass }, body: JSON.stringify({ message: "reuse" }) });
    reuse = { status: p.status, rejected: p.status === 402 || p.status === 403 };
    log(`spent pass reused: ${p.status} -> ${reuse.rejected ? "refused" : "NOT refused"}`);
  }
  const after = await stats(base);
  const lb: Ledger | null = before?.paid?.ledger ?? null;
  const la: Ledger | null = after?.paid?.ledger ?? null;
  const delta = lb && la ? (Object.fromEntries(Object.keys(la).map((k) => [k, (la as any)[k] - (lb as any)[k]])) as Ledger) : null;
  const accepted = writes.filter((w) => w.status === 200 && w.via === "paid").length;
  return {
    base,
    writes,
    accepted,
    replay,
    pass_reuse: reuse,
    paid_total_msat: paidTotal,
    ledger_before: lb,
    ledger_after: la,
    ledger_delta: delta,
    usd_after: after?.paid ? { collected: after.paid.collected, available: after.paid.available } : null,
    ok: accepted === o.writes && !!replay?.rejected && !!reuse?.rejected && (!delta || delta.gross_msat === paidTotal),
  };
}

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf("--" + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

export async function main() {
  const base = arg("base", process.env.TOLL_BASE ?? "http://localhost:8787");
  const writes = Math.max(1, Math.min(100, Number(arg("writes", "5")) || 5));
  const r = await agentPay({ base, writes, log: (s) => console.log(s) });
  if (r.ledger_delta) {
    const d = r.ledger_delta;
    console.log(`ledger (this run): gross ${d.gross_msat} msat · fee held ${d.fee_held_msat} msat · net ${d.net_credited_msat} msat`);
  }
  if (r.ledger_after) {
    const a = r.ledger_after;
    console.log(`ledger (site total): gross ${a.gross_msat} msat · fee held ${a.fee_held_msat} msat · available ${a.available_msat} msat · USD collected ${r.usd_after?.collected ?? "hidden"} · available ${r.usd_after?.available ?? "hidden"}`);
  }
  console.log(`${r.accepted}/${writes} paid writes accepted · replay ${r.replay?.rejected ? "rejected" : "NOT rejected"} · spent pass ${r.pass_reuse?.rejected ? "refused" : "NOT refused"} -> ${r.ok ? "OK" : "FAIL"}`);
  if (process.argv.includes("--json")) console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("agent-pay:", (e as Error).message);
    process.exit(1);
  });
}
