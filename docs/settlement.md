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
- Protected route without a pass, request marked as an agent: **402** with `WWW-Authenticate: L402 macaroon="<macaroon>", invoice="<invoice>"` and a JSON body `{ "error": "payment_required", "challenge": {…}, "offers": [ … ] }`. Browsers and `toll.fetch` keep getting the 403 `toll_required` with a work challenge (spec §10), and a 403 never carries offers.
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

Built: `POST /v1/redeem` with `offer_id` → engine `verifyPaid` (in the stub: MAC, offer binding, site, expiry, preimage check, single use) → ledger credit (ref = `offer_id`) → settle pass (store tag `settle`) → `redeem_ok {rail: "settle"}` and `settled_msat`. Failures log `redeem_fail {rail: "settle", reason}`. No cookie is set: agents send the pass in `Authorization: Toll <pass>`. Verification needs no settler round trip, so a payment made before an outage still redeems during it. Pass shape is config (`pass_uses` default 1, `pass_ttl_s` default 60, max 60; Q6).

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

The owner pastes a payout invoice under **Advanced settlement** and presses **Withdraw** (never "Send sats"). The amount is checked against `available_msat` before anything is sent ("That invoice is for more than your available balance."). On success, a `withdrawal` row is written. Real payouts need a real node and real funds, which need Luke's approval; until then only the stub and regtest backends exist.

Status: `MemoryLedger.withdraw()` (balance check, withdrawal row) exists and is unit-tested. **No withdrawal screen or endpoint is built**: the owner screen for it is WordPress Advanced settlement, which waits for the payouts decision below.

### WordPress "Collect usage payouts": TODO, blocked on Luke's A/B payouts decision

Spec §18 puts a WP settings checkbox "Collect usage payouts" (helper "High-volume clients can pay per request. You withdraw from the dashboard.") in phase 2. **Not built** on purpose: Luke's choice between payout options A and B is still pending, and it decides what the checkbox turns on and where withdrawals go. Nothing was added to the WordPress plugin. When the decision lands: add the checkbox (off by default) and the balance block per `design/proto/wp-settings.html` and docs/copy.md "WordPress strings", backed by the issuer's `settlement.enabled` and `toll.paid.balance()`. The demo's owner block shows the same checkbox read-only, reflecting `demo/toll.yaml`.

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

`settled_msat` (sum of gross msat settled), `offer_shown` (402 responses that carried offers; one `offer_shown {cls, amount_msat, offers}` event each, never the offer itself) next to `paid` (successful paid redeems), `settlement_degraded` (count), and `rail`/`cls` tags on `redeem_ok` and `pass_accept`. `offer_shown` vs `paid` is the Data Scientist's pay-vs-grind conversion signal; `/v1/challenge?client=agent` responses are not counted. All are 0 or absent of `settle` rows while settlement is off.

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

- **Q1. Macaroon format: DECIDED by Amendment 1 (Luke).** The settlement engine supplies the macaroon (Amendment 1 §B and §F: no new macaroon format). The Toll HMAC token in `packages/settlement-ln` is retired with the from-scratch stack. The library survey the EM asked for was stopped when the amendment landed and is not needed.
- **Q2. 402 vs 403: DECIDED (PM).** A request that identifies as an agent (`Toll-Client: agent` header or `client=agent`) gets `402` with `WWW-Authenticate: L402`. Everything else gets `403 {"error":"toll_required"}`.
- **Q3. Sub-sat amounts: DECIDED (PM).** Offers round up to a whole sat (`amount_msat` is always a multiple of 1,000).
- **Q4. FX source: DECIDED (PM).** Use one free public rate source whose terms allow commercial use, and hide USD when it is down (spec §8.6). Do not sign up for a paid source; if the only good source is paid, flag it for Luke. *Built:* the hide-when-down behaviour and a fixed test rate for the demo. *Not done:* naming the live source and checking its terms; until then production configs use `fx.source: none` (USD hidden).
- **Q5. Fee rounding and display: DECIDED (PM).** The fee rounds down on each payment (owner-favourable, as implemented). The MVP UI shows no held-fee amount; Advanced shows "10% · recorded on each payment".
- **Q6. Agent pass shape: DECIDED (PM).** Keep the §8.6 default: one use or a 60-second expiry. More uses per pass is a config option only.
- **Q7. Where the held fee goes in phase 4: OPEN (Luke, phase 4).** Options include a hosted processor, batching, or a partner for owner payouts. Not needed for phase 2.
- **Q8. "Dashboard" in the owner-block copy: DECIDED (PM).** The owner-block lines stay word for word. "Dashboard" means WP admin, where Advanced settlement lives. `docs/copy.md` never mentions the hosted dashboard (phase 4).

### Deferred (waits for real traffic)

- **D1 (Data Scientist, for Luke).** With the current rules a client over the work cap still gets the work option, so it never has to pay. Should a high-velocity, over-cap client ever be offered payment only? It touches spec §9.5 ("never hard-block humans") and needs real traffic data first. See `docs/policy.md` §5.
