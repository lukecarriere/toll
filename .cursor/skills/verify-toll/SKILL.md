---
name: verify-toll
description: Run Toll's scripted pre-merge gate and the post-deploy check. Use for a pull request, a release, or when a verifier should read PASS or FAIL instead of rebuilding checks by hand.
---

# Verify Toll from the scripts

Read `VERIFY.md`. Run the commands from the repository root. Do not deploy, publish, or change DNS. Do not print `TOLL_SECRET`, `TOLL_OWNER_KEY`, `demo/.owner-key`, the worker `SITE_SECRET`, a payment string, a proof, or a pass.

Needs Node 22, Node 24, PHP `>=8.1`, Composer, and full git history. Set `NODE_22` and `NODE_24` to absolute paths when those binaries are not on `PATH` as `node22` and `node24`. The gate also checks `node` itself, `~/.local/node-v<major>*`, `/usr/local/node-v<major>*`, and the highest match under `${NVM_DIR:-$HOME/.nvm}/versions/node/v<major>.*`. PHP without sodium is allowed: the Argon2id miss is KNOWN when every FAIL line is that vector and the runner's own pass, fail, and skip counts add up. Any other PHP failure is FAIL. The mutant scripts run on Node 22. gitleaks 8.30.1 is downloaded into `~/.local/bin`, which is appended to `PATH`, when it is not already on `PATH`.

## Pre-merge

```sh
bash scripts/verify-toll.sh --ref <pr-sha> --base <base-sha>
```

Exit 0 and `SUMMARY.md` overall PASS are the result. KNOWN and SKIP are recorded and do not fail the run. The command does not call a live mint and does not spend.

A single step: `bash scripts/verify-toll.sh --only lint,test`.

## After deploy

```sh
npx wrangler deploy --message <sha>
bash scripts/release-check.sh --commit <sha> --version <worker-version-id>
```

The script runs the free live checks and prints the rollback command. It does not run the rollback.

## Free live checks

```sh
bash scripts/live-checks.sh
```

## Still manual

Browser screenshots, the WordPress admin UI, `scripts/live-checks.sh --spend`, `scripts/l402-live-check.sh`, the deploy, and a Cloudflare login so `release-check.sh` can read the Worker version. The local server drive remains `bash .cursor/skills/verify/run.sh`.
