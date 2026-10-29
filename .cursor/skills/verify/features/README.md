# Toll verification map

This directory is the maintained source for verifying Toll. Read the index, then use the matching feature file.

## Baseline preconditions

- Repository root, Node `>=22.18`, PHP `>=8.1` with `ext-sodium`, Composer, full git history.
- `bash .cursor/skills/verify/run.sh` installs, runs `npm test`, and starts the demo on `127.0.0.1:8787`, the static site on `127.0.0.1:8791`, and the worker on `127.0.0.1:8788`.
- Doctor: demo `/v1/health` is `ok` and `settlement` is `stub`. Site and worker return 200.
- Never print `TOLL_SECRET`, `TOLL_OWNER_KEY`, or `SITE_SECRET`.
- Do not deploy, publish, or change DNS.

## Driving conventions

- Drive with curl, node, and php, as written in each feature file.
- Read response bodies. A status line alone is not the proof.
- The human path prints statuses only.
- Evidence goes to `.verify-e2e/` (gitignored) and stays there after cleanup. The saved run in `docs/runs/verify-e2e/` is not rewritten.

## Proof and skip reporting

- Capture the request and the resulting state.
- A skipped live WordPress admin is not verified by the zip. Record that the admin was not running.
- Phone width is proved by `tests/viewport.test.ts` inside `npm test`.

## Features

- [Site](./site.md) covers the static pages, the worker, and phone width.
- [Demo form](./demo-form.md) covers the protected form, the 403, and a work pass that completes the write.
- [npm packages](./packages.md) covers `@lessspam/server`, `@lessspam/agent`, `@lessspam/widget`, and `@lessspam/mcp`, plus the PHP library.
- [Cashu receive](./cashu.md) covers the loopback version-01 mint. Production mints stay off unless the allowlist is set.
- [WordPress plugin](./wordpress-plugin.md) covers the download zip. Live admin is separate and only when port 8888 is up.
