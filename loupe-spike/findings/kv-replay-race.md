# KV replay and pass spends are check-then-act

- File: `packages/edge-cf/src/kv-store.ts`
- Line: 32
- Also: `packages/edge-cf/src/kv-store.ts:39` (`consume`)
- Commit: `266c9a0d28e5583fa8fb8c917e6e4a793e82aa9a`
- Severity: medium
- CWE: CWE-362

## Explanation

`firstUse` reads `f:<key>` and, on a miss, writes it. `consume` reads `n:<key>` and writes the decremented count. Each `await` is between the read and the write. Two callers can both observe the missing key, and both are told they won.

The site worker uses the Durable Object store, which runs each call in one object. `worker.ts` still uses `KVStore` when `TOLL_KV` is bound. The comment on `kv-store.ts` warns that KV is eventually consistent across locations. This failure is narrower: the mock KV in the test applies each write immediately, and both callers still succeed. A one-use pass is spent twice (`consume` returns `0` and `0`). A payment `firstUse` returns `true` twice.

## Proof

`loupe-spike/tests/kv-replay-race.test.ts` fails on this commit. Both tests assert a single winner and both see two.
