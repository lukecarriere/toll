// TollStore on Workers KV (spec §17 "KV on CF"). Local runs use the KV that wrangler dev / miniflare
// simulate on disk or in memory; nothing here talks to a Cloudflare account.
// Caveat (docs in README): KV is eventually consistent across locations, so first-use and use counts
// are exact within one location only. A Durable Object store is the fix before any real deploy.
// Fail-safe (spec §16): any KV error throws store_unavailable, so writes are rejected, never waved through.
import { TollError } from "../../protocol/src/index.ts";
import type { TollStore } from "../../server-node/src/stores.ts";

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

// KV refuses TTLs under 60 s.
const ttl = (s: number) => Math.max(60, Math.ceil(s));

export class KVStore implements TollStore {
  private kv: KVLike;
  constructor(kv: KVLike) {
    this.kv = kv;
  }
  private async run<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof TollError) throw e;
      throw new TollError("store_unavailable");
    }
  }
  firstUse(key: string, ttl_s: number) {
    return this.run(async () => {
      if ((await this.kv.get("f:" + key)) !== null) return false;
      await this.kv.put("f:" + key, "1", { expirationTtl: ttl(ttl_s) });
      return true;
    });
  }
  consume(key: string, initial: number, ttl_s: number) {
    return this.run(async () => {
      const cur = await this.kv.get("n:" + key);
      const left = cur === null ? initial : Number(cur);
      if (left <= 0) return -1;
      await this.kv.put("n:" + key, String(left - 1), { expirationTtl: ttl(ttl_s) });
      return left - 1;
    });
  }
  peek(key: string) {
    return this.run(async () => {
      const cur = await this.kv.get("n:" + key);
      return cur === null ? undefined : Number(cur);
    });
  }
  setTag(key: string, tag: string, ttl_s: number) {
    return this.run(() => this.kv.put("t:" + key, tag, { expirationTtl: ttl(ttl_s) }));
  }
  getTag(key: string) {
    return this.run(async () => (await this.kv.get("t:" + key)) ?? undefined);
  }
}
