# Loupe-style review of Toll

## Method

This spike follows Project Loupe's discovery prompt (Apache-2.0), from `crates/loupe-worker/src/llm/prompts.rs` at `496a8e99` in [github.com/project-loupe/loupe](https://github.com/project-loupe/loupe). The prompt is applied by hand, one file at a time. A candidate is reported only when a regression test fails on a clean checkout of the commit it targets. Candidates without that test are unproven leads. Severity stays conservative. No Loupe binary was installed, no paid model API was called, and the Loupe project was not contacted.

The verify prompt (second opinion, then an optional patch) was not run as a separate model. Each proof was re-run on a fresh worktree by `check.sh`, which is the stand-in for Loupe's `validate_poc`.

## Files reviewed

Payment, redeem and swap, the pending-row path, pass issuing, and the quote credential. Read on the seed commit `c8a7a8fa` and on main `266c9a0` where the file exists there.

- `packages/settlement-ln/src/mint-quote.ts` (seed only)
- `packages/settlement-ln/src/cashu-engine.ts`
- `packages/settlement-ln/src/cashu-receive.ts`
- `packages/settlement-ln/src/cashu-store.ts`
- `packages/settlement-ln/src/cashu.ts`
- `packages/settlement-ln/src/cashu-net.ts` (mint URL guard)
- `packages/settlement-ln/src/cashu-crypto.ts` (marks, fees, split)
- `packages/settlement-ln/src/test-mint.ts` and `keyset-mint.ts` (the local mints the proofs drive)
- `packages/settlement-ln/src/engine.ts`
- `packages/settlement-ln/src/rail.ts`
- `packages/settlement-ln/src/stub-engine.ts`
- `packages/settlement-ln/src/ledger.ts` (not a separate finding)
- `packages/protocol/src/pass.ts`
- `packages/protocol/src/classes.ts`
- `packages/server-node/src/stores.ts`
- `packages/server-node/src/toll.ts` (offer, redeem, pass mint)
- `packages/server-node/src/http.ts` (quote retry on the seed)
- `packages/edge-cf/src/do-store.ts` (pending rows, `beginPending`, alarm recovery)
- `packages/edge-cf/src/kv-store.ts`
- `packages/edge-cf/src/worker.ts`
- `packages/edge-cf/src/handler.ts` (pass check, presented token, redeem)
- `packages/edge-cf/src/site.ts` (the site worker uses the Durable Object store)

## Seed result

The task text named the forged-pass bug before the read, so this was not a blind trial. The file read still had to find the mechanism. It is in `verifyMintQuote`: state `PAID` or `ISSUED` is accepted, the mint hands the proofs back, `hold()` stores them in a process-local `Map`, and `firstUse` is a later call. No Durable Object proof row is written.

The test then shows the outcome: after another caller mints the quote and spends the proofs, `redeemQuoted` still returns a pass (`redeem_ok`, class `write`). That matches the task's description.

Compared with the later commit `cfeb81e` ("Refuse a quote this store did not mint"): that tree refuses mint state `ISSUED` when the store has no row, and it writes the proofs and the single-use mark in one `claim`. Re-running this spike's test on that commit does not reach `redeemQuoted`, because that tree did not return a quote offer for this config. The seed failure itself is the pass being minted. `hold()` and `firstUse()` are separate calls; a second in-process `firstUse` race was not proven, because `MemoryStore` does not await between its check and its set.

## Findings

| Id | Commit | Severity | Test |
| --- | --- | --- | --- |
| forged-quote-pass | `c8a7a8fa` | high | `tests/forged-quote-pass.test.ts` |
| overlapping-swap-double-pass | `266c9a0` | high | `tests/overlapping-swap-double-pass.test.ts` |
| kv-replay-race | `266c9a0` | medium | `tests/kv-replay-race.test.ts` |

Details are in `findings/`. Main was `266c9a0` at review time. The overlap bug is on the receive path that main ships. The quote bug is only on the seed commit; main does not contain `mint-quote.ts`.

## Unproven leads

- A crash after `commit` and before `firstUse` in `cashu-receive.ts` (around lines 194–200) would leave the inputs spent and the retry refused. There is no hook between those lines, so there is no failing test.
- `recoverSaved` can abort another request's pending row when restore is empty and every input is unspent. The double-pass test takes the other interleaving. This one was not isolated.
- Two processes with two `MemoryStore`s can both redeem one quote. `stores.ts` already says that store is for the demo and tests. Not reported as its own finding.
- `POST /v1/redeem` on the edge accepts a client-supplied payment body. The class comes from the sealed credential. No test showed a class upgrade.
- KV lag across locations is already commented in `kv-store.ts`. The reported bug is the check-then-act on a store that applies writes immediately.

## False-positive rate

0 of 3 reported findings. Each test fails on an assertion that is the claimed outcome: a pass is minted, two receives are granted for one stored swap, and both KV callers win. No reported finding was withdrawn after the test ran. The two-process `MemoryStore` idea was considered and not reported.

## Checklist

- Hyrum: each finding pins an observable (pass minted, two `Paid` results, two KV winners) with a test that names the caller (`redeemQuoted`, `verifyPaid`, `KVStore`).
- Demeter: the tests call the issuer, the receive engine, or the store. They do not reach through a nested collaborator past that.
- Lehman: no production code was added. The spike is tests and notes.
- Conway: the notes stay in this repo. No change was opened on another product.
- Linus: `check.sh` re-runs the tests on a fresh worktree. It is not the author of the production code.
- 90-90: the tests are the replay, the overlap, and the already-spent quote, not the happy path.
- Brooks: one review pass. No extra agents.
- Craftsmanship: behavior of `src/` is unchanged. Tests that cannot fail on the target commit were not reported. No skipped test, no new lint suppression.

## Verdict

Worth one repeat on Ecashu's pay and redeem path, with the same rule: a note without a failing test is not a finding. Not worth running Loupe's worker, a paid model, or automatic issues.

The seed result is not evidence that the method finds unknown bugs. The task named that bug first. The two main findings are the evidence. The overlap is a real second pass on the receive path, and the existing conservation tests do not race two tokens that share an input. The KV bug is real on `KVStore` and is stronger than the comment there: it shows up against a store that applies each write immediately. The site worker's Durable Object store does not use that class. A repeat on Ecashu should stay on the code that actually moves a payment, and should drop anything that cannot fail a test.
