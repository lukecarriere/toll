// The mint-quote sweep's per-run budget (Workers Free: 50 subrequests), its per-quote backoff, the
// mint '' fallback and the reversal count. Local stubs and a local test mint only; nothing is paid.
// New exports are read through needs(), so on a base without them this file loads and fails on assertions.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as ln from "../packages/settlement-ln/src/index.ts";
import { MemoryStore } from "../packages/server-node/src/stores.ts";

const PUBLIC = "https://pay.example.com/Bitcoin";
const OTHER = "https://other.example.com/Bitcoin";
const AGE = 120;

function needs<K extends keyof typeof ln>(...names: K[]): Pick<typeof ln, K> {
  for (const n of names) assert.notEqual(ln[n], undefined, `settlement-ln exports ${String(n)}`);
  return ln;
}

type Answer = "unknown" | "refused" | "hang";

/**
 * A stub mint that answers every call the worst way: the quote stays PAID, posts fail (`unknown`:
 * a 500 with no detail, so the row is kept; `refused`: a mint error), restore finds nothing. Keys come
 * from a local keyset mint. Counts every call that reaches it.
 */
async function worstMint() {
  const keyset = await ln.startKeysetMint({ quotes: true });
  const origin = new URL(keyset.url).origin;
  const calls: string[] = [];
  let answer: Answer = "unknown";
  const fetchImpl: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const p = u.pathname.slice(u.pathname.indexOf("/v1/"));
    calls.push((init?.method ?? "GET") + " " + p);
    if (answer === "hang") {
      return new Promise<Response>((_, reject) => {
        const s = init?.signal;
        if (s?.aborted) reject(s.reason);
        s?.addEventListener("abort", () => reject(s.reason));
      });
    }
    if (p.startsWith("/v1/keys")) return fetch(origin + p, init);
    if (p.startsWith("/v1/mint/quote/bolt11/")) return Response.json({ quote: decodeURIComponent(p.split("/").pop() ?? ""), state: "PAID", amount: 10, unit: "sat", request: "lnbc1", expiry: null });
    if (p === "/v1/restore") return Response.json({ outputs: [], signatures: [] });
    return Response.json(answer === "refused" ? { detail: "quote refused", code: 20001 } : {}, { status: 500 });
  };
  return { calls, fetchImpl, set: (a: Answer) => { answer = a; }, close: () => keyset.close() };
}

function deps(store: MemoryStore, o: { fetchImpl: typeof fetch; mode?: "bolt11" | "loopback"; tags?: boolean; marks?: number[]; calls?: string[]; clock?: () => number }) {
  return {
    mint: PUBLIC, fetchImpl: o.fetchImpl, mode: o.mode ?? "bolt11" as const, guard: { lookup: async () => ["1.1.1.1"] }, allowlist: [PUBLIC],
    has: (q: string) => store.hasMintQuote(q), reserve: (r: Parameters<MemoryStore["reserveMintQuote"]>[0]) => store.reserveMintQuote(r),
    claimOpen: (q: string) => store.claimOpenMintQuote(q), release: (q: string) => store.releaseMintQuote(q), unlock: (q: string) => store.unlockMintQuote(q),
    finish: (r: Parameters<MemoryStore["finishMintQuote"]>[0]) => store.finishMintQuote(r), noteLoss: (x: Parameters<MemoryStore["noteMintQuoteLoss"]>[0]) => store.noteMintQuoteLoss(x),
    refusalsLeft: (q: string, cap: number) => store.consume("f:mqr:" + q, cap, ln.REFUSAL_COUNT_TTL_S),
    rechecks: ln.mintQuoteRechecks(store),
    candidates: (q: { after: string; limit: number; minAgeS: number }) => {
      assert.equal(typeof store.mintQuoteSweepCandidates, "function");
      return store.mintQuoteSweepCandidates(q);
    },
    cursor: {
      get: () => store.getTag("f:mqsweep:cursor"),
      set: async (q: string) => { o.marks?.push(o.calls?.length ?? 0); await store.setTag("f:mqsweep:cursor", q, 86_400); },
    },
    ...(o.tags ? { tags: { get: (k: string) => store.getTag(k), set: (k: string, v: string, ttl: number) => store.setTag(k, v, ttl) } } : {}),
    clock: o.clock ?? (() => performance.now()),
  };
}

/** Calls each item made, from the call log offsets taken when the item started. */
function perItem(marks: number[], total: number): number[] {
  return marks.map((m, i) => (i + 1 < marks.length ? marks[i + 1] : total) - m);
}

async function lossRows(store: MemoryStore, n: number, mint = PUBLIC, prefix = "q") {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const quote = prefix + String(i).padStart(2, "0");
    await store.noteMintQuoteLoss({ quote, action: "write", amount: 10, reason: "mint_refused", mint });
    out.push(quote);
  }
  return out;
}

test("sweep budget arithmetic: defaults keep a worst-case run under 50 subrequests and 30 s", () => {
  const c = needs("SWEEP_MAX_CALLS", "SWEEP_KEY_CALLS", "SWEEP_ITEM_CALLS", "SWEEP_CALL_MS", "SWEEP_DEFAULT_BATCH", "SWEEP_DEFAULT_BUDGET_MS");
  assert.equal(c.SWEEP_MAX_CALLS, 40);
  assert.deepEqual(c.SWEEP_ITEM_CALLS, { bolt11: 10, loopback: 8 });
  assert.equal(c.SWEEP_KEY_CALLS, 2);
  assert.equal(c.SWEEP_CALL_MS, 1500);
  // Edge: 1 cron-to-object call + at most 2 DNS lookups (memoized per run) + the mint calls.
  assert.ok(1 + 2 + c.SWEEP_MAX_CALLS < 50);
  // Three cold-key worst-case items fit; a fourth would not.
  assert.ok(c.SWEEP_KEY_CALLS + 3 * c.SWEEP_ITEM_CALLS.bolt11 <= c.SWEEP_MAX_CALLS);
  assert.ok(c.SWEEP_KEY_CALLS + 4 * c.SWEEP_ITEM_CALLS.bolt11 > c.SWEEP_MAX_CALLS);
  // An item starts only while elapsed <= budget - its worst time, so a run ends by the budget.
  assert.ok((c.SWEEP_ITEM_CALLS.bolt11 + c.SWEEP_KEY_CALLS) * c.SWEEP_CALL_MS <= c.SWEEP_DEFAULT_BUDGET_MS);
  assert.ok(c.SWEEP_DEFAULT_BUDGET_MS < 30_000);
});

test("sweep call cap: worst-case answers take 12, 10 and 10 calls and the run stops before a fourth item", async () => {
  const { sweepMintQuotes, SWEEP_MAX_CALLS } = needs("sweepMintQuotes", "SWEEP_MAX_CALLS");
  const mint = await worstMint();
  try {
    let now = 1_000_000;
    const store = new MemoryStore(() => now);
    await lossRows(store, 12);
    now += AGE + 1;
    // Run 1: every post times out, so each quote keeps an open row with outputs.
    const marks1: number[] = [];
    const first = await sweepMintQuotes(deps(store, { fetchImpl: mint.fetchImpl, marks: marks1, calls: mint.calls }), { batch: 25, budgetMs: 24_000 });
    assert.equal(first.calls, mint.calls.length, "every counted call reached the mint");
    assert.ok(first.calls <= SWEEP_MAX_CALLS);
    assert.equal(first.stop, "calls");
    assert.equal(mint.calls.filter((c) => c.endsWith("/v1/keysets")).length, 1, "keys are fetched once per run");
    // Run 2 over the same rows: the mint now refuses, the worst path (state, then state post restore
    // state, release, then post state post restore state).
    // The open rows are swept once they are as old as a loss would have to be.
    await store.setTag("f:mqsweep:cursor", "", 1);
    now += AGE + 1;
    mint.calls.length = 0;
    mint.set("refused");
    const marks: number[] = [];
    const s = await sweepMintQuotes(deps(store, { fetchImpl: mint.fetchImpl, marks, calls: mint.calls }), { batch: 25, budgetMs: 24_000 });
    assert.deepEqual(perItem(marks, mint.calls.length), [12, 10, 10]);
    assert.deepEqual({ scanned: s.scanned, skipped: s.skipped, calls: s.calls, stop: s.stop, stoppedEarly: s.stoppedEarly }, { scanned: 3, skipped: 3, calls: 32, stop: "calls", stoppedEarly: true });
    assert.equal(mint.calls.length, 32);
    // A lower cap is honored before the first item: 12 fits, 11 does not.
    await store.setTag("f:mqsweep:cursor", "", 1);
    now += 2;
    mint.calls.length = 0;
    const one = await sweepMintQuotes(deps(store, { fetchImpl: mint.fetchImpl }), { batch: 25, budgetMs: 24_000, maxCalls: 12 });
    assert.equal(one.scanned, 1);
    assert.ok(one.calls <= 12 && mint.calls.length === one.calls);
    const none = await sweepMintQuotes(deps(store, { fetchImpl: mint.fetchImpl }), { batch: 25, budgetMs: 24_000, maxCalls: 11 });
    assert.deepEqual({ scanned: none.scanned, calls: none.calls, stop: none.stop }, { scanned: 0, calls: 0, stop: "calls" });
    for (const bad of [{ maxCalls: 41 }, { maxCalls: -1 }, { callMs: 1501 }, { callMs: 0 }, { itemCalls: 11 }, { itemCalls: 0 }]) {
      await assert.rejects(sweepMintQuotes(deps(store, { fetchImpl: mint.fetchImpl }), { batch: 25, budgetMs: 24_000, ...bad }), { code: "malformed" }, JSON.stringify(bad));
    }
  } finally {
    await mint.close();
  }
});

test("sweep item cap: an item is cut off at its worst case and its row is kept", async () => {
  const { sweepMintQuotes } = needs("sweepMintQuotes", "SWEEP_MAX_CALLS");
  const mint = await worstMint();
  try {
    let now = 1_000_000;
    const store = new MemoryStore(() => now);
    const quotes = await lossRows(store, 4);
    now += AGE + 1;
    const marks: number[] = [];
    const s = await sweepMintQuotes(deps(store, { fetchImpl: mint.fetchImpl, marks, calls: mint.calls }), { batch: 25, budgetMs: 24_000, itemCalls: 3 });
    assert.deepEqual(perItem(marks, mint.calls.length), [5, 3, 3, 3], "keys (2) plus 3, then 3 each");
    assert.equal(s.calls, 14);
    assert.equal(s.skipped, 4);
    assert.equal(store.mintQuoteLosses().reduce((n, l) => n + l.amount, 0), 40, "every loss stays booked");
    assert.deepEqual(store.mintQuoteLossRows().map((l) => l.quote).sort(), quotes);
  } finally {
    await mint.close();
  }
});

test("sweep time budget: each call is aborted after callMs and no item starts past budget minus its worst time", async () => {
  const { sweepMintQuotes } = needs("sweepMintQuotes", "SWEEP_MAX_CALLS");
  const mint = await worstMint();
  try {
    let now = 1_000_000;
    const store = new MemoryStore(() => now);
    await lossRows(store, 10);
    now += AGE + 1;
    mint.set("hang");
    const t0 = performance.now();
    // Worst item: (10 + 2) x 20 ms = 240 ms for the first, 200 ms after; the budget is 300 ms.
    const s = await sweepMintQuotes(deps(store, { fetchImpl: mint.fetchImpl }), { batch: 25, budgetMs: 300, callMs: 20 });
    const ms = performance.now() - t0;
    assert.equal(s.stop, "time");
    assert.ok(s.scanned >= 1 && s.scanned < 10, JSON.stringify(s));
    assert.ok(ms < 300 + 150, `the run took ${ms} ms`);
  } finally {
    await mint.close();
  }
});

test("sweep backoff: a quote that keeps failing is retried after 1, 2, 4, ... runs and not after SWEEP_MAX_TRIES", async () => {
  const { sweepMintQuotes, SWEEP_MAX_TRIES } = needs("sweepMintQuotes", "SWEEP_MAX_TRIES", "SWEEP_BACKOFF_PREFIX");
  assert.equal(SWEEP_MAX_TRIES, 6);
  let now = 1_000_000;
  const store = new MemoryStore(() => now);
  const [quote] = await lossRows(store, 1, OTHER);
  now += AGE + 1;
  const tries: number[] = [];
  let deferred = 0;
  for (let run = 1; run <= 80; run++) {
    const s = await sweepMintQuotes(deps(store, { fetchImpl: () => Promise.reject(new Error("no mint call expected")), tags: true }), { batch: 25, budgetMs: 24_000 });
    assert.equal(s.scanned, 1);
    if (s.skipped) tries.push(run);
    deferred += s.deferred;
    now += 1;
  }
  assert.deepEqual(tries, [1, 3, 7, 15, 31, 63]);
  assert.equal(deferred, 80 - 6);
  assert.equal(await store.getTag("f:mqsb:" + quote), "6:63");
  assert.deepEqual(store.mintQuoteLosses().map((l) => l.amount), [10], "the loss stays booked");
});

test("sweep backoff: refusers tried once are deferred without mint calls, so the next run reaches the rest", async () => {
  const { sweepMintQuotes } = needs("sweepMintQuotes", "SWEEP_MAX_CALLS");
  const mint = await worstMint();
  try {
    let now = 1_000_000;
    const store = new MemoryStore(() => now);
    await lossRows(store, 6);
    now += AGE + 1;
    mint.set("refused");
    const a = await sweepMintQuotes(deps(store, { fetchImpl: mint.fetchImpl, tags: true }), { batch: 25, budgetMs: 24_000 });
    assert.equal(a.stop, "calls");
    const tried = a.scanned;
    // The cursor wraps; the ones tried in run 1 are now deferred and cost nothing.
    await store.setTag("f:mqsweep:cursor", "", 1);
    now += 2;
    mint.calls.length = 0;
    const b = await sweepMintQuotes(deps(store, { fetchImpl: mint.fetchImpl, tags: true }), { batch: 25, budgetMs: 24_000 });
    assert.equal(b.deferred, tried);
    assert.equal(b.scanned, 6, JSON.stringify(b));
    assert.ok(b.skipped >= 6 - tried, JSON.stringify(b));
  } finally {
    await mint.close();
  }
});

test("sweep backoff: a row held by a live request is skipped without a backoff mark", async () => {
  const { sweepMintQuotes } = needs("sweepMintQuotes", "SWEEP_BACKOFF_PREFIX");
  let now = 1_000_000;
  const store = new MemoryStore(() => now);
  assert.ok(await store.reserveMintQuote({ quote: "held", action: "write", amount: 10, mint: PUBLIC }));
  now += AGE + 1;
  assert.ok(await store.claimOpenMintQuote("held"), "a live presentation holds the lease");
  const fetchImpl: typeof fetch = async (input) => Response.json({ quote: "held", state: "ISSUED", amount: 10 });
  const s = await sweepMintQuotes(deps(store, { fetchImpl, mode: "loopback", tags: true }), { batch: 25, budgetMs: 24_000 });
  assert.equal(s.skipped, 1);
  assert.equal(await store.getTag("f:mqsb:held"), undefined);
});

test("sweep cursor: a tag set again lives its ttl from the last set", async () => {
  let now = 1_000_000;
  const store = new MemoryStore(() => now);
  await store.setTag("f:mqsweep:cursor", "a", 100);
  now += 90;
  await store.setTag("f:mqsweep:cursor", "b", 100);
  now += 90;
  assert.equal(await store.getTag("f:mqsweep:cursor"), "b", "refreshed on set");
  now += 11;
  assert.equal(await store.getTag("f:mqsweep:cursor"), undefined);
});

test("sweep mint fallback: a loss booked with mint '' stays a candidate and is minted on the configured mint", async () => {
  const { sweepMintQuotes } = needs("sweepMintQuotes", "SWEEP_MAX_CALLS");
  const mint = await ln.startKeysetMint({ quotes: true });
  try {
    const made = await (await fetch(mint.url + "/v1/mint/quote/bolt11", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: 10, unit: "sat" }) })).json() as { quote: string; request: string };
    const paid = await fetch(mint.url + "/test/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: made.request }) });
    assert.equal(paid.status, 200);
    await paid.arrayBuffer();
    let now = Date.now() / 1000;
    const store = new MemoryStore(() => now);
    await store.noteMintQuoteLoss({ quote: made.quote, action: "write", amount: 10, reason: "mint_refused", mint: "" });
    now += AGE + 1;
    const listed = await store.mintQuoteSweepCandidates({ after: "", limit: 10, minAgeS: AGE });
    assert.deepEqual(listed.map((c) => c.quote), [made.quote], "a '' loss is listed");
    const origin = new URL(mint.url).origin;
    const proxied: typeof fetch = (input, init) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return fetch(origin + u.pathname.slice(u.pathname.indexOf("/v1/")) + u.search, init);
    };
    const s = await sweepMintQuotes(deps(store, { fetchImpl: proxied }), { batch: 25, budgetMs: 24_000 });
    assert.equal(s.recovered, 1, JSON.stringify(s));
    assert.equal(s.reversedSats, 10);
    assert.deepEqual(store.mintQuoteLosses(), []);
  } finally {
    await mint.close();
  }
});

test("sweep reversals: an old open row with a young loss counts the loss its recovery reverses", async () => {
  const { sweepMintQuotes } = needs("sweepMintQuotes");
  let now = 1_000_000;
  const store = new MemoryStore(() => now);
  assert.ok(await store.reserveMintQuote({ quote: "open1", action: "write", amount: 10, mint: PUBLIC }));
  now += AGE + 31;
  await store.noteMintQuoteLoss({ quote: "open1", action: "write", amount: 10, reason: "mint_refused", mint: PUBLIC });
  const listed = await store.mintQuoteSweepCandidates({ after: "", limit: 10, minAgeS: AGE });
  assert.deepEqual(listed.map((c) => [c.quote, c.lost]), [["open1", 10]], "the open row carries its loss");
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (href.includes("/v1/mint/quote/bolt11/")) return Response.json({ quote: "open1", state: "ISSUED", amount: 10 });
    assert.equal((init?.method ?? "GET").toUpperCase(), "POST");
    return Response.json({ proofs: [{ amount: 10, id: "00ad268c4d1f5826", secret: "s1", C: "02" + "ab".repeat(32) }] });
  };
  const s = await sweepMintQuotes(deps(store, { fetchImpl, mode: "loopback" }), { batch: 25, budgetMs: 24_000 });
  assert.equal(s.recovered, 1, JSON.stringify(s));
  assert.equal(s.reversedSats, 10, "the reversed loss is counted");
  assert.deepEqual(store.mintQuoteLosses(), []);
});
