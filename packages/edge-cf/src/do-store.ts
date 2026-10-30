// SQLite-backed Durable Object store. One named instance serialises every write, so first-use,
// use counts, tags and window counters are exact. Each method is one DO call (the SQL runs inside
// the object). consumeTagged spends a pass and reads its tag in that one call. Any error fails
// closed: the worker wrapper throws store_unavailable and the write is not forwarded.
import { DurableObject } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { TollError } from "../../protocol/src/index.ts";
import type { TollStore } from "../../server-node/src/stores.ts";
import { CashuReceiveEngine } from "../../settlement-ln/src/cashu-receive.ts";
import { parseCashuMints } from "../../settlement-ln/src/cashu-net.ts";
import type { CashuBooks, PendingSwap, ProofSnapshot, ProofStore, StoredProof } from "../../settlement-ln/src/cashu-store.ts";
import { cashuFaultSlot, cashuFetch, type CashuEnv } from "./cashu-edge.ts";

/** Set true for the current request to make every store call fail closed. Unset: the store works. */
export const storeFailSlot = new AsyncLocalStorage<boolean>();

const num = (v: unknown) => Number(v);

export class TollStoreDO extends DurableObject {
  private sql: DurableObject["ctx"]["storage"]["sql"];
  private sweepAt = 0;

  constructor(ctx: DurableObject["ctx"], env: unknown) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS win (k TEXT PRIMARY KEY, start INTEGER NOT NULL, n INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS day (d TEXT PRIMARY KEY, accepted INTEGER NOT NULL, rejected INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS cashu_proof (secret TEXT PRIMARY KEY, mint TEXT NOT NULL, unit TEXT NOT NULL, amount INTEGER NOT NULL, keyset TEXT NOT NULL, c TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS cashu_spent (h TEXT PRIMARY KEY)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS cashu_pending (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS cashu_meta (k TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS cashu_mint_quote (quote TEXT PRIMARY KEY, action TEXT NOT NULL, amount INTEGER NOT NULL, mint TEXT NOT NULL, proofs TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS cashu_mint_loss (quote TEXT PRIMARY KEY, action TEXT NOT NULL, amount INTEGER NOT NULL)");
  }

  private now() {
    return Math.floor(Date.now() / 1000);
  }

  private sweep(now: number) {
    if (now < this.sweepAt) return;
    this.sweepAt = now + 30;
    this.sql.exec("DELETE FROM kv WHERE exp <= ?", now);
  }

  private row(k: string): { v: string; exp: number } | undefined {
    const rows = this.sql.exec("SELECT v, exp FROM kv WHERE k = ?", k).toArray();
    const r = rows[0];
    if (!r) return undefined;
    return { v: String(r.v), exp: num(r.exp) };
  }

  firstUse(key: string, ttl_s: number): boolean {
    const now = this.now();
    this.sweep(now);
    const k = "f:" + key;
    const cur = this.row(k);
    if (cur && cur.exp > now) return false;
    const exp = now + Math.max(1, Math.ceil(ttl_s));
    if (cur) this.sql.exec("UPDATE kv SET v = '1', exp = ? WHERE k = ?", exp, k);
    else this.sql.exec("INSERT INTO kv (k, v, exp) VALUES (?, '1', ?)", k, exp);
    return true;
  }

  consume(key: string, initial: number, ttl_s: number): number {
    const now = this.now();
    this.sweep(now);
    const k = "n:" + key;
    const cur = this.row(k);
    const live = cur && cur.exp > now;
    const left = live ? num(cur.v) : initial;
    if (left <= 0) return -1;
    const next = left - 1;
    const exp = now + Math.max(1, Math.ceil(ttl_s));
    if (cur) this.sql.exec("UPDATE kv SET v = ?, exp = ? WHERE k = ?", String(next), exp, k);
    else this.sql.exec("INSERT INTO kv (k, v, exp) VALUES (?, ?, ?)", k, String(next), exp);
    return next;
  }

  peek(key: string): number | null {
    const now = this.now();
    const cur = this.row("n:" + key);
    if (!cur || cur.exp <= now) return null;
    return num(cur.v);
  }

  setTag(key: string, tag: string, ttl_s: number): void {
    const now = this.now();
    const k = "t:" + key;
    const exp = now + Math.max(1, Math.ceil(ttl_s));
    const cur = this.row(k);
    if (cur) this.sql.exec("UPDATE kv SET v = ?, exp = ? WHERE k = ?", tag, exp, k);
    else this.sql.exec("INSERT INTO kv (k, v, exp) VALUES (?, ?, ?)", k, tag, exp);
  }

  getTag(key: string): string | null {
    const now = this.now();
    const cur = this.row("t:" + key);
    if (!cur || cur.exp <= now) return null;
    return cur.v;
  }

  /** Spend one use and read the pass tag. One DO call for a gated write. */
  consumeTagged(useKey: string, initial: number, ttl_s: number, tagKey: string): { remaining: number; tag: string | null } {
    const remaining = this.consume(useKey, initial, ttl_s);
    const tag = remaining < 0 ? null : this.getTag(tagKey);
    return { remaining, tag };
  }

  windowHit(key: string, window_s: number): number {
    const now = this.now();
    const rows = this.sql.exec("SELECT start, n FROM win WHERE k = ?", key).toArray();
    const row = rows[0];
    const start = row ? num(row.start) : 0;
    if (!row || now - start >= window_s) {
      if (row) this.sql.exec("UPDATE win SET start = ?, n = 1 WHERE k = ?", now, key);
      else this.sql.exec("INSERT INTO win (k, start, n) VALUES (?, ?, 1)", key, now);
      return 1;
    }
    const n = num(row.n) + 1;
    this.sql.exec("UPDATE win SET n = ? WHERE k = ?", n, key);
    return n;
  }

  windowCount(key: string, window_s: number): number {
    const now = this.now();
    const rows = this.sql.exec("SELECT start, n FROM win WHERE k = ?", key).toArray();
    const row = rows[0];
    if (!row || now - num(row.start) >= window_s) return 0;
    return num(row.n);
  }

  private day(now = this.now()): string {
    return new Date(now * 1000).toISOString().slice(0, 10);
  }

  note(kind: string): { accepted: number; rejected: number } {
    if (kind !== "accepted" && kind !== "rejected") throw new Error("bad kind");
    const d = this.day();
    const acc = kind === "accepted" ? 1 : 0;
    const rej = kind === "rejected" ? 1 : 0;
    this.sql.exec(
      "INSERT INTO day (d, accepted, rejected) VALUES (?, ?, ?) ON CONFLICT(d) DO UPDATE SET accepted = accepted + ?, rejected = rejected + ?",
      d, acc, rej, acc, rej,
    );
    return this.counts();
  }

  counts(): { accepted: number; rejected: number } {
    const rows = this.sql.exec("SELECT accepted, rejected FROM day WHERE d = ?", this.day()).toArray();
    const row = rows[0];
    if (!row) return { accepted: 0, rejected: 0 };
    return { accepted: num(row.accepted), rejected: num(row.rejected) };
  }

  private envOf(): CashuEnv {
    return (this.env ?? {}) as CashuEnv;
  }

  private lossN(): number {
    const rows = this.sql.exec("SELECT n FROM cashu_meta WHERE k = 'losses'").toArray();
    return rows.length ? num(rows[0].n) : 0;
  }

  private addLoss(n: number): void {
    if (!n) return;
    this.sql.exec("INSERT INTO cashu_meta (k, n) VALUES ('losses', ?) ON CONFLICT(k) DO UPDATE SET n = n + ?", n, n);
  }

  private pendingRows(): PendingSwap[] {
    const out: PendingSwap[] = [];
    for (const row of this.sql.exec("SELECT body FROM cashu_pending").toArray()) {
      const body = JSON.parse(String(row.body)) as PendingSwap;
      if (body && typeof body.id === "string" && Array.isArray(body.outputs)) out.push(body);
    }
    return out;
  }

  private proofRows(): StoredProof[] {
    return this.sql.exec("SELECT mint, unit, amount, keyset, secret, c FROM cashu_proof").toArray().map((r) => ({
      mint: String(r.mint),
      unit: "sat" as const,
      amount: num(r.amount),
      id: String(r.keyset),
      secret: String(r.secret),
      C: String(r.c),
    }));
  }

  private spentRows(): string[] {
    return this.sql.exec("SELECT h FROM cashu_spent").toArray().map((r) => String(r.h));
  }

  cashuRead(): ProofSnapshot {
    return { proofs: this.proofRows(), spent: this.spentRows(), pending: this.pendingRows(), losses: this.lossN() };
  }

  cashuBooks(): CashuBooks {
    const snap = this.cashuRead();
    const stored = snap.proofs.reduce((n, p) => n + p.amount, 0);
    const pending = snap.pending.reduce((n, p) => n + p.outSats, 0);
    return { stored, pending, losses: snap.losses, spent: snap.spent.length, inSats: stored + pending + snap.losses };
  }

  /** Persist a pending swap. Throws replay when an input is already spent. Returns the row that owns those inputs. */
  beginPending(p: PendingSwap): PendingSwap {
    for (const h of p.marks) {
      if (this.sql.exec("SELECT h FROM cashu_spent WHERE h = ?", h).toArray().length) throw new TollError("replay");
    }
    for (const existing of this.pendingRows()) {
      if (existing.marks.some((h) => p.marks.includes(h))) return existing;
    }
    this.sql.exec("INSERT INTO cashu_pending (id, body) VALUES (?, ?)", p.id, JSON.stringify(p));
    this.addLoss(p.inSats - p.outSats);
    return p;
  }

  commitPending(o: { id: string; proofs: StoredProof[]; marks: string[] }): void {
    const rows = this.sql.exec("SELECT body FROM cashu_pending WHERE id = ?", o.id).toArray();
    if (!rows.length) {
      if (o.marks.length > 0 && o.marks.every((h) => this.sql.exec("SELECT h FROM cashu_spent WHERE h = ?", h).toArray().length > 0)) return;
      throw new TollError("store_unavailable");
    }
    const pending = JSON.parse(String(rows[0].body)) as PendingSwap;
    const got = o.proofs.reduce((n, p) => n + p.amount, 0);
    if (got !== pending.outSats) throw new TollError("store_unavailable");
    for (const p of o.proofs) {
      this.sql.exec(
        "INSERT INTO cashu_proof (secret, mint, unit, amount, keyset, c) VALUES (?, ?, ?, ?, ?, ?)",
        p.secret, p.mint, p.unit, p.amount, p.id, p.C,
      );
    }
    for (const h of o.marks) this.sql.exec("INSERT INTO cashu_spent (h) VALUES (?) ON CONFLICT(h) DO NOTHING", h);
    this.sql.exec("DELETE FROM cashu_pending WHERE id = ?", o.id);
  }

  leasePending(id: string, owner: string, exp: number): void {
    const rows = this.sql.exec("SELECT body FROM cashu_pending WHERE id = ?", id).toArray();
    if (!rows.length) return;
    const pending = JSON.parse(String(rows[0].body)) as PendingSwap;
    if (pending.owner !== undefined && pending.owner !== owner) return;
    if (pending.at === undefined) pending.at = Date.now();
    pending.owner = owner;
    pending.leaseExp = exp;
    this.sql.exec("UPDATE cashu_pending SET body = ? WHERE id = ?", JSON.stringify(pending), id);
  }

  abortPending(id: string): void {
    const rows = this.sql.exec("SELECT body FROM cashu_pending WHERE id = ?", id).toArray();
    if (!rows.length) return;
    const pending = JSON.parse(String(rows[0].body)) as PendingSwap;
    const fee = pending.inSats - pending.outSats;
    if (fee) this.sql.exec("UPDATE cashu_meta SET n = ? WHERE k = 'losses'", Math.max(0, this.lossN() - fee));
    this.sql.exec("DELETE FROM cashu_pending WHERE id = ?", id);
  }

  losePending(o: { id: string; marks: string[] }): void {
    const rows = this.sql.exec("SELECT body FROM cashu_pending WHERE id = ?", o.id).toArray();
    if (!rows.length) return;
    const pending = JSON.parse(String(rows[0].body)) as PendingSwap;
    this.addLoss(pending.outSats);
    this.sql.exec("DELETE FROM cashu_pending WHERE id = ?", o.id);
    for (const h of o.marks) this.sql.exec("INSERT INTO cashu_spent (h) VALUES (?) ON CONFLICT(h) DO NOTHING", h);
  }

  /** One DO call. The worker's ProofStore uses these so every proof write is serialised on this instance. */
  async cashuBegin(p: PendingSwap): Promise<{ ok: true; pending: PendingSwap } | { ok: false; error: "replay" }> {
    try {
      const pending = this.beginPending(p);
      try { await this.armAlarm(); } catch { /* a later request still recovers */ }
      return { ok: true, pending };
    } catch (e) {
      if (e instanceof TollError && e.code === "replay") return { ok: false, error: "replay" };
      throw e;
    }
  }

  async cashuCommit(o: { id: string; proofs: StoredProof[]; marks: string[] }): Promise<{ ok: true } | { ok: false; error: "store_unavailable" }> {
    try {
      this.commitPending(o);
      return { ok: true };
    } catch (e) {
      if (e instanceof TollError) return { ok: false, error: "store_unavailable" };
      throw e;
    }
  }

  async cashuLease(id: string, owner: string, exp: number): Promise<{ ok: true }> {
    this.leasePending(id, owner, exp);
    return { ok: true };
  }

  async cashuAbort(id: string): Promise<{ ok: true }> {
    this.abortPending(id);
    return { ok: true };
  }

  /** Quote row, proofs, and the single-use mark. One call, so the SQL is one transaction. */
  claimMintQuote(row: { quote: string; action: string; amount: number; mint: string; proofs: { amount: number; secret: string; id: string; C: string }[] }): boolean {
    if (this.sql.exec("SELECT quote FROM cashu_mint_quote WHERE quote = ?", row.quote).toArray().length) return false;
    this.sql.exec(
      "INSERT INTO cashu_mint_quote (quote, action, amount, mint, proofs) VALUES (?, ?, ?, ?, ?)",
      row.quote, row.action, row.amount, row.mint, JSON.stringify(row.proofs),
    );
    for (const p of row.proofs) {
      this.sql.exec(
        "INSERT INTO cashu_proof (secret, mint, unit, amount, keyset, c) VALUES (?, ?, 'sat', ?, ?, ?)",
        p.secret, row.mint, p.amount, p.id, p.C,
      );
    }
    const exp = this.now() + 180;
    this.sql.exec("INSERT INTO kv (k, v, exp) VALUES (?, '1', ?)", "f:mq:" + row.quote, exp);
    return true;
  }

  hasMintQuote(quote: string): boolean {
    return this.sql.exec("SELECT quote FROM cashu_mint_quote WHERE quote = ?", quote).toArray().length > 0;
  }

  noteMintQuoteLoss(o: { quote: string; action: string; amount: number }): void {
    if (this.sql.exec("SELECT quote FROM cashu_mint_loss WHERE quote = ?", o.quote).toArray().length) return;
    this.sql.exec("INSERT INTO cashu_mint_loss (quote, action, amount) VALUES (?, ?, ?)", o.quote, o.action, o.amount);
    this.addLoss(o.amount);
  }

  async cashuLose(o: { id: string; marks: string[] }): Promise<{ ok: true }> {
    this.losePending(o);
    return { ok: true };
  }

  /** NUT-09 / NUT-07 for swaps saved before the mint call. Does not grant a gate. */
  async cashuRecover(): Promise<{ ok: true }> {
    const env = this.envOf();
    const mints = parseCashuMints(env.CASHU_MINTS, env.TOLL_TEST_HOOKS === "1");
    if (!mints.length || !this.pendingRows().length) return { ok: true };
    const engine = new CashuReceiveEngine({
      secret: "durable-object-recover-1",
      mints,
      store: this.localStore(),
      lookup: env.TOLL_TEST_HOOKS === "1" ? async () => ["1.1.1.1"] : undefined,
      fetch: cashuFetch(env, mints),
    });
    await engine.recoverSaved();
    if (!this.pendingRows().length) {
      try { await this.ctx.storage.deleteAlarm?.(); } catch { /* alarm is optional */ }
    }
    return { ok: true };
  }

  async alarm(): Promise<void> {
    await this.cashuRecover();
    if (this.pendingRows().length) {
      try { await this.armAlarm(); } catch { /* next request recovers */ }
    }
  }

  private async armAlarm(): Promise<void> {
    await this.ctx.storage.setAlarm?.(Date.now() + 60_000);
  }

  /** In-object store for alarm recovery. The request path uses RPC so the mint call stays outside the DO. */
  private localStore(): ProofStore {
    return {
      read: async () => this.cashuRead(),
      books: async () => this.cashuBooks(),
      begin: async (p) => this.beginPending(p),
      lease: async (id, owner, exp) => { this.leasePending(id, owner, exp); },
      commit: async (o) => { this.commitPending(o); },
      abort: async (id) => { this.abortPending(id); },
      lose: async (o) => { this.losePending(o); },
    };
  }
}

export interface TollDoStub {
  firstUse(key: string, ttl_s: number): Promise<boolean>;
  consume(key: string, initial: number, ttl_s: number): Promise<number>;
  peek(key: string): Promise<number | null>;
  setTag(key: string, tag: string, ttl_s: number): Promise<void>;
  getTag(key: string): Promise<string | null>;
  consumeTagged(useKey: string, initial: number, ttl_s: number, tagKey: string): Promise<{ remaining: number; tag: string | null }>;
  windowHit(key: string, window_s: number): Promise<number>;
  windowCount(key: string, window_s: number): Promise<number>;
  note(kind: string): Promise<{ accepted: number; rejected: number }>;
  counts(): Promise<{ accepted: number; rejected: number }>;
  cashuRead(): Promise<ProofSnapshot>;
  cashuBooks(): Promise<CashuBooks>;
  cashuBegin(p: PendingSwap): Promise<{ ok: true; pending: PendingSwap } | { ok: false; error: "replay" }>;
  cashuLease(id: string, owner: string, exp: number): Promise<{ ok: true }>;
  cashuCommit(o: { id: string; proofs: StoredProof[]; marks: string[] }): Promise<{ ok: true } | { ok: false; error: "store_unavailable" }>;
  cashuAbort(id: string): Promise<{ ok: true }>;
  cashuLose(o: { id: string; marks: string[] }): Promise<{ ok: true }>;
  cashuRecover(): Promise<{ ok: true }>;
  claimMintQuote(row: { quote: string; action: string; amount: number; mint: string; proofs: { amount: number; secret: string; id: string; C: string }[] }): Promise<boolean>;
  hasMintQuote(quote: string): Promise<boolean>;
  noteMintQuoteLoss(o: { quote: string; action: string; amount: number }): Promise<void>;
}

/**
 * Worker-side TollStore over one Durable Object stub. Each method is one RPC.
 * Fails closed on any error, and when this request's fail slot is set.
 */
/** ProofStore over the one TollStoreDO instance. Each call is one RPC, so writes cannot race across isolates. */
export class DurableProofStore implements ProofStore {
  private stub: TollDoStub;
  constructor(stub: TollDoStub) { this.stub = stub; }
  async read() {
    if (storeFailSlot.getStore() === true) throw new TollError("store_unavailable");
    return this.stub.cashuRead();
  }
  async books() {
    if (storeFailSlot.getStore() === true) throw new TollError("store_unavailable");
    return this.stub.cashuBooks();
  }
  async begin(p: PendingSwap) {
    if (storeFailSlot.getStore() === true) throw new TollError("store_unavailable");
    const r = await this.stub.cashuBegin(p);
    if (!r.ok) throw new TollError(r.error);
    return r.pending;
  }
  async lease(id: string, owner: string, exp: number) {
    if (storeFailSlot.getStore() === true) throw new TollError("store_unavailable");
    await this.stub.cashuLease(id, owner, exp);
  }
  async commit(o: { id: string; proofs: StoredProof[]; marks: string[] }) {
    if (storeFailSlot.getStore() === true) throw new TollError("store_unavailable");
    // CASHU_GUARD grant-only-stored: a test fault drops the write. The engine then refuses the gate.
    if (cashuFaultSlot.getStore() === "drop-commit") return;
    const r = await this.stub.cashuCommit(o);
    if (!r.ok) throw new TollError(r.error);
  }
  async abort(id: string) {
    if (storeFailSlot.getStore() === true) throw new TollError("store_unavailable");
    await this.stub.cashuAbort(id);
  }
  async lose(o: { id: string; marks: string[] }) {
    if (storeFailSlot.getStore() === true) throw new TollError("store_unavailable");
    await this.stub.cashuLose(o);
  }
  recover() { return this.stub.cashuRecover(); }
}

export class DurableObjectStore implements TollStore {
  private stub: TollDoStub;
  constructor(stub: TollDoStub) {
    this.stub = stub;
  }
  private async run<T>(f: () => Promise<T>): Promise<T> {
    if (storeFailSlot.getStore() === true) throw new TollError("store_unavailable");
    try {
      return await f();
    } catch (e) {
      if (e instanceof TollError) throw e;
      const err = e as Error;
      console.log(JSON.stringify({ event: "store_error", name: err?.name, message: err?.message }));
      throw new TollError("store_unavailable");
    }
  }
  firstUse(key: string, ttl_s: number) { return this.run(() => this.stub.firstUse(key, ttl_s)); }
  consume(key: string, initial: number, ttl_s: number) { return this.run(() => this.stub.consume(key, initial, ttl_s)); }
  peek(key: string) { return this.run(async () => (await this.stub.peek(key)) ?? undefined); }
  setTag(key: string, tag: string, ttl_s: number) { return this.run(() => this.stub.setTag(key, tag, ttl_s)); }
  getTag(key: string) { return this.run(async () => (await this.stub.getTag(key)) ?? undefined); }
  consumeTagged(useKey: string, initial: number, ttl_s: number, tagKey: string) {
    return this.run(async () => {
      const r = await this.stub.consumeTagged(useKey, initial, ttl_s, tagKey);
      return { remaining: r.remaining, tag: r.tag ?? undefined };
    });
  }
  windowHit(key: string, window_s: number) { return this.run(() => this.stub.windowHit(key, window_s)); }
  windowCount(key: string, window_s: number) { return this.run(() => this.stub.windowCount(key, window_s)); }
  note(kind: "accepted" | "rejected") { return this.run(async () => { await this.stub.note(kind); }); }
  claimMintQuote(row: { quote: string; action: string; amount: number; mint: string; proofs: { amount: number; secret: string; id: string; C: string }[] }) {
    return this.run(() => this.stub.claimMintQuote(row));
  }
  hasMintQuote(quote: string) { return this.run(() => this.stub.hasMintQuote(quote)); }
  noteMintQuoteLoss(o: { quote: string; action: string; amount: number }) { return this.run(async () => { await this.stub.noteMintQuoteLoss(o); }); }
  counts() { return this.run(() => this.stub.counts()); }
}
