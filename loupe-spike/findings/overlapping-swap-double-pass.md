# Two offers that share an input both get a pass from one swap

- File: `packages/settlement-ln/src/cashu-receive.ts`
- Line: 189
- Also: `packages/settlement-ln/src/cashu-receive.ts:185` (a pending row is reused only when the mark sets are equal), `packages/settlement-ln/src/cashu-receive.ts:198` (the single-use keys are the caller's offer id and the caller's marks), `packages/settlement-ln/src/cashu-store.ts:165` and `packages/edge-cf/src/do-store.ts:209` (any shared mark returns the other row)
- Commit: `266c9a0d28e5583fa8fb8c917e6e4a793e82aa9a`
- Severity: high
- CWE: CWE-362

## Explanation

`verifyPaid` keeps a pending swap only when `sameMarks` says the input sets are equal. `begin` does not. `FileProofStore.begin` and `TollStoreDO.beginPending` return an existing row when any mark overlaps.

Two receives can both pass the empty snapshot, then both call `begin`. The second call is handed the first row. Both then `complete` that row and both pass `firstUse`: the offer ids differ, and the replay hash is taken from each caller's own marks (`cashu-receive.ts:199`), not from the pending row. One swap is stored. Two `Paid` results are returned, so the issuer mints two passes.

A run of the proof stored 8 from a single output set (`signed=8`, `stored=8`, `spent=1`) and granted both the search offer and the write offer. The extra 1-unit input on the write token was not spent. The same `begin` contract is on the Durable Object, so the edge receive path has the same shape. The test uses `FileProofStore` because that store loads under Node.

## Proof

`loupe-spike/tests/overlapping-swap-double-pass.test.ts` fails on this commit with `granted=2`. Five runs in a row failed the same way.
