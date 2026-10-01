# Adapters: work engine and settlement engine

Status: decided by Engineering on 2026-09-30 (Amendment 1). **Normative for the build.**
This is the only document (with package.json pins and the bundled licence notices) where vendor
names may appear. Everything public says "Toll".

Toll keeps: the `/v1` facade (`/v1/challenge`, `/v1/redeem`, `/v1/status`), the signed challenge
envelope, the replay cache, policy (classes, velocity, device multiplier, caps), the pass (HS256,
lifetimes, uses), the `<toll-gate>` element and its nine states, the agent SDK, the msat ledger.
Engines supply: the proof-of-work puzzle (issue, solve, verify) and, later, payment (offer
credential, invoice, payment proof).

---

## 1. Work engine: **ALTCHA v2** (picked) over Cap

### Pick and rationale

- **Licence and hosting:** MIT, and it runs fully self-hosted. The server library verifies locally with HMAC and a key derivation function, and its workers are standalone files we serve ourselves. Nothing calls home, and we never use the hosted Sentinel or Cloud products.
- **Fit with our endpoints:** it maps one-to-one onto `/v1/challenge` and `/v1/redeem`. Its signed `data` field binds the challenge to our id, and its key-signature fast path makes a bad solution cost one HMAC. It ships a headless multi-worker solver, so its UI never loads.
- **Memory-hard mode and PHP:** it offers a real memory-hard mode (Argon2id, also scrypt). It also has a maintained MIT PHP library that verifies the same payloads, so the PHP port is a library call, not our crypto.

### Pinned versions

| Piece | Package | Version | Licence | Where |
|---|---|---|---|---|
| Issue, verify, headless solver (Node and browser) | `altcha-lib` | **2.5.0** (released 2026-09-10) | MIT | `packages/work-adapter` (dependency); bundled into `toll.js` via `@toll/work-adapter/browser` |
| Prebuilt standalone workers (PBKDF2, Argon2id) | `altcha` | **3.2.3** (published 2026-09-20 09:11 UTC) | MIT | `packages/widget` devDependency; `dist/workers/pbkdf2.js` and `argon2id.js` are copied unchanged to `toll.worker.js` and `toll.worker-argon2id.js`. The package's web component and UI are never loaded. |
| Argon2id on the issuer (Node 22) | `hash-wasm` | **4.12.0** | MIT | `packages/work-adapter`; also inside the vendor Argon2id worker |
| PHP verifier | `altcha-org/altcha` (Composer) | **2.1.0** | MIT | `packages/server-php/composer.json` + `composer.lock`; needs PHP ≥ 8.1, and `ext-sodium` for Argon2id |

All four are MIT and bundle cleanly. The MIT notices ship as `dist/LICENSES.txt` and are served at
`/toll/v1/LICENSES.txt`. There is no copyleft, no attribution-in-UI requirement and no cost: Sentinel
and the hosted Cloud product are paid but optional, and unused.

### Criteria, in the order Luke set

| Criterion | ALTCHA v2 (picked) | Cap |
|---|---|---|
| Licence, bundles cleanly | MIT (all four pieces) | Apache-2.0 (fine too) |
| Zero third-party calls from visitors (spec §21) | Yes. Workers and solver are served from the issuer. Sentinel / Cloud are separate products we never call (`verifyServer` is never used). `check-dist` fails the build on any absolute URL or CDN host in the dist. | Not by default. `@cap.js/widget@0.1.58` loads its WASM solver from `cdn.jsdelivr.net` (overridable via `CAP_CUSTOM_WASM_URL`), plus a `pako` fallback from jsdelivr, and the widget carries trycap.dev links. Self-hosting is possible but needs patching or config in every embed. |
| Maps to `/v1/challenge` and `/v1/redeem` | Clean. The challenge is stateless and signed. `parameters.data.tid` carries our challenge id under the vendor signature, and the whole vendor payload sits inside our signed envelope. Verify is one HMAC (key signature), falling back to one KDF call. | `@cap.js/server@4.0.5` is stateful: it needs storage hooks for issued challenges and redeemed tokens, which duplicates our replay cache. It also issues its own token, which competes with our pass. |
| Solver JS size, gzipped (measured, `npm run build`) | Default path **7,462 B** (toll.js 5,739 + PBKDF2 worker 1,723) against a 25 KB budget. Hardened path 20,210 B (adds the Argon2id worker, 14,471 B gz, loaded only in hardened mode). | `cap.min.js` alone is 50.6 KB raw, before the WASM. Not measured further, because it failed the earlier criteria. |
| Headless / JS-API solving (no vendor UI) | Yes. `solveChallengeWorkers` drives the vendor workers directly. No vendor DOM is ever created, so there is no footer or logo to hide. | The widget is the primary API; headless needs the worker internals. |
| GPU-hardening | Argon2id (and scrypt) in the same protocol and libraries, Node and PHP | The RSW time-lock and "instrumentation" exist only in the widget/worker, not in the npm server (last server release Dec 2025). SHA-256 hashcash only, with no memory-hard option and no PHP library. |

**Close call?** No. Cap failed on two criteria Luke ranked high: phone-home by default, and a
stateful server with no memory-hard mode. ALTCHA won every criterion except the licence, where
both pass.

### How the engine maps onto Toll objects

```
GET /v1/challenge?action=write
  Toll policy -> { mode, alg, cost, memory_kib, counter_max }
  engine.issue({ tid: challenge.id, spec, counter = uniform [0, counter_max) })
     -> vendor payload { parameters: { algorithm, cost, memoryCost?, nonce, salt, keyPrefix,
                                        keySignature, keyLength, data: { tid } }, signature }
  Toll envelope { v:1, id, site, alg, work: <vendor payload, opaque>, bound, iat, exp, sig }
     sig = HMAC-SHA256(Toll secret, canonical JSON of everything but sig)

Browser: toll.js -> engine solver in the engine workers -> { counter, derivedKey }

POST /v1/redeem { challenge, solution: { work: { counter, derivedKey }, took_ms, ua_class } }
  1. Toll: shape, signature, time, site (cheap; no engine work on a forged envelope)
  2. Toll: replay cache, challenge id single use
  3. engine.verify(work, solution.work, { tid: challenge.id, alg: challenge.alg })
       - payload algorithm must equal challenge.alg; data.tid must equal challenge.id
       - vendor HMAC on the parameters; key signature (fast path) or one KDF re-derivation
  4. Toll mints the pass (unchanged: classes, n, lifetimes, cookie)
```

- **Engine secrets** come from the Toll secret: `HMAC-SHA256(secret, "toll/work-adapter/v1/challenge" | ".../key")`, as lowercase hex. Node and PHP derive the same values, and `docs/vectors.json` pins them.
- **Expiry:** the vendor payload has no `expiresAt` of its own, because the Toll envelope carries `exp` under the Toll signature.
- **Error mapping on the wire:** `expired` stays `expired` and `malformed` stays `malformed`. Every other engine failure is `bad_solution`.
- **Modes** (`work.mode` in toll.yaml):
  - `standard`: PBKDF2-SHA-256, the default.
  - `hardened`: Argon2id, a memory-hard mode for sites under GPU-farm pressure.
- **Policy maps to the counter range:** `counter_max = min(max_units × unit_tries, round(2 × expected_tries))`, where `expected_tries = unit_tries × class mult × device mult × velocity mult`. Mean work is about half of `counter_max`; worst case is `counter_max`.

### Vectors

`docs/vectors.json` is generated by `scripts/gen-vectors.ts` from vendor-issued fixtures and checked
on both Node (`tests/protocol.test.ts`) and PHP (`tests/php/run-vectors.php`, using the vendor PHP
library).
- 3 valid work cases: standard write, standard search, and hardened account (Argon2id).
- 15 invalid cases.
- The pass vectors, unchanged.

The browser test also checks the vendor workers reproduce each fixture's counter and key.

### Measured solve times (bench run `2026-10-01T01-24-06`, write challenge, 210 counted solves each)

| Mode | Desktop p50 / p95 | Phone-like p50 / p95 (achieved slowdown) |
|---|---|---|
| Standard (PBKDF2-SHA-256, 5,000 iterations per try) | 208.5 / 404.2 ms | 416.2 / 714.9 ms (3.27x) |
| Hardened (Argon2id t=2, m=19 MiB, p=1) | 548.5 / 1,041.7 ms | 1,405.1 / 2,295.7 ms (4.15x) |

All 840 solves redeemed OK. Method and the full table: docs/policy.md §3 and `bench/README.md`.

### Catches (for Luke)

1. **Widget package pinned one release back (resolved).** `altcha@3.2.4` was published on 2026-09-30, the day we first pinned it. For supply-chain caution, Engineering pinned **3.2.3** instead (published 2026-09-20) on the same day. The two worker files we ship are **byte-identical** between 3.2.3 and 3.2.4 (`pbkdf2.js` sha256 `7862add9…b9c86f`, `argon2id.js` sha256 `cd9770a7…27b9fe9`), so nothing shipped changed. We copy only those two files; they contain no URLs and are pinned exactly. The solver library `altcha-lib@2.5.0` is three weeks old.
2. **Hardened mode costs the issuer CPU on every challenge.** Issuing a challenge derives the secret counter's key once, so with Argon2id the issuer pays one Argon2id call per challenge. With the shipped m = 19 MiB, t = 2, that measured p50 52 ms (p95 91 ms) in WASM on this box (Node 22; 20 mints). Verifying is still one HMAC. A flood of challenge requests in hardened mode is therefore a server cost; per-IP challenge rate limits apply.
3. **Node 22 has no native Argon2id.** The issuer uses `hash-wasm` (WASM), the same code the vendor worker runs. Node ≥ 24.7 has `crypto.argon2` and can switch later, with identical output. PHP uses sodium (native).
4. **The hardened worker needs `'wasm-unsafe-eval'`.** The issuer sends that worker its own CSP (`default-src 'none'; script-src 'self' 'wasm-unsafe-eval'`), so host pages don't have to loosen theirs. A host that serves `toll.worker-argon2id.js` from its own CDN must send the same header.
5. **Vendor brand in package metadata.** The package names appear in `package.json`, `composer.json` and `LICENSES.txt` (MIT requires the notice). That is allowed by the copy lint; no vendor name appears in any visitor UI, the README or default screens.
6. **Key signature format differs between the vendor's JS and PHP libraries (found in phase 3).** `altcha-lib@2.5.0` (JS) signs the derived key as raw bytes; `altcha-org/altcha@2.1.0` (PHP) signs it as hex text. PHP verification falls back to re-deriving the key when the fast path doesn't match, so Node-minted challenges still verify on PHP (one KDF call instead of one HMAC). The JS library has no fallback, so a PHP-minted challenge can't be verified on Node. Today each issuer verifies only its own challenges (the WordPress plugin mints and verifies in PHP, both on the fast path), so nothing breaks. `tests/php-issuer.test.ts` pins this, so a library update that changes it is noticed. A bad solution sent to the WordPress issuer also takes the PHP fallback (one PBKDF2 call, a few ms); the challenge id is spent before verifying and challenges are rate limited per IP, so each challenge buys at most one such call. Worth reporting upstream before any setup mixes issuers.

---

## 2. Settlement engine: **Aperture** (picked) over direct NWC/LND L402

### Pick and rationale

- **No macaroon code of our own:** Aperture (lightninglabs/aperture, **v0.5.0**, 2026-03-25, MIT, Go) is Lightning Labs' reference L402 reverse proxy. It issues real L402 macaroons and invoices and verifies paid retries, so Toll writes no macaroon code at all, as Amendment 1 requires.
- **Toll stays the price source:** its dynamic-price gRPC hook lets Toll set the price. Toll keeps pricing, the USD display and the msat ledger.
- **Why not direct L402:** there is no maintained, permissively licensed macaroon library for both Node and PHP. Node `macaroon@3.0.4` is BSD-3 with its last release in January 2019. PHP has only an unreleased `mvieira/macaroons` dev-master and the 2015-era `immense/php-macaroons`. Going direct would mean writing and owning macaroon crypto, which Amendment 1 forbids.

### This pass: stub only

`packages/settlement-ln` (npm name `@toll/settlement`):
- `engine.ts` defines the `SettlementEngine` interface, shaped like the proxy:
  - `offer({site, cls, amount_msat})`: Toll chose the price, and the engine returns an invoice and an opaque credential.
  - `verifyPaid({proof})`: the proof is parsed from `Authorization: L402 <credential>:<preimage>`; replays are rejected.
  - `healthy()`: the degraded-mode switch.
  - Two helpers: `parseL402Authorization` and `l402Challenge` (the `WWW-Authenticate` value).
- `stub-engine.ts` is the stub engine used for tests and CI. Its credential is an HMAC-sealed test token, **not a macaroon**, and is never used outside stub mode.
- `proxy-client.ts`:
  - `ProxySettlementEngine({ mode: "stub" })` delegates to the stub engine. Any other mode throws: there is no live path in this build.
  - `priceForPath(...)` is the logic for the proxy's price hook, rounded up to a whole base unit (settlement.md Q3).
- `ledger.ts` and `stub-settler.ts`: integer msat, gross/fee/net, fee held.
- Phase 2 (built, stub only): `rail.ts` is the facade the issuer uses (`offers`, `redeemPaid`, `status`, `balance`). The issuer creates it with a `StubEngine`, so offers, the 402 to agents, paid redeem → one-use 60 s pass, and ledger booking all run end to end on the stub. No node, no funds, no paid service.

### How an engine success becomes a Toll pass

1. Toll prices the request (`offerAmountMsat`) and asks the engine for an offer. The engine returns an invoice and an opaque credential; Toll never parses either.
2. The client pays and presents `{offer_id, preimage, macaroon}` at `POST /v1/redeem` (the proxy would instead verify `Authorization: L402 …` itself and forward the request).
3. The engine's `verifyPaid` returns `{cls, amount_msat, payment_ref}` or throws. The stub checks its sealed credential and `SHA256(preimage) == payment_hash` locally; the proxy engine would do the same with a real macaroon.
4. Toll claims the offer in the replay store (one payment, one pass), books gross/fee/net in the msat ledger with the offer id as the duplicate guard, and mints an ordinary Toll pass with `n = 1`, `exp = now + 60`, tagged `settle` for metrics.

Swapping the stub for the proxy changes step 1-3 only; the pass, ledger, metrics and HTTP shapes stay the same.

### Deployment shape (documented, not built)

```
agent ──> Aperture (L402 proxy) ──> Toll issuer (paid redeem, phase 2 shape)
             │  dynamicprice gRPC ──> Toll price source (priceForPath)
             └─ LND (or LNC) for invoices; sqlite/postgres/etcd for its own state
```

When Aperture verifies a paid request, it forwards it to Toll, and Toll mints the pass and books the
payment against the `payment_hash`. That reference is unique, so the ledger's duplicate guard is
what enforces one payment, one pass.

### Catches (for Luke)

1. **No WordPress shared hosting.** Aperture needs a Go binary, an LND (or LNC) connection and a database. It fits self-hosters who already run a node, and the phase-4 hosted processor. A WordPress site on shared hosting would rely on the hosted processor for payments. Work-only mode is unaffected.
2. **Close call on maintenance cadence.** Aperture has a release roughly once a year (v0.5.0, March 2026). Direct L402 would avoid the extra hop but forces our own macaroon code, so the amendment decides this one, not taste.
3. **No cost in this pass.** Aperture is MIT and free. Running it for real needs a node, which is out of scope here (stub/regtest only).
4. **Regtest deferred in phase 2.** The optional Aperture + regtest setup needs Go, LND and bitcoind running locally. That is not cheap enough for this pass, so phase 2 ships on the stub only. Nothing remote, nothing paid.

---

## 3. Retired

- **Custom PBKDF2 sub-puzzle miner:**
  - `packages/protocol/src/work.ts`
  - `packages/widget/src/worker.ts`
  - `bench/src/bench-worker.ts`
  - PHP `subSalt` and the custom `verifyWork`
  - the old work vectors
- **Toll-written offer "macaroon":** reduced to the stub engine's sealed test credential (`stub-engine.ts`). It's not a macaroon and is not used outside stub mode.
- **Bench results** from the retired engine stay in `bench/results/2026-10-01T00-32-07/` as history only.

## 4. Agent discovery payment: **stub** (x402 not wired), Amendment 3, Oct 1, 2026

**Decision:** the manifest (`/.well-known/toll.json`) and the MCP tools ship with `payment.status: "stub"`. They list the offer an agent can actually complete today: the existing `/v1` 402 offer (`kind: "ln402"`, local test backend, `status: "test"`). They also say `x402: { status: "stub" }`. No x402 offer is advertised and nothing is submitted to the Bazaar.

**Why x402 can't sit on the existing /v1 offer:**

- **Different offer.** An x402 402 carries `accepts[]` entries (`scheme: "exact"`, `network`, `asset`, `payTo`, atomic `amount`) in a `PAYMENT-REQUIRED` header or body. The `/v1` offer is an ln402 invoice plus a sealed credential (docs/settlement.md). One `offers[]` entry can't be both.
- **Different proof.** The x402 client retries with a signed payment payload header (an EIP-3009 stablecoin authorization for `exact` on EVM). The `/v1` proof is `{offer_id, kind, preimage, macaroon}` at `POST /v1/redeem`. Accepting x402 means a second proof type, a second verifier and a second replay store. That is the second pay protocol Amendment 3 forbids ("Do not invent a second pay protocol").
- **Different settlement.** x402 verify and settle go through a facilitator (CDP or self-run). `payTo` is a stablecoin address, so even on a test network it needs a wallet and key. The hard rules exclude real wallets, and a test wallet still means a new custody path that Amendment 1 doesn't cover.
- **The Bazaar can't list a stub anyway.** The CDP facilitator catalogs an endpoint only after a successful settlement through it, with `paymentPayload.resource` set and the bazaar extension declared (docs.x402.org/extensions/bazaar; CDP x402 Bazaar docs, read Oct 1, 2026). Resource URLs must be absolute https with no loopback. A local stub can't meet any of that, and Amendment 3 says a fake price in a public catalog is worse than no listing.

**What would change it:** Luke approves x402 as a second rail. Then a facilitator is chosen, a `payTo` address exists on a test network first, and an x402 adapter mints `accepts[]` from the same `rail.price()` (so the USD and amounts stay identical). It would redeem into the same pass. The manifest's `payment.methods` gains `{ kind: "x402", status: "test" }`, and docs/catalogs.md moves the Bazaar row to "ready".

**Prices are never hard-coded.** The manifest, `GET /v1/price` and the MCP `price_write_action` all take the amount from `offerAmountMsat()` and the USD from `offerUsd()` (rounded up to $0.0001) through `rail.price()`. That is the same call the 402 offer makes. WordPress gets amounts and the rate from its payment server (`GET /v1/owner/price`) and derives the USD with `Settlement::offerUsd`, the PHP twin pinned by the settlement vectors. Every price carries `status` ("test" or "stub") and displays like `$0.0100 (test)`, never as a bare number. The manifest shows the base price (`basis: "base"`, load multiplier 1); the docs/copy.md base-price note is added to the priced tool only when that site's offers can rise (Node with velocity on; WordPress when its payment server reports `load_pricing`, which it does not yet); `GET /v1/price` and `price_write_action` show the price that applies now (`basis: "current"`, with `load_multiplier`), computed with the same velocity multiplier as the caller's 402.

**Lint scope (docs/copy.md, Amendment 3):** in the manifest and MCP documents, only `payment` objects may name the payment method. Every other string (each `description`, the tool names, the price displays) is linted with the full list, the vendor list and the payment-method words (`scripts/copy-lib.mjs` `lintDiscovery`, run by `npm run lint:copy`).

## Vendor names (copy lint)

Checked on every public surface (README, demo pages and strings, widget source and dist, issuer
source, the WordPress package when it exists, toll.example.yaml) and on commit titles.
They're allowed only in this file, in `package.json` / `composer.json` / lock files, and in
`LICENSES.txt`.

- Exact case: Cap
- Any case: ALTCHA, Aperture, Cap Cloud, cap.js, capjs, trycap, Sentinel, ALTCHA Sentinel, ALTCHA Cloud, altcha-lib, Lightning Labs
- Forbidden services, any case: Turnstile, reCAPTCHA, hCaptcha, Arkose, FunCaptcha, DataDome, PerimeterX, Kasada, Friendly Captcha, Cloudflare Turnstile
