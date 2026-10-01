#!/usr/bin/env node
// agent-pay: an automated client that pays per request on the demo's local test backend.
//
//   npm run agent-pay -- --writes 5            (demo running on http://localhost:8787)
//   node demo/agent-pay.mjs --writes 20 --base http://localhost:8787
//
// For each write: POST /contact as an agent -> 402 with an offer -> pay it through the test backend
// -> redeem the preimage for a one-use pass -> retry -> 200. With no offer (paid requests switched
// off or paused) it gets a 403 and does the work instead (--no-work turns that off). Then two
// negative checks on the last paid write: the same preimage again (must be rejected as a replay) and
// the spent pass again (must be refused).
// Prints amounts in msat and USD (from the offer's display value) and the site ledger totals.
// No real money: the payer is the demo's test-only endpoint.
import { createAgent, testBackendPayer, type AgentOffer, AgentError } from "./index.ts";

export interface AgentPayWrite {
  i: number;
  status: number;
  via: string;
  rail?: string;
  cls?: string;
  offer_id?: string;
  amount_msat?: number;
  usd?: string | null;
  pass_n?: number;
  pass_ttl_s?: number;
  timings?: { pay_ms?: number; solve_ms?: number; redeem_ms?: number; total_ms: number };
}

export interface AgentPayReport {
  base: string;
  writes: AgentPayWrite[];
  /** Writes that ended 200 (paid or work). */
  accepted: number;
  paid: number;
  work: number;
  replay: { status: number; error?: string; rejected: boolean } | null;
  pass_reuse: { status: number; rejected: boolean } | null;
  paid_total_msat: number;
  ledger_before: Ledger | null;
  ledger_after: Ledger | null;
  ledger_delta: Ledger | null;
  usd_after: { collected: string | null; available: string | null } | null;
  /** Server counters over this run (from /demo/stats): 402s with offers vs paid redeems, pass split by rail. */
  server_delta: { offer_shown: number; paid: number; challenges_minted: number; settled_msat: number; passes_work: number; passes_settle: number } | null;
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

function counters(st: any) {
  const p = st?.paid;
  return p ? { offer_shown: p.offer_shown ?? 0, paid: p.paid ?? 0, challenges_minted: p.challenges_minted ?? 0, settled_msat: p.settled_msat ?? 0, passes_work: p.passes?.work ?? 0, passes_settle: p.passes?.settle ?? 0 } : null;
}

/**
 * Pay N writes. When no offer is available (paid requests switched off or paused) the agent does the
 * work instead, unless `work: false`. Replay and spent-pass checks run against the last PAID write.
 */
export async function agentPay(o: { base: string; writes: number; path?: string; work?: boolean; log?: (s: string) => void }): Promise<AgentPayReport> {
  const base = o.base.replace(/\/$/, "");
  const log = o.log ?? (() => {});
  const path = o.path ?? "/contact";
  const agent = createAgent({ base, pay: testBackendPayer(base), work: o.work !== false });
  const before = await stats(base);
  const writes: AgentPayWrite[] = [];
  let lastPaid: { offer: AgentOffer; preimage: string; pass: string } | null = null;
  let paidTotal = 0;
  for (let i = 1; i <= o.writes; i++) {
    const body = JSON.stringify({ message: `agent write ${i}` });
    try {
      const r = await agent.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body });
      const row: AgentPayWrite = { i, status: r.response.status, via: r.via, rail: r.redeemed?.rail, cls: r.redeemed?.cls, timings: r.timings };
      if (r.pass) {
        const claims = b64urlJson(r.pass.split(".")[1]);
        row.pass_n = claims.n;
        row.pass_ttl_s = claims.exp - claims.iat;
      }
      if (r.offer && r.preimage && r.pass) {
        row.offer_id = r.offer.id;
        row.amount_msat = r.offer.amount_msat;
        row.usd = r.offer.display?.usd ?? null;
        if (r.response.status === 200) paidTotal += r.offer.amount_msat;
        lastPaid = { offer: r.offer, preimage: r.preimage, pass: r.pass };
      }
      writes.push(row);
      const t = row.timings;
      const tm = t ? ` · ${t.pay_ms !== undefined ? `pay ${t.pay_ms} ms · ` : ""}${t.solve_ms !== undefined ? `solve ${t.solve_ms} ms · ` : ""}${t.redeem_ms !== undefined ? `redeem ${t.redeem_ms} ms · ` : ""}total ${t.total_ms} ms` : "";
      const money = row.amount_msat !== undefined ? ` · ${row.amount_msat} msat · ${row.usd != null ? "$" + row.usd : "USD hidden (rate unavailable)"}` : "";
      const tags = row.rail ? ` · rail=${row.rail} cls=${row.cls} · pass ${row.pass_n} use${row.pass_n === 1 ? "" : "s"} / ${row.pass_ttl_s}s` : "";
      log(`write ${i}: ${row.status} via ${row.via}${money}${tags}${tm}`);
    } catch (e) {
      writes.push({ i, status: e instanceof AgentError ? (e.status ?? 0) : 0, via: "error" });
      log(`write ${i}: failed (${(e as Error).message})`);
    }
  }
  let replay: AgentPayReport["replay"] = null;
  let reuse: AgentPayReport["pass_reuse"] = null;
  if (lastPaid) {
    // Same offer + preimage again: one payment buys one pass.
    const r = await fetch(base + "/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offer_id: lastPaid.offer.id, kind: lastPaid.offer.kind, preimage: lastPaid.preimage, macaroon: lastPaid.offer.macaroon }) });
    const j: any = await r.json().catch(() => ({}));
    replay = { status: r.status, error: j.error, rejected: r.status === 401 && j.error === "replay" };
    log(`replayed payment (offer ${lastPaid.offer.id}): ${r.status} ${j.error ?? ""} -> ${replay.rejected ? "rejected" : "NOT rejected"}`);
    // The spent one-use pass again: refused (402 with a fresh offer for an agent).
    const p = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "toll-client": "agent", authorization: "Toll " + lastPaid.pass }, body: JSON.stringify({ message: "reuse" }) });
    reuse = { status: p.status, rejected: p.status === 402 || p.status === 403 };
    log(`spent pass reused: ${p.status} -> ${reuse.rejected ? "refused" : "NOT refused"}`);
  } else {
    log("no paid write in this run: replay and spent-pass checks skipped");
  }
  const after = await stats(base);
  const lb: Ledger | null = before?.paid?.ledger ?? null;
  const la: Ledger | null = after?.paid?.ledger ?? null;
  const delta = lb && la ? (Object.fromEntries(Object.keys(la).map((k) => [k, (la as any)[k] - (lb as any)[k]])) as Ledger) : null;
  const cb = counters(before);
  const ca = counters(after);
  const server_delta = cb && ca ? (Object.fromEntries(Object.keys(ca).map((k) => [k, (ca as any)[k] - (cb as any)[k]])) as AgentPayReport["server_delta"]) : null;
  const accepted = writes.filter((w) => w.status === 200).length;
  const paid = writes.filter((w) => w.status === 200 && w.via === "paid").length;
  const work = writes.filter((w) => w.status === 200 && w.via === "work").length;
  return {
    base,
    writes,
    accepted,
    paid,
    work,
    replay,
    pass_reuse: reuse,
    paid_total_msat: paidTotal,
    ledger_before: lb,
    ledger_after: la,
    ledger_delta: delta,
    usd_after: after?.paid ? { collected: after.paid.collected, available: after.paid.available } : null,
    server_delta,
    ok: accepted === o.writes && (paid === 0 || (!!replay?.rejected && !!reuse?.rejected)) && (!delta || delta.gross_msat === paidTotal),
  };
}

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf("--" + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

export async function main() {
  const base = arg("base", process.env.TOLL_BASE ?? "http://localhost:8787");
  const writes = Math.max(1, Math.min(100, Number(arg("writes", "5")) || 5));
  const r = await agentPay({ base, writes, work: !process.argv.includes("--no-work"), log: (s) => console.log(s) });
  if (r.ledger_delta) {
    const d = r.ledger_delta;
    console.log(`ledger (this run): gross ${d.gross_msat} msat · fee held ${d.fee_held_msat} msat · net ${d.net_credited_msat} msat`);
  }
  if (r.ledger_after) {
    const a = r.ledger_after;
    console.log(`ledger (site total): gross ${a.gross_msat} msat · fee held ${a.fee_held_msat} msat · available ${a.available_msat} msat · USD collected ${r.usd_after?.collected ?? "hidden"} · available ${r.usd_after?.available ?? "hidden"}`);
  }
  if (r.server_delta) {
    const d = r.server_delta;
    console.log(`server (this run): offer_shown ${d.offer_shown} · paid ${d.paid} · challenges minted ${d.challenges_minted} · settled_msat ${d.settled_msat} · passes accepted: work ${d.passes_work}, settle ${d.passes_settle}`);
  }
  const checks = r.paid > 0 ? `replay ${r.replay?.rejected ? "rejected" : "NOT rejected"} · spent pass ${r.pass_reuse?.rejected ? "refused" : "NOT refused"}` : "no paid writes (paid requests off): replay checks skipped";
  console.log(`${r.accepted}/${writes} writes accepted (${r.paid} paid, ${r.work} work) · ${checks} -> ${r.ok ? "OK" : "FAIL"}`);
  if (process.argv.includes("--json")) console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("agent-pay:", (e as Error).message);
    process.exit(1);
  });
}
