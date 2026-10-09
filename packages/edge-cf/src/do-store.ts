// SQLite-backed Durable Object store. One named instance serialises every write, so first-use,
// use counts, tags and window counters are exact. Each method is one DO call (the SQL runs inside
// the object). consumeTagged spends a pass and reads its tag in that one call. Any error fails
// closed: the worker wrapper throws store_unavailable and the write is not forwarded.
import { DurableObject } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { TollError } from "../../protocol/src/index.ts";
import type { TollStore } from "../../server-node/src/stores.ts";

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
}

/**
 * Worker-side TollStore over one Durable Object stub. Each method is one RPC.
 * Fails closed on any error, and when this request's fail slot is set.
 */
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
  counts() { return this.run(() => this.stub.counts()); }
}
