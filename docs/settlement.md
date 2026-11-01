# Settlement rail (phase 2)

Status: **phase 2 built on the local test backend** (2026-09-30 CT). The issuer wires the rail end to end when `settlement.enabled: true`: offers for agent clients, 402 to agents, paid redeem to a one-use 60 s pass, msat ledger with gross/fee/net, USD display from a rate source, degraded mode. The only backend in this build is `stub` (no network, no real funds). The proxy engine (docs/adapters.md §2) and regtest are **deferred** (§10). With settlement off (the default) nothing changes: `offers: []`, `/v1/health` says `"settlement": "off"`, and a paid redeem gets `400 unsupported`.

Code: `packages/settlement-ln/` (engine interface, stub engine and settler, `rail.ts` facade the issuer uses, ledger, `fx.ts`), issuer wiring in `packages/server-node/src/{toll,http,config}.ts`, the agent client in `packages/agent/`. Tests: `tests/settlement-stub.test.ts`, `tests/settlement-http.test.ts`, `tests/settlement-vectors.test.ts`, the phase 2 browser test, and `tests/php/run-settlement-vectors.php`.

This file and `packages/settlement-ln/` are internal/protocol surfaces and may use protocol words (spec §1). Nothing in here may be copied onto a default screen; owner screens show USD only (docs/copy.md "Money").

## 1. Goal

Same gate, second rail. An automated client can pay a small Lightning invoice per request instead of grinding work. Paying mints the same kind of pass as work (spec §6.2), so origins never care which rail was used. Humans never see this rail.

## 2. Offer object (wire)

Returned in `offers[]` from `GET /v1/challenge?client=agent` (and in a 402 to agents, §4) when settlement is enabled and healthy. The widget never asks for or reads offers.

```json
{
  "id": "off_6f1c2a9b0d4e8f7a6b5c4d3e",
  "kind": "ln402",
  "amount_msat": 10000,
  "display": { "usd": "0.0085", "label": "per request" },
  "invoice": "lnbcrt…",
  "macaroon": "<payload>.<mac>",
  "exp": 1790000120
}
```

- `id`: `off_` + 12 random bytes hex.
- `amount_msat`: integer, always a multiple of 1,000 (Q3). `display.usd` is computed from the rate source (§7), 4 decimals rounded up; it is omitted when the rate is unavailable. Never hardcode a USD value (the spec's `"0.004"` example was a placeholder).
- `invoice`: BOLT11 from the configured backend; the stub settler returns a fake `lnstub1…` string.
- `exp`: `≤ now + 120` and never later than the invoice expiry (spec §16).
- The `display.usd` value above is only an illustration (10,000 msat at the findings memo's ~$85k rate); the real value comes from the live rate.

## 3. Price

```
amount_msat = base_msat[action] * velocity_mult * suspicion_mult        (rounded to an integer msat)
```

| Class | base_msat |
|---|---|
| search | 2,000 |
| write | 10,000 |
| account | 25,000 |
| admin | 100,000 |

`velocity_mult` and `suspicion_mult` are the same values the work policy uses for this request (`packages/protocol/src/policy.ts`), so difficulty and price move together (spec §6.7). Velocity is off until phase 3, so phase 2 prices are the base table. Built: the issuer passes the work policy's velocity multiplier into the offer (`suspicion_mult` is 1 until a suspicion signal exists).

Offer amount (Q3): `amount_msat = ceil(round(price) / 1000) * 1000`. The policy price is rounded to an integer msat first, so float noise (`10000 * 1.1 = 11000.000000000002`) cannot add a whole unit. `offerAmountMsat()` in `stub-engine.ts`; PHP `Settlement::offerAmountMsat()`.

## 4. How an agent meets an offer

- `GET /v1/challenge?action=write&client=agent` → `{ challenge, offers: [offer] }`. The agent may pay `offers[0]` or solve `challenge`.
- Protected route without a pass, request marked as an agent: **402** with `WWW-Authenticate: L402 macaroon="<macaroon>", invoice="<invoice>"` and a JSON body `{ "error": "payment_required", "challenge_url": "/v1/challenge?site=<site>&action=<cls>&path=<path>&client=agent&offers=0", "offers": [ … ] }`. Spec §4 holds: every 402 keeps a way to do the work, but as a link, not an inline challenge (PM ruling, 2026-09-30 CT). The challenge is minted only when the agent fetches `challenge_url` (root-relative to the issuer origin; `offers=0` returns `offers: []` so no second invoice is minted), so `challenge_minted` fires only on a real request and a paid write costs no work mint. In hardened mode that removes the Argon2id mint (~49 ms median server time) from every paid write; see `bench/results/paid-write-2026-09-30/`. `packages/agent` never fetches the challenge on the paid path; it fetches it only when it cannot pay (no payer, payment declined, offer over its limit) and work is allowed. `docs/settlement-vectors.json` `gate_cases` pin the body and header. Browsers and `toll.fetch` keep getting the 403 `toll_required` with a work challenge (spec §10), and a 403 never carries offers.
- "Marked as an agent" (Q2, built): `client=agent` in the query string or a `Toll-Client: agent` request header. The CORS preflight allows `toll-client`, and a 402 exposes `WWW-Authenticate`.
- No offer available (settlement off, degraded, or the challenge rate limit hit): an agent gets the same 403 as everyone else and can do the work instead. `packages/agent` does exactly that.
- The widget never sends `client=agent`, so visitors never see offers.

## 5. Macaroon (v1 draft) and proof of payment

L402-shaped: macaroon plus the preimage of the invoice's payment hash. After Amendment 1 (Q1) the real macaroon comes from the settlement engine. The HMAC token below survives only as the **stub engine's test credential** (the `macaroon` field on stub offers); it is not a macaroon and is never used outside stub mode:

```
caveats  = canonical_json({ v: 1, offer_id, site, cls, amount_msat, payment_hash, exp })
payload  = base64url(caveats)
macaroon = payload "." base64url( HMAC-SHA256( site_secret, "toll-offer-v1." + payload ) )
```

- `offer_id` and `payment_hash` are inside the MAC, so a cheap invoice cannot be presented against an expensive offer (invoice substitution, spec §16). The `"toll-offer-v1."` prefix separates these MACs from challenge and pass signatures made with the same secret.
- Verify without a node round-trip: `SHA256(preimage) == payment_hash` from the macaroon, compared in constant time.

## 6. Paid redeem

`POST /v1/redeem` with `{ "offer_id": "off_…", "kind": "ln402", "preimage": "<64 hex>", "macaroon": "…" }`.

Order: shape → macaroon MAC → `offer_id` matches the caveat → site → `now ≤ exp` → preimage hashes to `payment_hash` → claim `offer:<offer_id>` in the replay store (one invoice → one redeem → one pass; a replayed preimage gets 401 `replay`). Replay store down → 503 (fail closed).

Pass: same token format as work passes (docs/protocol.md §5) with `cls` from the caveat, **`n = 1` and `exp ≤ now + 60`** (spec §8.6.4 and §23), so one payment never buys a swarm 10,000 writes. Response `{ pass, exp, cls, rail: "settle" }`. The pass store tags the `jti` with `rail = settle` for metrics.

Then credit the ledger (§8), and add `amount_msat` to the `settled_msat` counter.

Built: `POST /v1/redeem` with `offer_id` → engine `verifyPaid` (in the stub: MAC, offer binding, site, expiry, preimage check, single use) → ledger credit (ref = `offer_id`) → settle pass (store tag `settle`) → `redeem_ok {rail: "settle"}` and `settled_msat`. Failures log `redeem_fail {rail: "settle", reason}`. No cookie is set: agents send the pass in `Authorization: Toll <pass>`. Verification needs no settler round trip, so a payment made before an outage still redeems during it. Pass shape: `pass_uses` is fixed at 1 (phase 3, spec §18 "settle pass single-use"; the config refuses any other value) and `pass_ttl_s` defaults to 60, max 60 (Q6). A paid redeem counts toward velocity for its coarse key, so with `adaptive.velocity` on a paying swarm sees `amount_msat` rise with the same multiplier as the work (docs/policy.md §6).

Error mapping: malformed body or preimage → 400 `malformed`; credential MAC or offer mismatch → 401 `bad_sig`; wrong site → 401 `wrong_site`; past `exp` → 401 `expired`; preimage does not hash to the payment hash → 401 `bad_solution`; second redeem of the same offer → 401 `replay`; replay store down → 503.

## 7. USD display

- FX source: one public rate (USD per BTC) cached for at most 15 minutes (spec §8.6.2). Phase 2 ships **no live source** (Q4 still needs a free, commercial-use source picked). Config `settlement.fx.source`:
  - `none` (default): USD is always hidden.
  - `fixed` with `usd_per_btc`: a **fixed test rate**, for the demo and tests only. It is not a market price. The demo uses **100000** so a write (10,000 msat) reads $0.01; the number was chosen to make the arithmetic obvious, not to track the market.
- `usd = amount_msat / 1e11 * usd_per_btc`.
- Owner totals: two decimals ("$12.40"), **rounded down** to the cent so a balance is never overstated; a non-zero amount under a cent is "less than $0.01" (docs/copy.md). `usdDisplay()` in `ledger.ts` returns nothing when the rate is missing or older than 15 minutes, so the screen hides the amount (demo: "—" / "Rate unavailable"; WordPress: "Balance will show again shortly") rather than blocking anything.
- Offer `display.usd`: 4 decimals, **rounded up** to $0.0001 (`offerUsd()` in `fx.ts`).
- This rounding rule is confirmed by the PM in docs/copy.md "Money" (tests: `tests/copy.test.ts`, vectors `usd_cases`).
- `{fee}` in owner copy is `feePercent(fee_bps)`: fee_bps / 100 with trailing zeros dropped (1000 → "10", 750 → "7.5", 25 → "0.25"); `fillFee()` in `ledger.ts`, PHP `Settlement::feePercent()` / `fillFee()` for the WordPress strings (copy only; no plugin code). Vectors `fee_display_cases`.
- Both formulas are integer-cent / integer-unit with a 1e-6 tolerance so Node and PHP print identical strings (vectors `usd_cases`).
- Offers still carry `amount_msat` when FX is down; only `display.usd` is dropped. `/v1/health` reports `usd_rate: "ok" | "unavailable"`.

## 8. Ledger (data model)

Integer msat only. One row per settled payment, recording **gross, fee and net**. The platform fee (default 10%, `fee_bps: 1000`) is **recorded and held**: in a self-hosted MVP there is no hosted processor to receive it, so nothing moves until phase 4 (PM decision, 2026-09-30).

```ts
interface LedgerEntry {
  id: number;
  site: string;
  at: number;                     // unix seconds
  kind: "credit" | "withdrawal";
  ref: string;                    // offer_id for credits (unique), withdrawal id for withdrawals
  gross_msat: number;             // what the client paid
  fee_bps: number;                // fee rate in force when recorded
  fee_msat: number;               // floor(gross_msat * fee_bps / 10000): rounding favours the owner
  net_msat: number;               // credits: gross - fee; withdrawals: minus the amount sent
}
// balance(site) = { gross_msat, fee_held_msat, net_credited_msat, withdrawn_msat, available_msat = net_credited - withdrawn }
```

Suggested SQL for a persistent store:

```sql
CREATE TABLE toll_ledger (
  id INTEGER PRIMARY KEY, site TEXT NOT NULL, at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('credit','withdrawal')),
  ref TEXT NOT NULL, gross_msat INTEGER NOT NULL, fee_bps INTEGER NOT NULL,
  fee_msat INTEGER NOT NULL, net_msat INTEGER NOT NULL,
  UNIQUE (kind, ref)
);
```

- A duplicate credit for the same `offer_id` is rejected (idempotent redeem).
- Owner screens show `available_msat` in USD: "$X.XX available to withdraw · after the 10% platform fee". The held fee is not shown as the owner's money.
- Example (from the unit test): 20 write payments of 10,000 msat → gross 200,000, fee held 20,000, net 180,000 msat.

Built: the issuer keeps a `MemoryLedger` per process (it resets on restart; the SQL above is for a persistent store, not built). Owner view: `toll.paid.balance()` → msat totals plus USD strings. The demo shows "Paid requests", "Usage value collected" (gross, USD) and the available balance (net, USD). The ledger is **not** on the public `/v1/health`.

## 9. Withdrawals (phase 2, MVP form)

The owner pastes a payout invoice under **Advanced settlement** and presses **Withdraw** (never "Send sats"). The amount is checked against `available_msat` before anything is sent ("That invoice is for more than your available balance."). On success, a `withdrawal` row is written. Real payouts need a real node and real funds, which need a separate approval; until then only the stub and regtest backends exist.

Status (phase 3): built for the test backend.

- **Owner API** on the Node issuer, off unless `settlement.owner_key` is set (16+ characters, `env:NAME` allowed). Server to server, `Authorization: Bearer <owner_key>`; wrong or missing key → 401; owner API off → 404.
  - `GET /v1/owner/balance` → `{available_msat, available_usd, fee_bps, paid_requests, degraded, collecting}`. `available_usd` is the owner string ("$0.02", "less than $0.01") or `null` when the rate is unavailable (hide the amount).
  - `POST /v1/owner/withdraw {invoice}` → `{ok: true, amount_msat, amount_usd}`. The invoice amount is checked against `available_msat` **before** anything is paid (`400 too_much`); an invoice the backend can't read is `400 bad_invoice`; backend down → `503 unavailable` and nothing is booked. On success a `withdrawal` row is written (ref = the invoice's payment hash) and `owner_withdrawal {amount_msat}` is logged.
  - `POST /v1/owner/offers {action, net?}` → `{offers, www_authenticate}` (or `{offers: []}` when paid requests are off, paused or the backend is down). The site relays these offers in its own 402 and uses `www_authenticate` as the header value as is, so it holds no credential or invoice code (Amendment 1 §F).
  - `POST /v1/owner/redeem {offer_id, kind, preimage, macaroon}` → `{ok: true, cls, amount_msat, fee_msat, net_msat}` after the settlement engine checks the proof (single use: a replay is `401 replay`) and the payment is booked in this ledger. The site then mints its own one-use, 60-second pass. `net` (both calls, optional) is the visitor's coarse network; offers are priced for it and a paid redeem counts toward its velocity, like this issuer's own 402 (docs/protocol.md, owner API). `POST /v1/owner/quote {action, net?}` gives the current price for that network without minting or counting anything.
  - The stub backend "pays" with `StubSettler.payOut()` (no network, no money). Real payouts need a real node and real funds, which need a separate approval.
  - The demo sets `owner_key: env:TOLL_OWNER_KEY` and, when the variable is unset, keeps a random key in `demo/.owner-key` (gitignored, mode 600) so a local WordPress can connect to `http://127.0.0.1:8787`.
- Tests: `tests/owner-api.test.ts` (off without a key, 401s, balance after fee, too_much before paying, bad invoice, single row, backend down).

### WordPress "Collect usage payouts" (option A, Oct 1, 2026): built

WordPress takes no payments itself, so the plugin has no payment backend code. Advanced settlement → Payment connection is **Test mode (no real money)** (default) or **Payment server**:

- **Test mode (work-only, Designer/PM Oct 1, 2026):** no payment server, so no offers, no balance and no withdrawals: agents do the background check. With payouts ticked, the Balance row shows the no-address warning ("Payouts start once a payment server address is added.") and Withdraw is disabled; a withdraw posted anyway is refused without reading the invoice, since withdrawals go only through a payment server and no PHP code reads an invoice (Amendment 1 §F). No request leaves the site. To try payouts, pick Payment server and point it at an issuer running the stub backend (the PM's "server running in test mode").
- **Payment server:** the address of a Toll issuer the owner runs, plus its owner key (stored in the non-autoloaded `toll_gate_server_key` option, never printed). The settings page calls `GET {address}/v1/owner/balance` on load (3 s timeout); withdrawals go to `POST {address}/v1/owner/withdraw`. No answer → the "isn't responding" notice, "—" over "Balance will show again shortly", and Withdraw disabled. `degraded: true` → the "Paid requests are paused" notice.
- **Agents (Payment server, payouts ticked, address set):** an agent request (`Toll-Client: agent` or `client=agent`) to a protected comment or wp-login.php form, the WooCommerce classic checkout (`?wc-ajax=checkout`) or a Contact Form 7 submit (REST feedback route or no-JS post) without a usable pass gets the Node 402: the plugin asks `POST {address}/v1/owner/offers {action}` (1.5 s timeout) and relays the offers and the `www_authenticate` value as they are, with `challenge_url` = `/wp-json/toll/v1/challenge?site=…&action=…&path=…&client=agent&offers=0`. `POST /wp-json/toll/v1/redeem {offer_id, kind, preimage, macaroon}` is forwarded to `POST {address}/v1/owner/redeem`, which checks the proof, books it once (a replay is `401 replay`) and answers with the class; the plugin then mints its own one-use, 60 s pass (no cookie). No answer, a slow answer, or a malformed one → no offers (agents get the 403 work check; the outage is remembered for 30 s) and a paid redeem is `503`, never `500`. Counters follow Node: `offer_shown` per 402, `paid` per paid redeem, `work_after_402` per `offers=0` challenge, `pass_absent` on 402 and 403, `turned_away` on 403 only. Checkout and Contact Form 7 (PM criteria, Oct 2, 2026): the pass is checked without spending first (CF7 REST, before CF7 runs), and the use is spent atomically only after the form's own checks pass (WooCommerce field and cart errors, CF7 validation), in `woocommerce_after_checkout_validation` and `wpcf7_spam`; a spend that loses a race is a 402 with no order and no mail. `pass_accept` counts only on that spend, into the same totals as comments and login, so a rejected try resubmitted with the same pass adds no extra `pass_accept`, 402 or `offer_shown`. A use spent at checkout stays spent if the payment gateway then declines the card, by design; the same pass then gets the 402. WooCommerce still records its usual failed order for the decline, and its own pending-order timeout releases any held stock; the plugin adds nothing there. **The WooCommerce block checkout (Store API, `/wc/store/v1/checkout`) isn't covered yet**: the plugin registers nothing for it, so agents and people get stock behavior (no 402, no 403); a frontend check for it, then the gate, is a later ticket. The payment server prices WordPress offers: the plugin sends each visitor's coarse network (`net`, never the address; `TOLL_TRUSTED_PROXIES` in wp-config.php decides when `X-Forwarded-For` is read), so with velocity on there the relayed offers rise with that network's load like the server's own 402.
- Nothing payout-related runs unless "Collect usage payouts" is ticked (a paid redeem for an offer already shown is still forwarded while the Payment server address is set). Tested against the local Node demo in stub mode and a stand-in server for the failure cases (`tests/wp.test.ts`, `tests/wp-agent.test.ts`).

## 10. Backends

```yaml
settlement:
  enabled: false        # default; phase 2 turns it on in the demo against the stub/regtest
  backend: stub         # stub | regtest | nwc | lnd_rest | hosted
  nwc_uri: env:TOLL_NWC # never shipped to browsers; CI fails if it appears in widget dist
  fee_bps: 1000
```

- `stub` (`StubSettler` + `StubEngine`): **built**, no network. Fake `lnstub1…` invoices, `payment_hash = SHA256(preimage)`, a `pay()` helper acting as the test client's wallet, optional shared test preimage, a deterministic mode for vectors, and a switch to simulate an outage. The stub engine's key is `HMAC-SHA256(site secret, "toll/settlement/stub/v1")`, so its seals never share a key with challenges or passes. CI uses only this. The demo mounts a test-only payer at `POST /demo/stub-pay {invoice} → {preimage}` (stub backend only).
- `regtest` / proxy engine: **deferred**. The optional Aperture + regtest path needs Go, LND and bitcoind running locally, which is not cheap enough for this pass. The `SettlementEngine` interface is the seam: a proxy-backed engine replaces `StubEngine` in `createPaidRail()` without touching the HTTP layer.
- `nwc`, `lnd_rest`: self-host options; not built; need approval before any real funds.
- `hosted`: phase 4.

`normalizeConfig` accepts `settlement.enabled: true` only with `backend: stub`; any other backend fails at startup with "not available in this build". Defaults: `fee_bps: 1000`, `pass_uses: 1`, `pass_ttl_s: 60` (max 60), `offer_ttl_s: 120` (max 120), `fx.source: none`.

`/v1/health` with settlement on: `{ ok, v, settlement: "stub", settlement_degraded, usd_rate }`. `"stub"` extends the spec's `off | regtest | live` enum for the test backend; reporting `regtest` would be false.

## 11. Degraded mode

If the backend fails health checks or invoice minting fails: keep issuing work challenges, return `offers: []`, log `{"event":"settlement_degraded","reason":…}` and bump the `settlement_degraded` counter (once per transition, not per request), and never return 500 for the site. Built and tested; agents get the 403 work challenge instead of a 402. Writes remain possible through work (spec §8.6.8). The demo's mode tag reads "test payments paused" and WordPress shows the `notice-warning` from docs/copy.md.

## 12. Metrics (already in the counters line)

`settled_msat` (sum of gross msat settled), `offer_shown` (402 responses that carried offers; one `offer_shown {cls, amount_msat, offers}` event each, never the offer itself) next to `paid` (successful paid redeems), `settlement_degraded` (count), and `rail`/`cls` tags on `redeem_ok` and `pass_accept`. `offer_shown` vs `paid` is the pay-vs-grind conversion signal; `/v1/challenge?client=agent` responses are not counted. `challenge_minted` counts only challenges actually minted (a 403's inline challenge, or a fetched `challenge_url`); a paid write logs none. A request with no pass logs `pass_absent {action, status}` (status 402 or 403), not `pass_reject`, so rejection rates count only real rejections (expired, spent pass replayed, invalid, wrong site or class); `turned_away` counts gate 403s (the demo's "Rejected" figure), never agent 402s. `work_after_402` counts `challenge_url` fetches (`/v1/challenge?offers=0`, event `work_after_402 {action, site, cls}`): agents that chose work over paying after a 402; abandoned 402s = `offer_shown` − `paid` − `work_after_402` (docs/protocol.md §7). All are 0 or absent of `settle` rows while settlement is off. A booked mint-quote loss that later stores its proofs is reversed once: Node counts `mint_quote_reversals` and `mint_quote_reversed_sats` (event `mint_quote_reversed {quote, amount}`), and `/demo/stats` on Node and the edge carries `reversals` and `reversed_sats` (all-time; the edge keeps them in `cashu_meta` rows).

## 12a. Owner switch (demo-only working toggle)

The demo's "Collect usage payouts" checkbox calls `POST /demo/payouts {collect: bool}` (JSON only) → `rail.setCollecting()`. Unticked: no new offers, so agents get the 403 work challenge and `agent-pay` does the work; the mode tag reads "work-only" (not "test payments paused", which is only for a failing backend); no `settlement_degraded` is logged; the balance stays visible. Offers already issued can still be redeemed. Ticked: offers return. The setting is in memory and resets to `settlement.enabled` on restart. The PM confirmed the toggle (2026-09-30). The WordPress checkbox is still the TODO in §9.

## 13. Logging and secrets

Never log preimages, macaroons, invoices after payment (bolt11), NWC URIs or node macaroons. Settlement secrets stay server-side.

## 14. Phase 2 test plan (spec §19): all built

- §19.9: `docs/settlement-vectors.json` (`npm run vectors:settlement`, deterministic): price (Q3), fee (Q5), USD (Q4), offer → test invoice → preimage → settle pass, and rejections (wrong preimage, substituted credential, tampered credential, expired offer, wrong site, malformed preimage, replay). Node runs all of it. PHP runs what a PHP host computes: price, fee, USD strings, preimage check, settle pass token and expiry. Offer credentials are verified only at the issuer, so the rejection and replay cases are Node only.
- §19.10: `npm run agent-pay -- --writes 5` (or `node demo/agent-pay.mjs --writes 20`) against the demo: N paid writes accepted, replayed preimage rejected, spent pass refused, ledger totals printed. Also run inside `tests/settlement-http.test.ts` and the phase 2 browser test.
- §19.11 stays green: settlement off → widget flow works and `offers` is empty (already tested).
- Degraded mode: stub outage → offers empty, work writes accepted, `settlement_degraded` logged, no 500.

## 15. Decisions and open questions

Decision log, 2026-09-30 (CT). Amendment 1 (in force 7:55 PM CT) changes how this rail is built: Toll wraps an existing settlement engine instead of writing its own. The engine is now chosen: the L402 reverse proxy described in `docs/adapters.md` §2, with Toll as its price source. Phase 2 (2026-09-30) builds the rail against the `SettlementEngine` interface with the stub engine only; the proxy client still refuses anything but stub mode. The former `offer.ts` HMAC token survives only as the stub engine's sealed test credential, not as a macaroon.

- **Q1. Macaroon format: DECIDED by Amendment 1.** The settlement engine supplies the macaroon (Amendment 1 §B and §F: no new macaroon format). The Toll HMAC token in `packages/settlement-ln` is retired with the from-scratch stack. The library survey the EM asked for was stopped when the amendment landed and is not needed.
- **Q2. 402 vs 403: DECIDED (PM).** A request that identifies as an agent (`Toll-Client: agent` header or `client=agent`) gets `402` with `WWW-Authenticate: L402`. Everything else gets `403 {"error":"toll_required"}`.
- **Q3. Sub-sat amounts: DECIDED (PM).** Offers round up to a whole sat (`amount_msat` is always a multiple of 1,000).
- **Q4. FX source: DECIDED (PM).** Use one free public rate source whose terms allow commercial use, and hide USD when it is down (spec §8.6). Do not sign up for a paid source; if the only good source is paid, flag it for a later decision. *Built:* the hide-when-down behaviour and a fixed test rate for the demo. *Not done:* naming the live source and checking its terms; until then production configs use `fx.source: none` (USD hidden).
- **Q5. Fee rounding and display: DECIDED (PM).** The fee rounds down on each payment (owner-favourable, as implemented). The MVP UI shows no held-fee amount; Advanced shows "10% · recorded on each payment".
- **Q6. Agent pass shape: DECIDED (PM).** Keep the §8.6 default: one use or a 60-second expiry. More uses per pass is a config option only. *Reconciled for phase 3 (2026-10-01 CT):* spec §18 phase 3 says "settle pass single-use", so `pass_uses` is now fixed at 1 (the multi-use config option is withdrawn) and the pass also expires within 60 s. Both halves of §8.6.4 hold.
- **Q7. Where the held fee goes in phase 4: OPEN (phase 4).** Options include a hosted processor, batching, or a partner for owner payouts. Not needed for phase 2.
- **Q8. "Dashboard" in the owner-block copy: DECIDED (PM).** The owner-block lines stay word for word. "Dashboard" means WP admin, where Advanced settlement lives. `docs/copy.md` never mentions the hosted dashboard (phase 4).

### Deferred (waits for real traffic)

- **D1.** With the current rules a client over the work cap still gets the work option, so it never has to pay. Should a high-velocity, over-cap client ever be offered payment only? It touches spec §9.5 ("never hard-block humans") and needs real traffic data first. See `docs/policy.md` §5.

## 16. Test-only Cashu option (2026-10-29)

Luke approved this on 2026-10-28. It is off unless `settlement.cashu.enabled` is true. Config accepts it only in test mode: `settlement.enabled` and `backend: stub`, with `mode` unset or `test`. Any other backend or `mode: live` fails at startup with "only available in test mode". `settlement.cashu.mint` must be a loopback `http` origin with no path. A host that is not loopback fails with "host must be loopback"; a path on an otherwise valid URL fails with "must not include a path". There is no real mint and no live payout.

When it is on, the issuer uses `CashuTestEngine` instead of the Lightning stub for new offers. An agent request gets **402** with `X-Cashu: creqA…` (NUT-18 payment request, no transport, so the payment is in-band per NUT-24) and the same JSON body as §4 (`error`, `challenge_url`, `offers`). The offer `kind` is `cashu`. `offers[0].request` is that header value. Browsers still get the 403 work check.

A retry that sends `X-Cashu: cashuA…` (NUT-00 V3) or `X-Cashu: cashuB…` (NUT-00 V4) is not a local hash check. The engine parses the token, then `POST {mint}/v1/swap` on the configured test mint. The in-repo fake mint (`startTestMint`) records proofs it issued at `POST /test/mint` and spends them on that swap. Success mints the same settle pass as Lightning: **one use, at most 60 seconds**. The same token again is **401 `replay`** because the mint reports the proofs already spent. A second issuer, with an empty replay store, gets the same `401 replay` for that token: the refusal comes from the mint, not from the first issuer's local single-use record. A token the mint did not issue is `bad_solution`. A `creqA` string is not a payment. A token that does not decode, a wrong unit, or a mint other than the test mint is `400 malformed`.

If the mint does not answer `/v1/info`, the rail is unhealthy: `offers` is empty, the agent gets **403** with the work challenge, and a solved challenge still redeems. A presented token while the mint is down does not mint a pass (fail closed).

`@lessspam/agent` exports `testMintPayer(mint)`, which asks `POST /test/mint` for a `cashuB` token and redeems it at `POST /v1/redeem` with `{ offer_id, kind: "cashu", token, credential }`. The MCP schema is unchanged. The PHP library and the WordPress relay forward `X-Cashu` (§17).

Tests: `tests/settlement-cashu.test.ts`.

## 17. Cashu receive (2026-10-29)

The test path in §16 is unchanged: `settlement.cashu.mint` is still a loopback `http` URL with no path, and `CashuTestEngine` still only spends proofs on that mint. A second shape turns on receive against real mints. It stays off when the allowlist is empty. `settlement.backend` stays `stub`. `mode: live` still fails at startup. Nothing here pays out, and no mint is contacted unless the allowlist names it.

```yaml
settlement:
  enabled: true
  backend: stub
  cashu:
    enabled: true
    mints:
      - https://mint.minibits.cash/Bitcoin
    store: env:TOLL_CASHU_STORE
```

`settlement.cashu.mints` is the allowlist. Each entry must be `https`, with no userinfo, query, or fragment. The path is part of the mint (`https://mint.minibits.cash` is not a mint). A loopback, private, or link-local host is refused even if it is listed. At request time the host is resolved and a private address is refused again, and redirects are not followed. `settlement.cashu.store` is the file that keeps the proofs the operator receives (mode 0600). `env:NAME` is allowed for the path. The file holds secrets. It is not logged.

An agent 402 is still `X-Cashu: creqA…`. A `cashuA` or `cashuB` token is decoded. Several V3 entries from one mint are merged; two mints in one string are refused. A short keyset id (the first 8 bytes of a version-01 id, 16 hex chars) is mapped to the mint's full id from `GET /v1/keysets` before `POST /v1/swap`. The swap's outputs are new proofs this process can spend. Those proofs and a hash of each spent input are written before the pass is minted. The same token after a restart is `401 replay` from that file, and a second issuer with an empty file is `401 replay` because the mint already spent the proofs. If the mint does not answer, offers are empty and the agent gets the work challenge. A token presented while the mint is down does not mint a pass. Change from a larger source is `cashuB`.

`@lessspam/agent` exports `cashuPayer({ token } | { proofs, mint })` beside `testMintPayer`. The source token may be `cashuA` or `cashuB`. An exact amount is sent as it arrived. When the source is larger, the payer swaps at the mint and the payment and the leftover are `cashuB` strings (`onChange` receives the leftover). The worked example is in docs/adapters.md.

The PHP library (`Settlement::relayPayment`, `forwardRedeem`, `presentedCashu`, `forwardPresented`) and the WordPress relay copy `X-Cashu` on the 402, forward a redeem that carries `token` and `credential`, and forward an `X-Cashu` retry to `POST /v1/owner/cashu`.

Tests: `tests/settlement-cashu-receive.test.ts` (loopback mint, version-01 keyset, short ids). `tests/php/run-cashu-relay.php`.

The site worker (`toll-site`, root `wrangler.toml`) uses the same receive engine. Its allowlist is `CASHU_MINTS`, set to `https://mint.minibits.cash/Bitcoin`. Proofs, spent inputs and in-flight swaps are rows in the existing `TOLL_STORE` Durable Object, so one instance serialises them. Blinded outputs are written before `POST /v1/swap`. A non-200 from that swap leaves the row pending. The row is deleted only when `POST /v1/restore` (NUT-09) returns an empty signature list and `POST /v1/checkstate` (NUT-07) reports every input unspent. A mint error code does not make that decision. Any signature restore returns is stored. The next request and the object's alarm both apply that same rule. A signature the mint already returned is stored at once. The request that owns the row holds a lease, renewed before each mint call, for seven calls at the per-call timeout plus margin. A sweeper does not delete a row until that lease has expired. DNS for a mint call shares that call's timer. An inconclusive restore or checkstate is logged with the HTTP status and the response shape (field names, counts, and states), not the proofs. A mint 4xx other than a replay is `bad_solution`, including a refusal that is not JSON. A 429 or a 5xx stays an outage. Each mint call is logged with its path and status, not the proofs. `scripts/check-live-state.sh` reads the gate tool's payment status and posts with the agent header, expecting 402. The gate is granted only after those new proofs are stored. `GET /v1/health` reports `settlement: "cashu"`. The manifest's gate tool lists Cashu. Agents get a 402 with `X-Cashu: creqA…`. Everyone else still gets the work check. No payout, no new binding, and no deploy from this tree.

Not in this build: Toll does not return change on the 402 (the payer splits first). Swap signatures are not checked with a DLEQ proof. Spending the stored proofs onward is not built. The Node file store still uses a per-process lock; the edge store does not.

## 18. Production quote offer (off unless L402_ENABLED=1)

Luke approved this on 2026-10-31. Cashu stays the first offer. The quote offer is the second. It is a NUT-04 mint quote on the same allowlisted mint, paid by the client as a BOLT11 invoice. Toll does not run a Lightning node. The flag is `L402_ENABLED`. The only on value is `1`. Unset, `0`, or anything else leaves the 402 exactly the cashu offer: `X-Cashu` and no `WWW-Authenticate`. `TOLL_TEST_HOOKS` stays unset in production. It still selects the loopback invoice used by the test mint. The production flag is separate, and it wins when both are set.

The invoice is decoded (BOLT 11 checksum, tag `p`, human-readable amount). The amount must be the price, on `lnbc`. The loopback stand-in does not decode and is refused on this path. The macaroon seals that payment hash with the price, the action, and the expiry. The client retries with `Authorization: L402 <macaroon>:<preimage>`. `SHA256(preimage)` must equal the sealed hash. A payer that settles inside the same mint gets no preimage back. `Authorization: L402 <macaroon>` with the preimage omitted, or with nothing after the colon, is accepted only when this process checks the mint and the quote state is `PAID`. A forged macaroon is `401`. An unpaid quote presented that way is `401 bad_solution`. The preimage path is unchanged.

The mint must report the quote `PAID`. `ISSUED` is not payment when this store has no row. Toll blinds the outputs and reserves that row, secrets and blinding factors included, in one Durable Object transaction before `POST /v1/mint/bolt11`, then writes the proofs in one later call (`finishMintQuote`). A second reservation while that lease is held is `401 replay`, so concurrent retries mint once. A mint error that leaves the quote `PAID`, and a restore that shows those outputs were not signed, deletes the row. The same macaroon can be presented again and passes once. A lost response leaves the row. The next presentation sends the same outputs to `POST /v1/mint/bolt11` and, if that does not return signatures, to `POST /v1/restore`. If the quote is `ISSUED` and neither call returns signatures, the response is `503` with detail `mint signed; signatures were not recovered`, the loss stays, and the outputs stay. A second presentation after the proofs are stored is `401 replay`. A forged preimage is `401 bad_solution` and does not mint. The manifest lists `l402` only when the flag is `1` and the mint's `/v1/info` answered. It does not create a quote just to decide that.

The site worker's `POST /v1/demo/agent` is that offer for a client that does not send an agent header. An unpaid post gets the 402. A paid post gets the pass. `/.well-known/toll.json` lists the absolute URL as `pay`. `POST /demo/contact` without that header stays the work check.

Node reads the same environment variable, not a config key. `settlement.cashu.mints` is the allowlist and `settlement.cashu.store` is still required. `settlement.backend` stays `stub`. `mode: live` still fails at startup. `settlement.cashu.mint` stays the loopback test mint. The site worker sets `L402_ENABLED = "1"` in `wrangler.toml`. `TOLL_TEST_HOOKS` stays unset there. This tree does not deploy. A Node issuer still reads the environment variable and does not turn the offer on unless that variable is `1`.

The site worker config already sets the flag. Publishing that config is a deploy, and this tree does not deploy. A Node issuer still needs the environment variable.

To publish it, after a verifier has passed and someone who may deploy chooses to:

1. Leave `TOLL_TEST_HOOKS` unset. Leave `mode: live` unset. Do not change `CASHU_MINTS` (the site worker already lists `https://mint.minibits.cash/Bitcoin`).
2. Deploy the site worker. Its config already sets `L402_ENABLED` to `1`. On a Node issuer, export `L402_ENABLED=1` in the process environment that already has `settlement.cashu.mints` and `settlement.cashu.store`.
3. Confirm `GET /.well-known/toll.json` lists `l402` on the gate tool and a `pay` URL, and `POST /v1/demo/agent` returns `402` with both `X-Cashu` and `WWW-Authenticate: L402`.
4. Optional one-shot check, at most 10 sat: `L402_BASE` is the issuer origin, `L402_WALLET` reads one invoice on stdin and writes a 64-hex preimage, or nothing, on stdout. An empty stdout sends the macaroon alone. Neither value is printed. `scripts/l402-live-check.sh 10` pays once and prints `ok` and the sat amount. A cap above 10 is refused before any payment. Each run pays again.

Not done: the agent package does not pay this offer by itself. Invoice signatures are not recovered. Spending the stored proofs onward is still not built.
