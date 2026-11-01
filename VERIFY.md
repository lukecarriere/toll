# Verifying Toll

A verifier runs a script and reads PASS, FAIL, or KNOWN. The scripts do not deploy, publish, or change DNS.

## Pull request

From a clean checkout, with Node 22, Node 24, PHP 8.1 or newer, Composer, and a full git history:

```sh
bash scripts/verify-toll.sh --ref <pr-sha> --base <base-sha>
```

That is the pre-merge gate: install, build, typecheck, lints, the Node tests on Node 22 and Node 24, the PHP tests, the `scripts/mutate-*.mjs` scripts, a gitleaks scan of `<base-sha>..<pr-sha>`, and a base proof. The base proof runs the pull request's new test files against the base commit. Each of those files has to fail there.

Evidence lands in `.verify-toll/<stamp>-<sha>/` (gitignored): one log per step and `SUMMARY.md`. The process exits 0 only when the overall line is PASS. KNOWN and SKIP do not fail the run.

PHP without `sodium_crypto_pwhash` cannot run Argon2id. `run-vectors` is then KNOWN at 33 passed and 1 failed, on the hardened vector only. `run-issuer` is KNOWN when it stops on `ext-sodium is required for Argon2id.` and prints no `FAIL` line. Any other PHP failure is FAIL. With sodium, both runners have to exit 0. The count is 34 checks in `docs/vectors.json`, so the one known miss is 33 passed and 1 failed.

`--only lint,test` runs those steps alone. The tree needs `npm ci` and a build before `test` or `typecheck`.

This gate does not call a live mint and does not spend. It does not run `scripts/live-checks.sh` or `scripts/l402-live-check.sh`.

## After a deploy

Someone who may deploy publishes with the commit in the message:

```sh
npx wrangler deploy --message <sha>
```

Then:

```sh
bash scripts/release-check.sh --commit <sha> --version <worker-version-id>
```

It runs the free live checks, reads `wrangler deployments status` and `wrangler versions list` for `toll-site`, and checks that the live version id is `<worker-version-id>` and that the deploy message names `<sha>`. It prints `npx wrangler rollback <previous-version-id>` and does not run it. Wrangler has to be logged in to the account that owns the Worker. The free checks talk to `https://lessspam.dev`.

## Live checks

```sh
bash scripts/live-checks.sh
```

Free and read-only: `GET /v1/health`, `GET /v1/price?action=write`, `POST /demo/contact` (403 without an agent header, 402 with `toll-client: agent`), and `GET /demo/stats` with exactly `accepted`, `rejected`, `reversals`, and `reversed_sats`.

Real ecash is separate and spends:

```sh
bash scripts/live-checks.sh --spend 20 --proofs "$TOLL_PROOFS" --wallet "$TOLL_WALLET"
```

`--spend 20` is the cap for the two paid checks (10 each). The wallet module exports `wallet()`, `norm`, and `MINT`. The proofs file is the path you pass. The script never prints a token, a proof, or a secret. A spend run writes `.state.json` mode 0600 in the out dir; do not publish that directory. `scripts/tail-redact.py` and `scripts/tail-summary.py` redact a `wrangler tail --format json` capture. `scripts/check-live-state.sh` is the older free check and remains covered by its test.

## Still done by hand

- A visual pass and browser screenshots. Phone width is asserted in `tests/viewport.test.ts`; a screenshot is not.
- The WordPress admin UI. The plugin zip is checked in the local drive (`bash .cursor/skills/verify/run.sh`). A live admin at `http://127.0.0.1:8888` is optional.
- `scripts/live-checks.sh --spend` and `scripts/l402-live-check.sh`. Both spend. They are not part of the pre-merge gate.
- The deploy itself, and the Cloudflare login `release-check.sh` uses to read the Worker version.
- Starting `wrangler tail`. The redact helpers are in `scripts/`; the tail is not started for you.

## CI

`.github/workflows/ci.yml` runs `scripts/verify-toll.sh --only gitleaks` on pull requests and on `main`. On a pull request the scan is the base commit through the head. On `main` it is the pushed range. A local run with no `--base` scans the one commit under test. The test job already runs the Node 22 suite, PHP with sodium, and the mutant scripts. The rest of `verify-toll.sh` (Node 24, the base proof, and a second install) stays a verifier command.
