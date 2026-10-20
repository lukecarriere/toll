# T6 release rehearsal: GO

Rehearsal of clean `main` at `5cd9c85d16623d1d03a0bbeb42e79c713f818fdf` (`5cd9c85`, "Add privacy, terms and support pages"). Nothing was published to npm. Nothing was deployed. No DNS change.

**Decision: GO.**

The test suite passed, each public package dry-run packed, the local site returned 200 for `/`, `/docs`, `/docs/quick-start`, and `/download`, and `sha256sum -c` accepted `toll-gate-0.1.0.zip`. Phone screenshots are 390×844 with no sideways scroll.

**Fixes in this change: none.** The rehearsal did not find a small defect to patch.

## Environment

| Tool | Version |
|---|---|
| Node | v22.23.3 |
| npm | 10.9.9 |
| PHP | 8.3.6 (NTS), `ext-sodium` loaded |
| Composer | 2.7.1 |
| Local worker CLI | 4.145.0 |

Same setup as CI, run before the recorded test command, both exit 0:

| Command | Exit |
|---|---|
| `composer install --no-interaction --no-progress` in `packages/server-php` | 0 (`Generating autoload files`) |
| `npx playwright install --with-deps chromium` | 0 |

Working tree of tracked files was clean before these commands. `.dev.vars` was written for the local worker and is gitignored. The secret was not printed.

## `npm ci && npm test`

Exit **0**.

Node reporter:

```
# tests 279
# pass 233
# fail 0
# cancelled 0
# skipped 46
# todo 0
```

The 46 skips are the WordPress cases, which need a local WordPress. PHP runners, last line of each:

```
PHP 8.3.6: 33 passed, 0 failed
PHP 8.3.6 settlement: 65 passed, 0 failed
PHP 8.3.6 issuer: 22 passed, 0 failed
PHP 8.3.6: 154 passed, 0 failed
PHP 8.3.6 gate: 65 passed, 0 failed
PHP 8.3.6 uninstall: 13 passed, 0 failed
```

Copy lint: `copy-lint: 128 files, 75 commit titles, 46 rules from docs/copy.md, 22 vendor names from docs/adapters.md, 0 hits`.

Build line for the plugin zip: `build-wp-zip: dist-release/toll-gate-0.1.0.zip, 85 files, 130573 B, commit 5cd9c85`.

`npm ci` also printed `3 high severity vulnerabilities`. They are the local worker CLI (4.145.0), its miniflare dependency, and `sharp` (`sharp` < 0.35.5, librsvg). They are not files in the four public tarballs below. Not changed here.

## `npm publish --dry-run` in every `packages/*` directory

Each command was `npm publish --dry-run` and only that. No package was published.

| Directory | Package | Exit | Result |
|---|---|---|---|
| `packages/agent` | `@lessspam/agent@0.1.0` | 0 | dry-run, public access |
| `packages/edge-cf` | `@toll/edge-cf@0.1.0` | 0 | skipped, `private: true` |
| `packages/mcp` | `@lessspam/mcp@0.1.0` | 0 | dry-run, public access |
| `packages/protocol` | `@toll/protocol@0.1.0` | 0 | skipped, `private: true` |
| `packages/server-node` | `@lessspam/server@0.1.0` | 0 | dry-run, public access |
| `packages/server-php` | (none) | 254 | no `package.json` (Composer package) |
| `packages/settlement-ln` | `@toll/settlement@0.1.0` | 0 | skipped, `private: true` |
| `packages/widget` | `@lessspam/widget@0.1.0` | 0 | dry-run, public access |
| `packages/work-adapter` | `@toll/work-adapter@0.1.0` | 0 | skipped, `private: true` |
| `packages/wp-toll-gate` | (none) | 254 | no `package.json` (WordPress plugin) |

Exit 254 on `server-php` and `wp-toll-gate` is expected. They are not npm packages. Exit 0 on the private packages is the CLI refusing to publish them.

### Tarball hashes (dry-run)

`shasum` is the npm sha1 of the packed tarball. `integrity` is sha512. These match `npm pack --dry-run --json` for the same trees.

| Package | Files | Bytes | shasum | integrity |
|---|---|---|---|---|
| `@lessspam/widget@0.1.0` | 9 | 25000 | `983a4a8f374b13748fd881589bad2bb500f7e228` | `sha512-7BagsWHi5kAGGvxizlwxMZ+o83vne0gFHK3VtrItb79YOXNVkrJjle6g+Z1UDQRGKzH/wxQU6Mt3+Vc1WsLFgw==` |
| `@lessspam/server@0.1.0` | 35 | 64399 | `a8f41cdbfd5a9f07a76277390db3189523785fd9` | `sha512-xxfNxC1Hr53AnlaUTIu+N01U4H4sj4MCttWP0/rBMedoMTDHZCWsgR8Aq1SI8zHnxahP9qJIamqHEhyHq/h02g==` |
| `@lessspam/agent@0.1.0` | 27 | 16665 | `13aebdb3aa442509c120775cf93fc7fc03c64e59` | `sha512-dmf55iOw6Szkh4E7uewVUcN/vkvMrdD7Nxk7t8f8gqLVJBPy512V5QpGDh6PlkOGMXlPipzZ86gLdec+NzahUg==` |
| `@lessspam/mcp@0.1.0` | 17 | 11291 | `2cdd39a10cbf0884b88f198431f1832f8b1b7de9` | `sha512-cJs6uBeiv3pdK4hAxFuK2NuLwmLXzYtBI73Kr4WS7qm5SjsqpMFoArSL7sw8wNFCnMa8wq27OZUuLUwAv7MYZA==` |
| `@toll/edge-cf@0.1.0` (private) | 11 | 12787 | `a03af2ced6ba37f5625bab7c57ccd8fc2dee2550` | `sha512-o9TflAe43fz7TZGWsH40AIuyApgpUimJBEjuPeGr3nuT+lNjLEtvAJbdsa2niI6WyzGDLLizLpJTLr7iEvLjnw==` |
| `@toll/protocol@0.1.0` (private) | 12 | 11635 | `57160dc3ab2b3ef03a2d7293971c1305b9b99fe6` | `sha512-I9UUR6gFZvRhYK/srhRvqMPmqpnM+veJWFWpSt4gThVIlmEipYa03saD/Rh//oZ5TDRfZPrG6AQDotT1jvHauw==` |
| `@toll/settlement@0.1.0` (private) | 9 | 9964 | `a442fc790fc9c37fab6a33929698d4cc91406d00` | `sha512-ZI+6o58baKZSgs/Z8ux+w/7LpX8Ci9gTdOVU3q8QCZI6+Jxd/asWntiwQ2xT0uQm8EbPN1ztWdbKfId0aoZuUA==` |
| `@toll/work-adapter@0.1.0` (private) | 3 | 3320 | `b0ada625c98eeb5b250d98ca3efa99a3c6c7a373` | `sha512-DzWNDTWYpYNZviT5L7Jzs9/nGrqkRD4vrLdce6tcX5fMUXL6vVgFgoeaePoqbd19Zun6Mp6u70NFvAyKcom3/w==` |

Registry check (read only, versions already published, not uploaded by this rehearsal):

| Package | Registry integrity matches this tree |
|---|---|
| `@lessspam/widget@0.1.0` | yes |
| `@lessspam/agent@0.1.0` | yes |
| `@lessspam/mcp@0.1.0` | yes |
| `@lessspam/server@0.1.0` | no |

The published server tarball integrity is `sha512-FG8L0K6NrPemXNntBsOA8bDEN3JsrF50bMnhaK4Ly2urROegumy1hGH8zhYMPK8oLJFuO9Is2HJVIsiJjWfxPw==` (shasum `0b22ae2ef2c5976c3ce0284a16950f3576db9dcc`). Unpacked, only `dist/index.js` and `dist/types/server-node/src/stores.d.ts` differ. This tree adds optional `TollStore.consumeTagged`. npm will not replace an existing 0.1.0, and the publish helper skips a version that is already on the registry. That does not fail this dry-run. It does mean a later publish of this tree needs a new version, which this rehearsal did not cut and did not upload.

## Local site (`wrangler dev --local`)

From the repo root, after the build above. Flags pin the listener and turn off the interactive session. Still `--local`. Not a deploy.

```
npx wrangler dev --local --ip 127.0.0.1 --port 8788 --show-interactive-dev-session=false
```

The process printed `Ready on http://127.0.0.1:8788` and stayed up for the checks. It has no success exit code of its own. It was stopped after the checks, and port 8788 then refused connections.

| Command | HTTP | Exit |
|---|---|---|
| `curl -fsS -o /dev/null http://127.0.0.1:8788/` | 200 | 0 |
| `curl -fsS -o /dev/null http://127.0.0.1:8788/docs` | 200 | 0 |
| `curl -fsS -o /dev/null http://127.0.0.1:8788/docs/quick-start` | 200 | 0 |
| `curl -fsS -o /dev/null http://127.0.0.1:8788/download` | 200 | 0 |

Headings served: Docs, Quick start, Download. The homepage title is `Toll · Less traffic. Better road.` and its `h1` is `Less traffic.` / `Better road.`

The same listener also returned 200 for `/docs/widget`, `/docs/server`, `/docs/agent`, `/docs/mcp`, `/docs/wordpress`, `/docs/self-hosting`, `/mission`, `/vision`, `/values`, `/ecosystem`, `/privacy`, `/terms`, `/support`, `/robots.txt`, `/favicon.ico`, `/demo`, and `/v1/health` (`{"ok":true,"v":"1.0.0","settlement":"off","edge":true}`).

## `toll-gate-0.1.0.zip` checksum

Built file, from `dist-release`:

```
(cd dist-release && sha256sum -c toll-gate-0.1.0.zip.sha256)
```

Exit **0**. Output: `toll-gate-0.1.0.zip: OK`.

The zip and the sidecar downloaded from `http://127.0.0.1:8788/download/` (`curl -fsS`, exit 0 for both) checked the same way. Exit **0**. Output: `toll-gate-0.1.0.zip: OK`.

| File | sha256 |
|---|---|
| `toll-gate-0.1.0.zip` (130573 bytes, 85 entries, commit `5cd9c85`) | `a917c0c90e2df45f62ab5b694de8ca5cd48bfe4e926219069e5760fecce9d1a6` |
| `toll-gate-0.1.0.zip.sha256` | `06951680e80c686cd90e59358959c039a955b247a9ba41e706628d4f748da04c` |

The zip entry timestamps are the commit time, so a later commit produces a different zip hash. `sha256sum -c` compares the zip to the sidecar from the same build. The hash above is the `5cd9c85` build, which is the tree this rehearsal tested. The download page on that build prints the same digest.

## Screenshots (390×844)

Playwright Chromium, viewport 390×844, device scale 1, `fullPage: false`, after `networkidle`, against `http://127.0.0.1:8788`. Each PNG is 390×844. `document.documentElement.scrollWidth` was 390 on every page (no sideways scroll). `innerWidth` was 390.

| Page | Path | HTTP | scrollHeight | File | sha256 |
|---|---|---|---|---|---|
| Home | `/` | 200 | 919 | `qa/screenshots/home-390x844.png` | `3cb1cb8ada90882be0ad8ad6cce9ddd03f1cc9f250ec0a9c8c3522d14d62fd1a` |
| Docs | `/docs` | 200 | 1262 | `qa/screenshots/docs-390x844.png` | `65f31250976a7d4861d5ca5804109051a89ab1afa234672789f75660aaef4c85` |
| Quick start | `/docs/quick-start` | 200 | 2250 | `qa/screenshots/quick-start-390x844.png` | `66bdef19e6bdf11c4826d6205d143b5ddc9aa1b71bfbce61fa9f21c67100090f` |
| Download | `/download` | 200 | 1114 | `qa/screenshots/download-390x844.png` | `ed205ac4c7d0e4fca3f91dab185258e0312a17f8b870b4ded7f2186b46bb3171` |

The shots are the first screen, not the whole scrolled page. Pages taller than 844px continue below the fold. That is vertical scroll, not overflow past the width.

## Why GO

- `npm ci && npm test` exited 0, with `# fail 0`, `# cancelled 0`, and every PHP runner at `0 failed`.
- The four public packages dry-ran at exit 0. The four private packages were skipped at exit 0. The two non-npm directories exited 254 because they have no `package.json`.
- `/`, `/docs`, `/docs/quick-start`, and `/download` returned 200 from the local worker.
- `sha256sum -c` accepted the plugin zip from the build directory and from the local download URL. Both hashes are `a917c0c90e2df45f62ab5b694de8ca5cd48bfe4e926219069e5760fecce9d1a6`.
- The four screenshots are 390×844 and none of those pages is wider than the screen.

Not part of this GO: publishing, deploying, or cutting a new package version. `@lessspam/server@0.1.0` on the registry is an older tarball than this tree.
