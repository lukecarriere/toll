// Expected to FAIL on 266c9a0d28e5583fa8fb8c917e6e4a793e82aa9a.
// Not part of the root test run. The mock KV is linearisable. The store still
// double-grants because the read and the write are separate calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KVStore, type KVLike } from "../../packages/edge-cf/src/kv-store.ts";

function racingKv(): KVLike {
  const map = new Map<string, string>();
  let gets = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    async get(key: string) {
      gets++;
      if (gets === 2) release();
      if (gets <= 2) await gate;
      return map.get(key) ?? null;
    },
    async put(key: string, value: string) {
      map.set(key, value);
    },
  };
}

test("KV firstUse admits one caller", async () => {
  const store = new KVStore(racingKv());
  const [a, b] = await Promise.all([store.firstUse("offer:1", 120), store.firstUse("offer:1", 120)]);
  assert.equal(Number(a) + Number(b), 1, `both callers were admitted (${a}, ${b})`);
});

test("KV consume spends a one-use pass once", async () => {
  const store = new KVStore(racingKv());
  const [a, b] = await Promise.all([store.consume("uses:jti", 1, 120), store.consume("uses:jti", 1, 120)]);
  const granted = [a, b].filter((n) => n >= 0).length;
  assert.equal(granted, 1, `both spends were accepted (remaining ${a}, ${b})`);
});
