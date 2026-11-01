# A quote another wallet already minted still mints a pass

- File: `packages/settlement-ln/src/mint-quote.ts`
- Line: 123
- Also: `packages/settlement-ln/src/mint-quote.ts:132` (`hold`), `packages/settlement-ln/src/mint-quote.ts:136` (`firstUse`), `packages/settlement-ln/src/cashu-engine.ts:73` (process-local `Map`)
- Commit: `c8a7a8fa605fb7409005062eaf375de091edec17`
- Severity: high
- CWE: CWE-840

## Explanation

`verifyMintQuote` treats mint state `PAID` or `ISSUED` as payment. It then `POST`s `/v1/mint/bolt11` with only the quote id. The loopback mint returns the same proofs to every caller, including a caller who already minted them. Those proofs are saved with `hold()` into `CashuTestEngine`'s process-local `Map`. `firstUse` runs afterwards, as a separate call, on whatever store the issuer passed in. On this tree that store is `MemoryStore`. Nothing writes a Durable Object proof row.

A second caller can pay the invoice, mint the proofs, and spend them. The original retry still gets a pass: `redeemQuoted` returns one, and the issuer logs `redeem_ok` for class `write`. The single-use mark and the proofs are not one store write, so `ISSUED` with no row is enough.

This is the loopback test engine. It does not run on the https receive path.

## Proof

`loupe-spike/tests/forged-quote-pass.test.ts` fails on this commit because `redeemQuoted` resolves after the other caller has spent the proofs.
