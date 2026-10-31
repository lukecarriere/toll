// In-memory stores for the demo and tests. Production swaps in Redis/KV with the same interface.
// Fail-safe rule (spec §16): if the store is unavailable, writes are rejected, never waved through.

import { TollError } from "../../protocol/src/index.ts";

export interface TollStore {
  /** Returns true the first time `key` is seen within its TTL, false afterwards. */
  firstUse(key: string, ttl_s: number): Promise<boolean>;
  /** Initialise to `initial` if absent, then decrement. Returns the remaining count after this use, or -1 if none were left. */
  consume(key: string, initial: number, ttl_s: number): Promise<number>;
  /** Remaining count without consuming, or undefined if unknown. */
  peek(key: string): Promise<number | undefined>;
  /** Attach a small string tag to a key (for example the rail a pass came from). */
  setTag(key: string, tag: string, ttl_s: number): Promise<void>;
  getTag(key: string): Promise<string | undefined>;
  /**
   * Spend one use and read the pass tag in one round trip, when the store can do that
   * (the edge Durable Object). Missing: callers use consume then getTag.
   */
  consumeTagged?(useKey: string, initial: number, ttl_s: number, tagKey: string): Promise<{ remaining: number; tag: string | undefined }>;
  /** Single-use mark before the mint signs. False when the quote is already reserved. No proofs yet. */
  reserveMintQuote?(row: { quote: string; action: string; amount: number; mint: string }): Promise<boolean>;
  /** Proofs for a reserved quote. One call. False when that quote already has proofs. */
  finishMintQuote?(row: { quote: string; proofs: { amount: number; secret: string; id: string; C: string }[] }): Promise<boolean>;
  /** One insert of the quote row, its proofs, and the single-use mark. False when the quote is already claimed. */
  claimMintQuote?(row: { quote: string; action: string; amount: number; mint: string; proofs: { amount: number; secret: string; id: string; C: string }[] }): Promise<boolean>;
  hasMintQuote?(quote: string): Promise<boolean>;
  /** A paid quote we will not gate. No secrets. */
  noteMintQuoteLoss?(o: { quote: string; action: string; amount: number }): Promise<void>;
  mintQuoteLosses?(): { quote: string; action: string; amount: number }[];
}

interface Entry { v: number; tag?: string; until: number }

export class MemoryStore implements TollStore {
  private m = new Map<string, Entry>();
  private quotes = new Map<string, { quote: string; action: string; amount: number; mint: string; proofs: { amount: number; secret: string; id: string; C: string }[] }>();
  private losses: { quote: string; action: string; amount: number }[] = [];
  private down = false;
  private now: () => number;
  private sweepAt = 0;

  constructor(now: () => number = () => Date.now() / 1000) {
    this.now = now;
  }

  /** Test hook: simulate the store being unreachable. */
  setDown(down: boolean): void {
    this.down = down;
  }

  private check(): void {
    if (this.down) throw new TollError("store_unavailable", "replay store unavailable");
    const t = this.now();
    if (t > this.sweepAt) {
      for (const [k, e] of this.m) if (e.until <= t) this.m.delete(k);
      this.sweepAt = t + 30;
    }
  }

  private live(key: string): Entry | undefined {
    const e = this.m.get(key);
    if (e && e.until > this.now()) return e;
    if (e) this.m.delete(key);
    return undefined;
  }

  async firstUse(key: string, ttl_s: number): Promise<boolean> {
    this.check();
    if (this.live(key)) return false;
    this.m.set(key, { v: 1, until: this.now() + ttl_s });
    return true;
  }

  async consume(key: string, initial: number, ttl_s: number): Promise<number> {
    this.check();
    const e = this.live(key) ?? { v: initial, until: this.now() + ttl_s };
    if (e.v <= 0) return -1;
    e.v -= 1;
    this.m.set(key, e);
    return e.v;
  }

  async peek(key: string): Promise<number | undefined> {
    this.check();
    return this.live(key)?.v;
  }

  async setTag(key: string, tag: string, ttl_s: number): Promise<void> {
    this.check();
    const e = this.live(key);
    if (e) e.tag = tag;
    else this.m.set(key, { v: Number.NaN, tag, until: this.now() + ttl_s });
  }

  async getTag(key: string): Promise<string | undefined> {
    this.check();
    return this.live(key)?.tag;
  }

  async reserveMintQuote(row: { quote: string; action: string; amount: number; mint: string }): Promise<boolean> {
    this.check();
    if (this.quotes.has(row.quote) || this.live("f:mq:" + row.quote)) return false;
    const until = this.now() + 180;
    this.quotes.set(row.quote, { ...row, proofs: [] });
    this.m.set("f:mq:" + row.quote, { v: 1, until });
    return true;
  }

  async finishMintQuote(row: { quote: string; proofs: { amount: number; secret: string; id: string; C: string }[] }): Promise<boolean> {
    this.check();
    const held = this.quotes.get(row.quote);
    if (!held || held.proofs.length > 0) return false;
    held.proofs = row.proofs;
    return true;
  }

  async claimMintQuote(row: { quote: string; action: string; amount: number; mint: string; proofs: { amount: number; secret: string; id: string; C: string }[] }): Promise<boolean> {
    if (!(await this.reserveMintQuote(row))) return false;
    return this.finishMintQuote(row);
  }

  async hasMintQuote(quote: string): Promise<boolean> {
    this.check();
    return this.quotes.has(quote);
  }

  async noteMintQuoteLoss(o: { quote: string; action: string; amount: number }): Promise<void> {
    this.check();
    this.losses.push({ quote: o.quote, action: o.action, amount: o.amount });
  }

  mintQuoteLosses() {
    return this.losses.map((o) => ({ ...o }));
  }
}

/** Fixed-window counter per key. Used for the per-IP challenge rate limit and for velocity. */
export class WindowCounter {
  private m = new Map<string, { start: number; count: number }>();
  private window_s: number;
  private now: () => number;

  constructor(window_s: number, now: () => number = () => Date.now() / 1000) {
    this.window_s = window_s;
    this.now = now;
  }

  hit(key: string): number {
    const t = this.now();
    let e = this.m.get(key);
    if (!e || t - e.start >= this.window_s) {
      e = { start: t, count: 0 };
      this.m.set(key, e);
    }
    e.count++;
    if (this.m.size > 50_000) for (const [k, v] of this.m) if (t - v.start >= this.window_s) this.m.delete(k);
    return e.count;
  }

  count(key: string): number {
    const e = this.m.get(key);
    if (!e || this.now() - e.start >= this.window_s) return 0;
    return e.count;
  }
}
