// The mint-quote sweep on Node: retries stored quotes no client will present again. The mint is local; nothing is paid.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ln from "../packages/settlement-ln/src/index.ts";
import { RECHECK_BASE_S, mintQuoteRechecks, startKeysetMint } from "../packages/settlement-ln/src/index.ts";
import { MemoryStore } from "../packages/server-node/src/stores.ts";
import { startDemo } from "./helpers.ts";

const PUBLIC = "https://pay.example.com/Bitcoin";
const OTHER = "https://other.example.com/Bitcoin";

/** The sweep's exports, read when used: on a base without them a test fails on this assertion, not at import. */
function needs<K extends keyof typeof ln>(...names: K[]): Pick<typeof ln, K> {
  for (const n of names) assert.notEqual(ln[n], undefined, `settlement-ln exports ${String(n)}`);
  return ln;
}
const SWEEP_MIN_AGE_S = 120;

const saved = process.env.L402_ENABLED;
after(() => {
  if (saved === undefined) delete process.env.L402_ENABLED;
  else process.env.L402_ENABLED = saved;
});

/** The allowlisted mint host is proxied to the local mint. `skew` moves only the store's clock. */
async function boot() {
  const mint = await startKeysetMint({ quotes: true });
  process.env.L402_ENABLED = "1";
  const clock = { now: Math.floor(Date.now() / 1000), skew: 0 };
  const proxied: typeof fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(href);
    const i = u.pathname.indexOf("/v1/");
    return fetch(new URL(mint.url).origin + (i >= 0 ? u.pathname.slice(i) : u.pathname) + u.search, init);
  };
  const dir = mkdtempSync(join(tmpdir(), "toll-sweep-"));
  const demo = await startDemo({
    work: { standard: { cost: 500 } },
    settlement: { enabled: true, backend: "stub", fee_bps: 1000, fx: { source: "none" }, cashu: { enabled: true, mints: [PUBLIC], store: join(dir, "proofs.json") } },
  }, { now: () => clock.now, storeNow: () => Date.now() / 1000 + clock.skew, settlement: { mintGuard: { lookup: async () => ["1.1.1.1"], fetch: proxied } } });
  const close = async () => { delete process.env.L402_ENABLED; await demo.close(); await mint.close(); };
  const toll = demo.demo.toll;
  const sweep = (batch = 25, budgetMs = 10_000) => {
    assert.equal(typeof toll.sweepMintQuotes, "function", "the toll exposes sweepMintQuotes");
    return toll.sweepMintQuotes({ batch, budgetMs });
  };
  return { mint, demo, clock, close, sweep, store: demo.store };
}
type Env = Awaited<ReturnType<typeof boot>>;

function agentHeaders(extra: Record<string, string> = {}) {
  return { accept: "application/json", "content-type": "application/json", "toll-client": "agent", ...extra };
}

async function quoteState(env: Env, quote: string): Promise<string> {
  return ((await (await fetch(env.mint.url + "/v1/mint/quote/bolt11/" + quote)).json()) as { state: string }).state;
}

/** A quote paid at the mint that this store never minted. */
async function paidAtMint(env: Env, amount = 10): Promise<string> {
  const made = await (await fetch(env.mint.url + "/v1/mint/quote/bolt11", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount, unit: "sat" }) })).json() as { quote: string; request: string };
  const paid = await fetch(env.mint.url + "/test/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: made.request }) });
  assert.equal(paid.status, 200);
  await paid.arrayBuffer();
  return made.quote;
}

/** A paid quote the mint refused at the cap: booked as a loss, no row. */
async function refusedLoss(env: Env, mint = PUBLIC): Promise<string> {
  const quote = await paidAtMint(env);
  await env.store.noteMintQuoteLoss({ quote, action: "write", amount: 10, reason: "mint_refused", mint });
  return quote;
}

/** QA's #41 sequence: both mint posts time out, the client gets 503, and the mint signs afterwards. The row stays open. */
async function openRow(env: Env): Promise<string> {
  const denied = await fetch(env.demo.url + "/contact", { method: "POST", headers: agentHeaders(), body: "{}" });
  await denied.json();
  const m = /^L402 macaroon="([^"]+)", invoice="([^"]+)"$/.exec(denied.headers.get("www-authenticate") ?? "");
  assert.ok(m);
  const paid = await fetch(env.mint.url + "/test/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: m[2] }) });
  const preimage = ((await paid.json()) as { preimage: string }).preimage;
  const quote = JSON.parse(Buffer.from(m[1].split(".")[0], "base64url").toString()).quote as string;
  const first = env.mint.holdNextMint();
  const pending = fetch(env.demo.url + "/contact", { method: "POST", headers: agentHeaders({ authorization: `L402 ${m[1]}:${preimage}` }), body: "{}" });
  const a = await first;
  const second = env.mint.holdNextMint();
  const b = await second;
  const res = await pending;
  assert.equal(res.status, 503);
  await res.body?.cancel();
  a.release();
  b.release();
  for (let i = 0; i < 100 && (await quoteState(env, quote)) !== "ISSUED"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(await quoteState(env, quote), "ISSUED");
  return quote;
}

function booked(env: Env, quote: string) {
  const stored = (env.store.mintQuoteStored?.() ?? []).filter((o) => o.quote === quote).reduce((n, o) => n + o.amount, 0);
  const lost = (env.store.mintQuoteLosses?.() ?? []).filter((o) => o.quote === quote).reduce((n, o) => n + o.amount, 0);
  return { stored, lost };
}

async function reversals(env: Env) {
  const s = await (await fetch(env.demo.url + "/demo/stats")).json();
  return { reversals: s.reversals, reversed_sats: s.reversed_sats };
}

const NONE = { scanned: 0, recovered: 0, reversedSats: 0, skipped: 0, stoppedEarly: false };

test("sweep recovery: an open reservation is restored and a refused loss is minted and reversed, once each", async () => {
  const env = await boot();
  try {
    const open = await openRow(env);
    const lost = await refusedLoss(env);
    assert.deepEqual(booked(env, open), { stored: 0, lost: 0 });
    assert.deepEqual(booked(env, lost), { stored: 0, lost: 10 });
    assert.deepEqual(await env.sweep(), NONE, "rows younger than the longest macaroon are left to their clients");
    env.clock.skew += SWEEP_MIN_AGE_S + 1;
    assert.deepEqual(await env.sweep(), { scanned: 2, recovered: 2, reversedSats: 10, skipped: 0, stoppedEarly: false });
    assert.deepEqual(booked(env, open), { stored: 10, lost: 0 });
    assert.deepEqual(booked(env, lost), { stored: 10, lost: 0 }, "the loss is reversed by the proofs that recover it");
    assert.equal(await quoteState(env, lost), "ISSUED");
    assert.deepEqual(await reversals(env), { reversals: 1, reversed_sats: 10 });
    assert.ok(env.demo.events.some((e) => e.event === "mint_quote_sweep" && e.recovered === 2 && e.reversedSats === 10));
  } finally {
    await env.close();
  }
});

test("sweep rerun: a second and a concurrent pass book nothing twice", async () => {
  const env = await boot();
  try {
    const lost = await refusedLoss(env);
    const open = await openRow(env);
    env.clock.skew += SWEEP_MIN_AGE_S + 1;
    const [a, b] = await Promise.all([env.sweep(), env.sweep()]);
    assert.equal(a.recovered + b.recovered, 2, `${JSON.stringify(a)} ${JSON.stringify(b)}`);
    assert.equal(a.reversedSats + b.reversedSats, 10);
    const posts = env.mint.mintPosts();
    assert.deepEqual(await env.sweep(), NONE, "recovered quotes are no longer candidates");
    assert.equal(env.mint.mintPosts(), posts);
    assert.deepEqual(booked(env, lost), { stored: 10, lost: 0 });
    assert.deepEqual(booked(env, open), { stored: 10, lost: 0 });
    assert.deepEqual(await reversals(env), { reversals: 1, reversed_sats: 10 }, "one reversal across both passes");
  } finally {
    await env.close();
  }
});

test("sweep nothing recoverable: issued_no_row, unknown-mint and other-mint losses and a mint that still refuses are left as booked", async () => {
  const env = await boot();
  try {
    assert.deepEqual(await env.sweep(), NONE, "an empty store");
    const issued = await paidAtMint(env);
    await env.store.noteMintQuoteLoss({ quote: issued, action: "write", amount: 10, reason: "issued_no_row", mint: PUBLIC });
    const bare = await refusedLoss(env, "");
    const other = await refusedLoss(env, OTHER);
    env.clock.skew += SWEEP_MIN_AGE_S + 1;
    const requests = env.mint.requests();
    assert.deepEqual(await env.sweep(), { scanned: 1, recovered: 0, reversedSats: 0, skipped: 1, stoppedEarly: false }, "only the other-mint loss is a candidate");
    assert.equal(env.mint.requests(), requests, "a quote on another mint is not sent to this one");
    const refusing = await refusedLoss(env);
    env.clock.skew += SWEEP_MIN_AGE_S + 1;
    env.mint.failNextMints(1000);
    const posts = env.mint.mintPosts();
    assert.deepEqual(await env.sweep(), { scanned: 2, recovered: 0, reversedSats: 0, skipped: 2, stoppedEarly: false });
    assert.ok(env.mint.mintPosts() > posts, "the refused quote was tried");
    for (const q of [issued, bare, other, refusing]) assert.deepEqual(booked(env, q), { stored: 0, lost: 10 }, q);
    assert.equal(env.store.mintQuoteLossRows().length, 4, "no loss booked twice");
    assert.deepEqual(await reversals(env), { reversals: 0, reversed_sats: 0 });
  } finally {
    env.mint.failNextMints(0);
    await env.close();
  }
});

test("sweep backoff: a capped quote is minted only when its re-check window opens", async () => {
  const env = await boot();
  try {
    const quote = await refusedLoss(env);
    await mintQuoteRechecks(env.store).arm(quote);
    env.clock.skew += SWEEP_MIN_AGE_S - RECHECK_BASE_S + 1;
    const posts = env.mint.mintPosts();
    assert.deepEqual(await env.sweep(), NONE, "still too young");
    env.clock.skew += RECHECK_BASE_S - 2;
    // Old enough to sweep, but the first window opens RECHECK_BASE_S after the cap: a second later.
    assert.equal((await env.sweep()).scanned, 0);
    env.clock.skew += 1;
    assert.equal((await env.sweep()).recovered, 1);
    assert.equal(env.mint.mintPosts(), posts + 1);
    assert.deepEqual(booked(env, quote), { stored: 10, lost: 0 });
  } finally {
    await env.close();
  }
});

test("sweep batch limit: a run takes up at most `batch` items, and the next run starts after them and wraps", async () => {
  const env = await boot();
  try {
    // Quotes on another mint are skipped without a mint call, so they stay candidates across runs.
    const quotes: string[] = [];
    for (let i = 0; i < 3; i++) quotes.push(await refusedLoss(env, OTHER));
    env.clock.skew += SWEEP_MIN_AGE_S + 1;
    quotes.sort();
    const seen: string[] = [];
    const cursor = async () => (await env.store.getTag("f:mqsweep:cursor")) ?? "";
    for (let run = 0; run < 3; run++) {
      const s = await env.sweep(2);
      assert.equal(s.scanned, 2, `run ${run}: ${JSON.stringify(s)}`);
      assert.equal(s.stoppedEarly, false);
      seen.push(await cursor());
    }
    assert.deepEqual(seen, [quotes[1], quotes[0], quotes[2]], "runs continue after the cursor and wrap to the start");
    const paid: string[] = [];
    for (let i = 0; i < 5; i++) paid.push(await refusedLoss(env));
    env.clock.skew += SWEEP_MIN_AGE_S + 1;
    let recovered = 0;
    for (let run = 0; run < 4; run++) recovered += (await env.sweep(2)).recovered;
    assert.equal(recovered, 5);
    for (const q of paid) assert.deepEqual(booked(env, q), { stored: 10, lost: 0 }, q);
  } finally {
    await env.close();
  }
});

test("sweep budget stop: a spent budget takes up no further item", async () => {
  const env = await boot();
  try {
    const quote = await refusedLoss(env);
    env.clock.skew += SWEEP_MIN_AGE_S + 1;
    const posts = env.mint.mintPosts();
    assert.deepEqual(await env.sweep(25, 0), { scanned: 0, recovered: 0, reversedSats: 0, skipped: 0, stoppedEarly: true });
    assert.equal(env.mint.mintPosts(), posts);
    assert.deepEqual(booked(env, quote), { stored: 0, lost: 10 });
    assert.deepEqual(await env.sweep(25, 10_000), { scanned: 1, recovered: 1, reversedSats: 10, skipped: 0, stoppedEarly: false });
  } finally {
    await env.close();
  }
});

test("sweep budget stop: the budget is checked before each item on the sweep's own clock", async () => {
  const { sweepMintQuotes } = needs("sweepMintQuotes");
  assert.equal(ln.SWEEP_MIN_AGE_S, SWEEP_MIN_AGE_S, "the sweep leaves rows younger than the longest macaroon");
  const store = new MemoryStore(() => 1_000_000);
  for (const q of ["q1", "q2", "q3", "q4"]) await store.noteMintQuoteLoss({ quote: q, action: "write", amount: 10, reason: "mint_refused", mint: OTHER });
  let t = 0;
  const unexpected = () => Promise.reject(new Error("no store write expected"));
  const s = await sweepMintQuotes({
    mint: PUBLIC, fetchImpl: () => Promise.reject(new Error("no mint call expected")),
    has: unexpected, reserve: unexpected, claimOpen: unexpected, release: unexpected, unlock: unexpected, finish: unexpected, noteLoss: unexpected,
    candidates: async (q) => {
      assert.equal(typeof store.mintQuoteSweepCandidates, "function", "the Node store lists sweep candidates");
      return store.mintQuoteSweepCandidates({ ...q, minAgeS: 0 });
    },
    cursor: { get: async () => undefined, set: async () => {} },
    // Each reading is 40 ms after the last: items start at 40 and 80, and 120 is past the 100 ms budget.
    clock: () => (t += 40) - 40,
  }, { batch: 25, budgetMs: 100 });
  assert.deepEqual(s, { scanned: 2, recovered: 0, reversedSats: 0, skipped: 2, stoppedEarly: true });
  await assert.rejects(sweepMintQuotes({
    mint: PUBLIC, has: unexpected, reserve: unexpected, claimOpen: unexpected, release: unexpected, unlock: unexpected, finish: unexpected, noteLoss: unexpected,
    candidates: async () => [], cursor: { get: async () => undefined, set: async () => {} }, clock: () => 0,
  }, { batch: 0, budgetMs: 100 }), { code: "malformed" });
});

test("sweep lease: a row a live request holds is skipped, then recovered once the lease lapses", async () => {
  const env = await boot();
  try {
    const quote = await openRow(env);
    env.clock.skew += SWEEP_MIN_AGE_S + 1;
    // A live presentation of the same quote claims the open row and holds its 30 s lease.
    assert.ok(await env.store.claimOpenMintQuote(quote));
    const requests = env.mint.requests();
    assert.deepEqual(await env.sweep(), { scanned: 1, recovered: 0, reversedSats: 0, skipped: 1, stoppedEarly: false });
    assert.equal(env.mint.requests(), requests + 1, "only the quote state is read; no restore or mint while the lease is held");
    assert.deepEqual(booked(env, quote), { stored: 0, lost: 0 });
    env.clock.skew += 31;
    assert.equal((await env.sweep()).recovered, 1);
    assert.deepEqual(booked(env, quote), { stored: 10, lost: 0 });
  } finally {
    await env.close();
  }
});
