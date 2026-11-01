// The edge store's SQL, run in Node: the loss-table migration on a restart and the net-loss clamp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { doStorage } from "./do-harness.ts";

const PROOF = { amount: 10, secret: "s1", id: "00ad268c4d1f5826", C: "02" + "ab".repeat(32) };

test("edge store migration: a restart on an already migrated store is a no-op", () => {
  const s = doStorage();
  s.db.exec("CREATE TABLE cashu_mint_loss (quote TEXT PRIMARY KEY, action TEXT NOT NULL, amount INTEGER NOT NULL)");
  s.db.exec("INSERT INTO cashu_mint_loss (quote, action, amount) VALUES ('old', 'write', 7)");
  s.open();
  assert.deepEqual(s.columns("cashu_mint_loss"), ["quote", "action", "amount", "reason", "recovered"]);
  assert.doesNotThrow(() => s.open(), "the second start finds the columns and adds nothing");
  assert.doesNotThrow(() => s.open());
  assert.deepEqual(s.columns("cashu_mint_loss"), ["quote", "action", "amount", "reason", "recovered"]);
  assert.deepEqual(s.db.prepare("SELECT quote, amount, reason, recovered FROM cashu_mint_loss").all().map((r) => ({ ...r })), [{ quote: "old", amount: 7, reason: "", recovered: 0 }]);
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
