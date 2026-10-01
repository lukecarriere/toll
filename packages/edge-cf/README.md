# packages/edge-cf

Toll at the edge (spec §11, phase 3): one Worker that is both the issuer (`/v1/*`) and the gate in
front of any origin, with no origin changes. **Local only**: it runs under `wrangler dev --local`
(workerd plus a local KV). Nothing here deploys, logs in, or needs an account; `wrangler.toml` has no
account, route or zone on purpose.

## Run it locally

```
npm run build                              # widget files the Worker serves
cp packages/edge-cf/.dev.vars.example packages/edge-cf/.dev.vars   # local test secret (gitignored)
npm run dev -w packages/edge-cf            # bundles, then wrangler dev --local on http://127.0.0.1:8789
```

By default it fronts the Node demo on `http://127.0.0.1:8787` (`ORIGIN` in `wrangler.toml`), so with
`npm run demo` running you can try:

```
curl -s http://127.0.0.1:8789/v1/health
curl -s -X POST -H 'accept: application/json' http://127.0.0.1:8789/contact -d '{}'   # 403 + challenge
```

Tests: `node --test tests/edge.test.ts` (starts `wrangler dev --local` on a free port against a
throwaway origin; part of `npm test`).

## Behaviour (spec §11)

| Request | Result |
|---|---|
| GET/HEAD/OPTIONS outside `/v1/` and `/toll/v1/` (any prefix, even a gated one), `FREE_PATHS` | proxied to `ORIGIN` before any Toll code runs, so page views stay up even if the Toll config is broken (Amendment 2: reads stay free) |
| POST/PUT/PATCH/DELETE to a gated prefix with a valid `toll_pass` cookie or `Authorization: Toll` | one pass use spent, proxied |
| …without a pass, `Accept: application/json` | `403 {"error":"toll_required","challenge":{…}}` |
| …without a pass, HTML | `403` interstitial: a `data-toll` form that re-sends the urlencoded fields (≤ 16 KB) after the check; `<noscript>` says "This form needs JavaScript." |
| `/v1/challenge`, `/v1/redeem`, `/v1/status`, `/v1/health` | the Toll facade (docs/protocol.md) |
| `/v1/siteverify` | form or JSON `secret` + `response` (a pass or a redeem payload) + optional `action` → `{success, action, hostname, challenge_ts}` or `{success:false,"error-codes":[…]}` |
| `/toll/v1/toll.js`, `/toll/v1/toll.worker.js` | the widget, same-origin |

Config: `SITE_ID`, `SITE_SECRET` (secret), `ORIGIN`, and JSON arrays `WRITE_PATHS`, `SEARCH_PATHS`,
`ACCOUNT_PATHS`, `FREE_PATHS`; an optional KV key `toll_routes` (`[{"prefix":"/x","class":"write"}]`)
overrides the path lists. The default routes start with `{"prefix":"/","class":"read"}`; the worker never gates a GET, whatever the routes say. Metrics go to the console as the same JSON lines as Node
(`challenge_minted`, `pass_absent`, `pass_reject`, …). Bodies, cookies and Authorization values are
never logged.

## Limits (deferred)

- **Work-only at the edge.** No offers and no paid redeem (`400 unsupported`); agents do the work.
- **Standard engine only.** The Argon2id engine compiles WebAssembly at runtime, which Workers do not
  allow, so hardened mode and Argon2id escalation are off here (velocity still raises the work). Fix:
  ship the WASM as a module import.
- **KV is eventually consistent** across locations: challenge first-use and pass use counts are exact
  within one location. Use a Durable Object store before any real deploy.
- No deploy, no route setup, no custom domain: that needs an account and Luke's approval.
