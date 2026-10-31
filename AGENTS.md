# Agent instructions

- Run `npm test` before finishing a change. It builds, typechecks, runs the copy lint, the Cashu guards, and the hidden-attribute check, and runs the Node and PHP tests.
- Verify a checkout with `.cursor/skills/verify/SKILL.md`. pstack skills are vendored under `.cursor/skills/` (MIT, Lauren Tan). The reasoning budget is low. Skip `/swarm` and `/arena` unless a design is contested.
- The copy lint keeps vendor names off public surfaces. Public strings come from `docs/copy.md`. Vendor names may appear only in `docs/adapters.md`, in package pins, and in the bundled licence notices.
- Phase 4 stays locked. Settlement is test-only: the stub backend, no real money, and no live payouts.
- Never deploy, publish, change DNS, or change repository visibility.

## Rules and enforcers

| Rule | Enforcer |
| --- | --- |
| Public copy stays on the lint list. Vendor names stay in `docs/adapters.md`, package pins, and licence notices. | `npm run lint:copy` |
| Commit titles after `fa12195` are linted, so CI fetches full history. | `.github/workflows/ci.yml` `fetch-depth: 0` |
| Dotted hosts outside the allow list fail. | `tests/no-hardcoded-domains.test.ts` |
| Node packages are MIT. The plugin and the PHP library are GPL-2.0-or-later. | `tests/licence.test.ts` |
| Page meta descriptions, including legal pages, come from `docs/copy.md`. | `tests/meta-descriptions.test.ts` |
| Every built public page stays within a 360 and 390 phone width. | `tests/viewport.test.ts`, `tests/viewport-coverage.test.ts` |
| Plugin display name is Toll Gate. The header and the copy display name do not contain WordPress. | `scripts/plugin-name.mjs` in `scripts/build-wp-zip.mjs`, `tests/plugin-name.test.ts` |
| A challenge shape error does not echo the caller field name. | `tests/error-detail.test.ts` |
| Tests and the agent client read every fetch body they check with `.status` or `.ok`. | `tests/fetch-body.test.ts`, `drain` in `tests/helpers.ts` |
| Settlement stays on the stub. Live mode throws. | `tests/settlement-stub.test.ts` |
| `X-Forwarded-For` is not taken from the leftmost hop. | `tests/xff-trust.test.ts` |
| The site-key field is `type=text` and the admin line height is at least 1.75. | `tests/wp.test.ts` |
| pstack budget is low. Skip `/swarm` and `/arena` unless a design is contested. | `.cursor/rules/pstack-models.mdc` and this file |
| An author `display` rule must not show an element that carries `hidden`. | `npm run lint:hidden` (`scripts/hidden-attr.ts`) |

## Rule -> enforcer

| Rule | Enforcer | Proof |
| --- | --- | --- |
| `cashuA` and `cashuB` both pay. A gate cannot require only `cashuB`. | `scripts/cashu-guards.ts` | [tests/cashu-guards.test.ts](https://github.com/lukecarriere/toll/blob/cursor/cashu-guard-notes-389a/tests/cashu-guards.test.ts) |
| `abort()` runs only after an empty restore and an unspent check. | `scripts/cashu-guards.ts` | [tests/cashu-guards.test.ts](https://github.com/lukecarriere/toll/blob/cursor/cashu-guard-notes-389a/tests/cashu-guards.test.ts) |
| An issued quote with no store row does not pay. | `scripts/mutate-mint-quote.mjs` | [tests/settlement-mint-quote.test.ts](tests/settlement-mint-quote.test.ts) |
| An author `display` rule must not show an element that carries `hidden`. | `scripts/hidden-attr.ts` | [tests/hidden-attr.test.ts](tests/hidden-attr.test.ts) |
| Two receives that share an input get one pass from the one stored swap. | `scripts/mutate-cashu-overlap.mjs` | [tests/settlement-cashu-receive.test.ts](tests/settlement-cashu-receive.test.ts) |

Cannot catch, in `scripts/cashu-guards.ts`:

- A prefix built by concatenation or a variable (`"cashu" + "B"`, `const p = "cashuB"`).
- `store[name](id)` when `name` is not the string `"abort"` or `"lose"`.
- An `abort` saved in a callback and called after the guarding `if` ends.
- A `cashuB`-only check inside `decodeTokenV3`, `decodeTokenV4`, or `testMintPayer`.
- PHP `$fn = 'str_starts_with'` and a prefix split across concatenated strings. The TypeScript parser does not read PHP.

## Glossary

- `cashuA`: NUT-00 V3 payment. `decodeTokenV3` reads `cashuA` plus base64url JSON. `asCashuPayment` accepts it.
- `cashuB`: NUT-00 V4 payment. `decodeTokenV4` reads `cashuB` plus base64url CBOR. Change is `encodeTokenV4`.
- `creqA`: NUT-18 payment request on `X-Cashu`. `encodePaymentRequest` writes it. `asCashuPayment` does not treat it as a payment.
- `proof`: one note, `amount`, `secret`, `id`, `C`. `CashuProof` in a token. `StoredProof` after the swap.
- `keyset`: version-01 id, 33 bytes, hex prefix `01`. `cashuA` carries the short id, the first 8 bytes. `encodeTokenV4` writes the id it is given. `resolveKeysetId` maps an 8-byte `01` id to one full id from `GET /v1/keysets`.
- `mint allowlist`: `settlement.cashu.mints` on Node, `CASHU_MINTS` on the worker. `guardMintUrl` refuses anything else. Empty means receive is off.
- `change`: leftover when the source is larger than the `creqA` amount. `cashuPayer` passes it to `onChange` as a `cashuB` string.
- `conservation`: sats the mint signed equal stored proofs plus pending outputs plus recorded losses. `abort()` runs only when restore is empty and every input is `UNSPENT`.
- `l402`: the mint-quote offer beside Cashu. `kind` is `l402`. The header is `WWW-Authenticate`. The test invoice is the loopback stand-in. A real invoice is read only when `L402_ENABLED` is `1`. A retry may omit the preimage when the mint reports the quote `PAID`. Payment is the store's mint-quote row, not mint state `ISSUED`. Blinded outputs are stored on that row before the mint signs. A mint error that leaves the quote `PAID` releases the row. A lost response is recovered from those outputs. An `ISSUED` quote whose signatures cannot be fetched stays a loss.

## Team rules

A verifier miss that breaks a contract or a test is FAIL. Anything else is PASS+NOTES.

### Verifier checklist

- Hyrum's Law: pin every observable behavior (token format, header, status, error text) with a test, and name who depends on it.
- Law of Demeter: call a direct collaborator. Don't reach through a nested object or into another module.
- Lehman's Laws: don't add complexity without paying some down. Flag new duplication, dead code, and a file that keeps growing.
- Conway's Law: a change that crosses into another product has one owner and one shared contract.
- Linus's Law: the verifier is not the author, and it runs the change.
- 90-90 Rule: done covers errors, replays, wrong inputs, and limits, not only the happy path.
- Brooks' Law: don't add agents to a late item. Narrow the scope or fix the blocker.

### Craftsmanship

- A bug fix starts with a test that fails on the base commit and passes on the head. Cashu swaps and proof storage also get a mutant a test kills.
- A behavior change and a refactor are separate commits. A refactor commit does not change a test expectation.
- One user-visible change per PR, about 400 lines excluding lockfiles and generated files. Over that is a note to split next time, not a forced split.
- Boy Scout only inside files this change already touches, in its own commit.
- No new skipped test, `@ts-ignore`, `eslint-disable`, unexplained `any`, commented-out code, or TODO without an issue link.
- Names use the glossary above. Comments say why. A new domain term is added to the glossary in the same PR.
- Open the PR with "Why it matters:" and "Not done:". A verifier note cites file:line, the rule, and a fix. A note that recurs becomes an enforcer.

### In this repo

- Ecashu pays Toll, so Toll owns the shared contract test for that seam. When the two drift, fix the ownership first.
- Each week, one small upkeep item (a dependency bump, dead code, docs drift, or a check) goes through the verifier.
- A workflow done by hand twice becomes a `.cursor/skills` or `scripts/` entry, and is reused after that.
