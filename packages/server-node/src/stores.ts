// In-memory stores for the demo and tests. Production swaps in Redis/KV with the same interface.
// Fail-safe rule (spec §16): if the store is unavailable, writes are rejected, never waved through.

import { TollError } from "../../protocol/src/index.ts";

export interface TollStore {
  /** Returns true the first time `key` is seen within its TTL, false afterwards. */
  firstUse(key: string, ttl_s: number): Promise<boolean>;
  /** Initialise to `initial` if absent, then decrement; each use restarts the TTL. Returns the remaining count after this use, or -1 if none were left. */
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
  /**
   * Single-use mark before the mint signs. False when the quote is already reserved.
   * `outputs` are the blinded secrets, stored with the row. Empty for the loopback mint.
   */
  reserveMintQuote?(row: { quote: string; action: string; amount: number; mint: string; outputs?: { amount: number; id: string; secret: string; r: string; B_: string }[] }): Promise<boolean>;
  /**
   * Open reservation whose lease has expired. Renews the lease and returns the blinded outputs.
   * Null when the quote is absent, already has proofs, or another request still holds the lease.
   */
  claimOpenMintQuote?(quote: string): Promise<{ amount: number; id: string; secret: string; r: string; B_: string }[] | null>;
  /** Delete an open reservation. False when the row is absent or already has proofs. */
  releaseMintQuote?(quote: string): Promise<boolean>;
  /** Drop the in-flight lease so the next presentation can claim the same outputs. */
  unlockMintQuote?(quote: string): Promise<void>;
  /** Proofs for a reserved quote. One call. False when that quote already has proofs. */
  finishMintQuote?(row: { quote: string; proofs: { amount: number; secret: string; id: string; C: string }[] }): Promise<boolean>;
  /** One insert of the quote row, its proofs, and the single-use mark. False when the quote is already claimed. */
  claimMintQuote?(row: { quote: string; action: string; amount: number; mint: string; proofs: { amount: number; secret: string; id: string; C: string }[] }): Promise<boolean>;
  hasMintQuote?(quote: string): Promise<boolean>;
  /** A paid quote we will not gate. No secrets. */
  noteMintQuoteLoss?(o: { quote: string; action: string; amount: number; reason?: string; mint?: string }): Promise<void>;
  /** Net losses: a loss whose quote later stored its proofs is recovered and not listed. */
  mintQuoteLosses?(): { quote: string; action: string; amount: number }[];
  /** Every loss record with its reason, recovered or not, for tests and audits. */
  mintQuoteLossRows?(): { quote: string; action: string; amount: number; reason: string; recovered: boolean }[];
  /** The mint each loss names ('' when unknown). */
  mintQuoteLossMints?(): { quote: string; mint: string }[];
  /** Quotes whose proofs this store holds, for tests and the books. */
  mintQuoteStored?(): { quote: string; action: string; amount: number }[];
  /**
   * Quotes the sweep may retry, in quote order after `after`, at most `limit`: open rows (no proofs)
   * and unrecovered losses that name a mint and are not `issued_no_row`, each at least `minAgeS` old.
   */
  mintQuoteSweepCandidates?(o: { after: string; limit: number; minAgeS: number }): Promise<{ quote: string; action: string; amount: number; mint: string; lost: number }[]>;
}

interface Entry { v: number; tag?: string; until: number }

export class MemoryStore implements TollStore {
  private m = new Map<string, Entry>();
  private quotes = new Map<string, { quote: string; action: string; amount: number; mint: string; proofs: { amount: number; secret: string; id: string; C: string }[]; outputs: { amount: number; id: string; secret: string; r: string; B_: string }[]; at: number }>();
  private losses: { quote: string; action: string; amount: number; reason: string; recovered: boolean; mint: string; at: number }[] = [];
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
    // Each spend restarts the TTL, as the edge stores do: a counter lasts ttl_s from its last use.
    e.until = this.now() + ttl_s;
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
    if (e) {
      e.tag = tag;
      // MINT_QUOTE_GUARD tag-ttl: a tag-only entry (the sweep cursor, a backoff mark) lives ttl_s from its last set.
      if (Number.isNaN(e.v)) e.until = this.now() + ttl_s;
    } else this.m.set(key, { v: Number.NaN, tag, until: this.now() + ttl_s });
  }

  async getTag(key: string): Promise<string | undefined> {
    this.check();
    return this.live(key)?.tag;
  }

  async reserveMintQuote(row: { quote: string; action: string; amount: number; mint: string; outputs?: { amount: number; id: string; secret: string; r: string; B_: string }[] }): Promise<boolean> {
    this.check();
    if (this.quotes.has(row.quote) || this.live("f:mq:" + row.quote)) return false;
    const until = this.now() + 30;
    this.quotes.set(row.quote, { quote: row.quote, action: row.action, amount: row.amount, mint: row.mint, proofs: [], outputs: row.outputs ?? [], at: this.now() });
    this.m.set("f:mq:" + row.quote, { v: 1, until });
    return true;
  }

  async claimOpenMintQuote(quote: string): Promise<{ amount: number; id: string; secret: string; r: string; B_: string }[] | null> {
    this.check();
    const held = this.quotes.get(quote);
    if (!held || held.proofs.length > 0 || this.live("f:mq:" + quote)) return null;
    this.m.set("f:mq:" + quote, { v: 1, until: this.now() + 30 });
    return held.outputs.map((o) => ({ ...o }));
  }

  async releaseMintQuote(quote: string): Promise<boolean> {
    this.check();
    const held = this.quotes.get(quote);
    if (!held || held.proofs.length > 0) return false;
    this.quotes.delete(quote);
    this.m.delete("f:mq:" + quote);
    return true;
  }

  async unlockMintQuote(quote: string): Promise<void> {
    this.check();
    const held = this.quotes.get(quote);
    if (!held || held.proofs.length > 0) return;
    this.m.delete("f:mq:" + quote);
  }

  async finishMintQuote(row: { quote: string; proofs: { amount: number; secret: string; id: string; C: string }[] }): Promise<boolean> {
    this.check();
    const held = this.quotes.get(row.quote);
    if (!held || held.proofs.length > 0) return false;
    held.proofs = row.proofs;
    // MINT_QUOTE_GUARD loss-reversal: a booked loss is reversed by the proofs that recover it, in the same write.
    const lost = this.losses.find((o) => o.quote === row.quote);
    if (lost) lost.recovered = true;
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

  async noteMintQuoteLoss(o: { quote: string; action: string; amount: number; reason?: string; mint?: string }): Promise<void> {
    this.check();
    if (this.losses.some((row) => row.quote === o.quote)) return;
    this.losses.push({ quote: o.quote, action: o.action, amount: o.amount, reason: o.reason ?? "", recovered: false, mint: o.mint ?? "", at: this.now() });
  }

  mintQuoteLosses() {
    return this.losses.filter((o) => !o.recovered).map((o) => ({ quote: o.quote, action: o.action, amount: o.amount }));
  }

  mintQuoteLossRows() {
    return this.losses.map((o) => ({ quote: o.quote, action: o.action, amount: o.amount, reason: o.reason, recovered: o.recovered }));
  }

  /** The mint each loss names ('' when unknown), for tests and audits. */
  mintQuoteLossMints(): { quote: string; mint: string }[] {
    return this.losses.map((o) => ({ quote: o.quote, mint: o.mint }));
  }

  async mintQuoteSweepCandidates(o: { after: string; limit: number; minAgeS: number }): Promise<{ quote: string; action: string; amount: number; mint: string; lost: number }[]> {
    this.check();
    // MINT_QUOTE_GUARD sweep-age: a row younger than the longest macaroon may still be presented.
    const cutoff = this.now() - o.minAgeS;
    const out = new Map<string, { quote: string; action: string; amount: number; mint: string; lost: number }>();
    for (const q of this.quotes.values()) {
      if (q.proofs.length === 0 && q.at <= cutoff) out.set(q.quote, { quote: q.quote, action: q.action, amount: q.amount, mint: q.mint, lost: 0 });
    }
    for (const l of this.losses) {
      if (l.recovered) continue;
      const open = out.get(l.quote);
      // MINT_QUOTE_GUARD sweep-lost: an open row carries its loss whatever the loss's age, since finishing the row reverses it.
      if (open) open.lost = l.amount;
      // A loss with no row: only a mint refusal or a lost restore can still be minted; issued_no_row cannot.
      // A loss booked before its mint was recorded (mint '') stays a candidate; the sweep tries the configured mint.
      else if (l.at <= cutoff && !this.quotes.has(l.quote) && l.reason !== "issued_no_row") out.set(l.quote, { quote: l.quote, action: l.action, amount: l.amount, mint: l.mint, lost: l.amount });
    }
    return [...out.values()].filter((c) => c.quote > o.after).sort((a, b) => (a.quote < b.quote ? -1 : 1)).slice(0, o.limit);
  }

  mintQuoteStored() {
    return [...this.quotes.values()].filter((o) => o.proofs.length > 0).map((o) => ({ quote: o.quote, action: o.action, amount: o.proofs.reduce((n, p) => n + p.amount, 0) }));
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
