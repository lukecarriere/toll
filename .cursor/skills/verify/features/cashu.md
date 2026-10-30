# Cashu receive

A Toll issuer can take a `cashuA` or `cashuB` payment and keep the proofs. Change is `cashuB`. The allowlist defaults to empty, so this journey does not call a public mint. The check is the loopback suite inside `npm test`.

## Sub-features

- `cashu-test` keeps the loopback `http` mint and `testMintPayer`.
- `cashu-receive` swaps a version-01 token, maps the short keyset id, and stores the proofs.
- `cashu-replay` refuses the same token after a new process, and refuses it from the mint when the store is empty.
- `cashu-allow` refuses a non-https mint, a private host, a mint that is not listed, and a redirect.
- `cashu-relay` copies `X-Cashu` through the PHP library and the WordPress gate tests.

## How to get to it (user POV)

- Leave `settlement.cashu.mints` unset or empty. No mint is contacted.
- To turn receive on, set `settlement.enabled`, `settlement.cashu.enabled`, `settlement.cashu.mints`, and `settlement.cashu.store`. Leave `settlement.backend` as `stub`. Do not set `mode: live`.

## Driving it with curl and node

Preconditions:

- `npm test` has passed. That run includes `tests/settlement-cashu.test.ts`, `tests/settlement-cashu-receive.test.ts`, and `php tests/php/run-cashu-relay.php`.

- **Loopback receive.** Those files are the drive. A 402 carries `X-Cashu: creqA…`. A `cashuA` token and a `cashuB` token from the loopback version-01 mint each come back as a pass with `n = 1` and a 60 second lifetime. The same token is `401` `replay`. An unlisted mint is refused. A short keyset id is mapped before the swap. With the mint stopped, the agent gets `403` `toll_required` and a work challenge. `node scripts/mutate-cashu-token.mjs` kills a cashuA path that skips the allowlist and a cashuA path that skips the replay check.
- **Default demo.** Doctor still expects `"settlement":"stub"`. The demo does not set the allowlist.

## Gotchas

- Do not put a public mint in the demo config for this run.
- Do not print the proof file. It holds secrets.
- The WordPress admin is not part of this journey. The relay is the PHP gate test.
