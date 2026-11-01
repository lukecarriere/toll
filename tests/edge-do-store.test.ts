// The edge store's SQL, run in Node: the loss-table migration on a restart, the net-loss clamp and the reversal counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { doStorage } from "./do-harness.ts";
import { startSweepStubMint } from "./sweep-stub-mint.ts";

const PROOF = { amount: 10, secret: "s1", id: "00ad268c4d1f5826", C: "02" + "ab".repeat(32) };

test("edge store migration: a restart on an already migrated store is a no-op", () => {
  const s = doStorage();
  s.db.exec("CREATE TABLE cashu_mint_loss (quote TEXT PRIMARY KEY, action TEXT NOT NULL, amount INTEGER NOT NULL)");
  s.db.exec("INSERT INTO cashu_mint_loss (quote, action, amount) VALUES ('old', 'write', 7)");
  s.open();
  assert.deepEqual(s.columns("cashu_mint_loss"), ["quote", "action", "amount", "reason", "recovered", "mint", "at"]);
  assert.doesNotThrow(() => s.open(), "the second start finds the columns and adds nothing");
  assert.doesNotThrow(() => s.open());
  assert.deepEqual(s.columns("cashu_mint_loss"), ["quote", "action", "amount", "reason", "recovered", "mint", "at"]);
  assert.deepEqual(s.db.prepare("SELECT quote, amount, reason, recovered FROM cashu_mint_loss").all().map((r) => ({ ...r })), [{ quote: "old", amount: 7, reason: "", recovered: 0 }]);
});

test("edge store migration: the loss mint column is added once to a #43 table, old rows read '', new rows record the mint", () => {
  const s = doStorage();
  s.db.exec("CREATE TABLE cashu_mint_loss (quote TEXT PRIMARY KEY, action TEXT NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', recovered INTEGER NOT NULL DEFAULT 0)");
  s.db.exec("INSERT INTO cashu_mint_loss (quote, action, amount, reason, recovered) VALUES ('old', 'write', 7, 'mint_refused', 0)");
  s.open();
  assert.doesNotThrow(() => s.open(), "a second start finds the mint column and adds nothing");
  assert.deepEqual(s.columns("cashu_mint_loss"), ["quote", "action", "amount", "reason", "recovered", "mint", "at"]);
  const store = s.open();
  store.noteMintQuoteLoss({ quote: "new", action: "write", amount: 10, reason: "mint_refused", mint: "https://mint.test" });
  store.noteMintQuoteLoss({ quote: "bare", action: "write", amount: 3, reason: "unrecoverable" });
  store.noteMintQuoteLoss({ quote: "new", action: "write", amount: 10, reason: "mint_refused", mint: "https://other.test" });
  assert.deepEqual(s.db.prepare("SELECT quote, amount, reason, recovered, mint FROM cashu_mint_loss ORDER BY quote").all().map((r) => ({ ...r })), [
    { quote: "bare", amount: 3, reason: "unrecoverable", recovered: 0, mint: "" },
    { quote: "new", amount: 10, reason: "mint_refused", recovered: 0, mint: "https://mint.test" },
    { quote: "old", amount: 7, reason: "mint_refused", recovered: 0, mint: "" },
  ]);
  assert.equal(store.cashuBooks().losses, 13, "each new loss is booked once");
});

test("edge store reversal: net losses never go below zero", () => {
  const s = doStorage();
  const store = s.open();
  store.noteMintQuoteLoss({ quote: "q1", action: "write", amount: 10, reason: "mint_refused" });
  // A hand-repaired books row: the operator already wrote part of this loss off.
  s.db.exec("UPDATE cashu_meta SET n = 4 WHERE k = 'losses'");
  assert.equal(store.reserveMintQuote({ quote: "q1", action: "write", amount: 10, mint: "https://mint.test" }), true);
  assert.equal(store.finishMintQuote({ quote: "q1", proofs: [PROOF] }), true);
  assert.equal(store.cashuBooks().losses, 0);
  assert.equal(store.cashuBooks().stored, 10);
});

test("edge store stats: a reversal counts once, with its sats, and survives a restart", () => {
  const s = doStorage();
  const store = s.open();
  const reversed = () => { const c = s.open().counts(); return { reversals: c.reversals, reversed_sats: c.reversed_sats }; };
  assert.deepEqual(reversed(), { reversals: 0, reversed_sats: 0 });
  // Proofs stored with no booked loss reverse nothing.
  assert.equal(store.claimMintQuote({ quote: "q0", action: "write", amount: 5, mint: "https://mint.test", proofs: [{ ...PROOF, amount: 5, secret: "s0" }] }), true);
  assert.deepEqual(reversed(), { reversals: 0, reversed_sats: 0 });
  store.noteMintQuoteLoss({ quote: "q1", action: "write", amount: 10, reason: "mint_refused" });
  assert.equal(store.reserveMintQuote({ quote: "q1", action: "write", amount: 10, mint: "https://mint.test" }), true);
  assert.equal(store.finishMintQuote({ quote: "q1", proofs: [PROOF] }), true);
  assert.deepEqual(reversed(), { reversals: 1, reversed_sats: 10 });
  assert.equal(store.finishMintQuote({ quote: "q1", proofs: [PROOF] }), false, "a second finish stores nothing");
  assert.deepEqual(reversed(), { reversals: 1, reversed_sats: 10 }, "and counts nothing");
  assert.equal(store.counts().accepted, 0, "the day counts are unchanged");
});

test("edge store migration: the at columns are added once to a #45 store, and old rows read 0", () => {
  const s = doStorage();
  s.db.exec("CREATE TABLE cashu_mint_quote (quote TEXT PRIMARY KEY, action TEXT NOT NULL, amount INTEGER NOT NULL, mint TEXT NOT NULL, proofs TEXT NOT NULL, outputs TEXT NOT NULL DEFAULT '[]')");
  s.db.exec("CREATE TABLE cashu_mint_loss (quote TEXT PRIMARY KEY, action TEXT NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', recovered INTEGER NOT NULL DEFAULT 0, mint TEXT NOT NULL DEFAULT '')");
  s.db.exec("INSERT INTO cashu_mint_quote (quote, action, amount, mint, proofs) VALUES ('oldq', 'write', 7, 'https://mint.test', '[]')");
  s.db.exec("INSERT INTO cashu_mint_loss (quote, action, amount, reason) VALUES ('oldl', 'write', 7, 'mint_refused')");
  s.open();
  assert.doesNotThrow(() => s.open(), "a second start finds the at columns and adds nothing");
  assert.deepEqual(s.columns("cashu_mint_quote"), ["quote", "action", "amount", "mint", "proofs", "outputs", "at"]);
  assert.deepEqual(s.columns("cashu_mint_loss"), ["quote", "action", "amount", "reason", "recovered", "mint", "at"]);
  assert.deepEqual(s.db.prepare("SELECT at FROM cashu_mint_quote UNION ALL SELECT at FROM cashu_mint_loss").all().map((r) => r.at), [0, 0]);
  const store = s.open();
  const t0 = Math.floor(Date.now() / 1000);
  assert.equal(store.reserveMintQuote({ quote: "newq", action: "write", amount: 10, mint: "https://mint.test" }), true);
  store.noteMintQuoteLoss({ quote: "newl", action: "write", amount: 10, reason: "mint_refused" });
  for (const r of s.db.prepare("SELECT at FROM cashu_mint_quote WHERE quote = 'newq' UNION ALL SELECT at FROM cashu_mint_loss WHERE quote = 'newl'").all()) {
    assert.ok(Number(r.at) >= t0 && Number(r.at) <= t0 + 2, "new rows record when they were written");
  }
  // Old rows (at 0) are old enough for the sweep.
  assert.deepEqual(store.mintQuoteSweepCandidates({ after: "", limit: 10, minAgeS: 120 }).map((c) => c.quote), ["oldl", "oldq"]);
});

test("edge store sweep listing: old open rows with their loss, old bare losses, and nothing else, in quote order", () => {
  const s = doStorage();
  const store = s.open();
  const age = (table: string, quote: string, ageS: number) => s.db.prepare(`UPDATE ${table} SET at = ? WHERE quote = ?`).run(Math.floor(Date.now() / 1000) - ageS, quote);
  const M = "https://mint.test";
  // a: open, old, its loss young -> listed with the loss.
  store.reserveMintQuote({ quote: "a", action: "write", amount: 10, mint: M });
  age("cashu_mint_quote", "a", 300);
  store.noteMintQuoteLoss({ quote: "a", action: "write", amount: 10, reason: "mint_refused", mint: M });
  // b: open but young -> not listed, even with an old loss.
  store.reserveMintQuote({ quote: "b", action: "write", amount: 4, mint: M });
  store.noteMintQuoteLoss({ quote: "b", action: "write", amount: 4, reason: "mint_refused", mint: M });
  age("cashu_mint_loss", "b", 300);
  // c: bare loss with mint '' and old -> listed. d: bare loss but young -> not.
  store.noteMintQuoteLoss({ quote: "c", action: "write", amount: 3, reason: "unrecoverable" });
  age("cashu_mint_loss", "c", 300);
  store.noteMintQuoteLoss({ quote: "d", action: "write", amount: 3, reason: "mint_refused", mint: M });
  // e: issued_no_row -> never. f: recovered -> never. g: stored proofs -> never.
  store.noteMintQuoteLoss({ quote: "e", action: "write", amount: 3, reason: "issued_no_row", mint: M });
  age("cashu_mint_loss", "e", 300);
  store.noteMintQuoteLoss({ quote: "f", action: "write", amount: 3, reason: "mint_refused", mint: M });
  s.db.exec("UPDATE cashu_mint_loss SET recovered = 1 WHERE quote = 'f'");
  age("cashu_mint_loss", "f", 300);
  store.claimMintQuote({ quote: "g", action: "write", amount: 10, mint: M, proofs: [PROOF] });
  age("cashu_mint_quote", "g", 300);
  const list = (after: string, limit: number) => store.mintQuoteSweepCandidates({ after, limit, minAgeS: 120 }).map((c) => [c.quote, c.mint, c.lost]);
  assert.deepEqual(list("", 10), [["a", M, 10], ["c", "", 3]]);
  assert.deepEqual(list("a", 10), [["c", "", 3]]);
  assert.deepEqual(list("", 1), [["a", M, 10]]);
});

test("edge store sweep: a worst-case mint is held to the call cap, and the losses stay booked", async () => {
  const mint = await startSweepStubMint();
  try {
    const s = doStorage();
    // An https mint name, as configured; test hooks route its calls to the local stub.
    const MINT = "https://mint.toll.test/Bitcoin";
    const env = { CASHU_MINTS: JSON.stringify([MINT]), CASHU_FETCH_PROXY: mint.url, TOLL_TEST_HOOKS: "1", L402_ENABLED: "1" };
    const store = s.open(env);
    mint.set("refused");
    for (let i = 0; i < 12; i++) {
      assert.deepEqual(await store.mintQuoteSeed({ quote: "q" + i, action: "write", amount: 10, mint: i % 2 ? "" : MINT, ageS: 300, loss: "mint_refused" }), { ok: true });
    }
    const booked = store.cashuBooks().losses;
    const first = await store.mintQuoteSweep({});
    assert.equal(first.calls, mint.calls.length, "every counted call reached the mint");
    assert.ok(first.calls <= 40);
    assert.equal(first.stop, "calls");
    // Bare refused losses cost 6 calls each (8 with the keys); a 6th would pass the 40-call cap at its worst.
    assert.deepEqual({ scanned: first.scanned, skipped: first.skipped, calls: first.calls }, { scanned: 5, skipped: 5, calls: 32 }, JSON.stringify(first));
    assert.equal(mint.calls.filter((c) => c.endsWith("/v1/keysets")).length, 1);
    assert.equal(store.cashuBooks().losses, booked);
    // Without hooks the seed writes nothing.
    assert.deepEqual(await s.open({ CASHU_MINTS: JSON.stringify([MINT]) }).mintQuoteSeed({ quote: "x", action: "write", amount: 1, mint: "", ageS: 0, loss: "mint_refused" }), { ok: false });
    // No mint or no mode: an empty summary and no calls.
    mint.calls.length = 0;
    assert.equal((await s.open({}).mintQuoteSweep({})).scanned, 0);
    assert.equal(mint.calls.length, 0);
  } finally {
    await mint.close();
  }
});
