// JSON-line metrics on stdout (spec §14 plus the later counter additions).
// Every redeem logs its raw took_ms with rail and cls tags so p50/p95 can be computed offline.
// Never logged: form bodies, cookies, Authorization values, pass tokens, IP addresses, invoices.

export type Sink = (line: string) => void;

export interface Counters {
  challenges_minted: number;
  redeems_ok: number;
  redeems_fail: number;
  pass_accept: number;
  /** Real rejections only: expired, replayed, invalid, wrong site, wrong class, exhausted. */
  pass_reject: number;
  /** Gated requests that carried no pass at all (first contact). Not a rejection. */
  pass_absent: number;
  /** Gate 403s (work-only challenge, no-JS page, or rate-limited), whatever the pass state. Agent 402s are not counted. */
  turned_away: number;
  avg_took_ms: number | null;
  settled_msat: number;
  /** 402 responses that carried at least one offer. Compare with `paid` (settle redeems). */
  offer_shown: number;
  /** Successful paid redeems (rail = settle). */
  paid: number;
  /** Work challenges fetched through a 402's challenge_url (offers=0): the agent did the work instead of paying. */
  work_after_402: number;
  settlement_degraded: number;
  /** Times the owner confirmed the page-view warning (Amendment 2 §A); same name in WordPress. */
  page_view_gate_confirmed: number;
  /** Agent discovery (Amendment 3, M11): GET /.well-known/toll.json and GET /.well-known/agents.json. */
  manifest_fetch: number;
  agents_json_fetch: number;
}

export class Metrics {
  c = { challenges_minted: 0, redeems_ok: 0, redeems_fail: 0, pass_accept: 0, pass_reject: 0, pass_absent: 0, turned_away: 0, settled_msat: 0, offer_shown: 0, paid: 0, work_after_402: 0, settlement_degraded: 0, page_view_gate_confirmed: 0, manifest_fetch: 0, agents_json_fetch: 0 };
  /** Per "rail|cls" tag counts for redeems_ok and pass_accept. */
  byTag: Record<string, { redeems_ok: number; pass_accept: number }> = {};
  private tookSum = 0;
  private tookN = 0;
  /** Bounded reservoir of recent took_ms values for the convenience p50/p95 in the counters line. */
  private recent: number[] = [];
  private sink: Sink;

  constructor(sink: Sink = (l) => process.stdout.write(l + "\n")) {
    this.sink = sink;
  }

  emit(event: string, fields: Record<string, unknown> = {}): void {
    this.sink(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
  }

  private tag(rail: string, cls: string) {
    const k = `${rail}|${cls}`;
    return (this.byTag[k] ??= { redeems_ok: 0, pass_accept: 0 });
  }

  challengeMinted(f: { cls: string; client: string; ua_class: string; mode: string; alg: string; counter_max: number; expected_tries: number; velocity_mult: number; escalated?: boolean; source: string }): void {
    this.c.challenges_minted++;
    this.emit("challenge_minted", f);
  }

  redeemOk(f: { rail: "work" | "settle"; cls: string; took_ms: number | null; ua_class: string | null; client: string; verify_ms: number }): void {
    this.c.redeems_ok++;
    if (f.rail === "settle") this.c.paid++;
    this.tag(f.rail, f.cls).redeems_ok++;
    if (f.took_ms !== null && f.rail === "work") {
      this.tookSum += f.took_ms;
      this.tookN++;
      this.recent.push(f.took_ms);
      if (this.recent.length > 2000) this.recent.shift();
    }
    this.emit("redeem_ok", f);
  }

  redeemFail(f: { reason: string; cls?: string; rail?: string }): void {
    this.c.redeems_fail++;
    this.emit("redeem_fail", f);
  }

  passAccept(f: { rail: string; cls: string; action: string; remaining: number }): void {
    this.c.pass_accept++;
    this.tag(f.rail, f.cls).pass_accept++;
    this.emit("pass_accept", f);
  }

  passReject(f: { reason: string; action: string }): void {
    this.c.pass_reject++;
    this.emit("pass_reject", f);
  }

  /**
   * A gated request with no pass (first contact). Logged apart from pass_reject so rejection rates
   * count only real rejections. `status` is the gate response: 402 (offers) or 403 (work challenge).
   */
  passAbsent(f: { action: string; status: number }): void {
    this.c.pass_absent++;
    this.emit("pass_absent", f);
  }

  /** A discovery document was fetched (M11). The event line carries no visitor fields at all. */
  discovery(doc: "manifest" | "agents_json"): void {
    if (doc === "manifest") this.c.manifest_fetch++;
    else this.c.agents_json_fetch++;
    this.emit(doc === "manifest" ? "manifest_fetch" : "agents_json_fetch");
  }

  /** The owner confirmed the page-view warning (config load with confirm_page_view_gating). */
  pageViewGateConfirmed(f: { warning: string; prefixes: string[] }): void {
    this.c.page_view_gate_confirmed++;
    this.emit("page_view_gate_confirmed", f);
  }

  /** A gate 403 went out (counter only; the pass_absent / pass_reject event already says why). */
  turnedAway(): void {
    this.c.turned_away++;
  }

  /** A 402 with offers went out (offers shown vs paid). Never logs the offer itself. */
  offerShown(f: { cls: string; amount_msat: number; offers: number }): void {
    this.c.offer_shown++;
    this.emit("offer_shown", f);
  }

  /**
   * GET /v1/challenge?offers=0, i.e. an agent fetched a 402's challenge_url to do the work instead of
   * paying. Abandoned 402s = offer_shown - paid - work_after_402.
   */
  workAfter402(f: { action: string; site: string; cls: string }): void {
    this.c.work_after_402++;
    this.emit("work_after_402", f);
  }

  settlementDegraded(f: { reason: string }): void {
    this.c.settlement_degraded++;
    this.emit("settlement_degraded", f);
  }

  settled(amount_msat: number): void {
    this.c.settled_msat += amount_msat;
  }

  avgTookMs(): number | null {
    return this.tookN ? Math.round(this.tookSum / this.tookN) : null;
  }

  snapshot(): Counters & { took_ms_p50: number | null; took_ms_p95: number | null; took_ms_n: number; by_tag: Metrics["byTag"] } {
    const s = [...this.recent].sort((a, b) => a - b);
    const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null);
    return { ...this.c, avg_took_ms: this.avgTookMs(), took_ms_p50: q(0.5), took_ms_p95: q(0.95), took_ms_n: this.tookN, by_tag: this.byTag };
  }

  flush(): void {
    this.emit("counters", { ...this.snapshot() } as Record<string, unknown>);
  }
}
