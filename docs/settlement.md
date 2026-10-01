# Settlement rail (draft for phase 2)

Status: **draft**, written alongside phases 0-1 so phase 2 does not invent a second protocol (spec §22). Nothing here is wired into the issuer yet: `GET /v1/challenge` returns `offers: []`, `/v1/health` says `"settlement": "off"`, and a paid redeem gets `400 unsupported`. The stub pieces below exist in `packages/settlement-ln/` with unit tests (`tests/settlement-stub.test.ts`).

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
- `amount_msat`: integer. `display.usd` is computed from a cached FX rate (§7); it is omitted when FX is unavailable. Never hardcode a USD value (the spec's `"0.004"` example was a placeholder).
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

`velocity_mult` and `suspicion_mult` are the same values the work policy uses for this request (`packages/protocol/src/policy.ts`), so difficulty and price move together (spec §6.7). Velocity is off until phase 3, so phase 2 prices are the base table.

## 4. How an agent meets an offer

- `GET /v1/challenge?action=write&client=agent` → `{ challenge, offers: [offer] }`. The agent may pay `offers[0]` or solve `challenge`.
- Protected route without a pass, request marked as an agent: **402** with `WWW-Authenticate: L402 macaroon="<macaroon>", invoice="<invoice>"` and a JSON body `{ "error": "payment_required", "challenge": {…}, "offers": [ … ] }`. Browsers and `toll.fetch` keep getting the 403 `toll_required` with a work challenge (spec §10). See open question Q2 for how a request is "marked as an agent".

## 5. Macaroon (v1 draft) and proof of payment

L402-shaped: macaroon plus the preimage of the invoice's payment hash. v1 uses a Toll HMAC token instead of a libmacaroons-format macaroon (see Q1):

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

Implemented in the stub (`verifyPaidRedeem`): MAC, offer binding, site, expiry, preimage check and single use. Not yet: the HTTP route, the short pass, the ledger write, metrics.

## 7. USD display

- FX source: one public rate (USD per BTC) cached for at most 15 minutes (spec §8.6.2). Which source is open (Q4).
- `usd = amount_msat / 1e11 * usd_per_btc`.
- Owner totals: two decimals ("$12.40"); a non-zero amount under a cent is "less than $0.01" (docs/copy.md). `usdDisplay()` in `ledger.ts` implements this and returns nothing when the rate is missing or older than 15 minutes, so the screen hides the amount (demo: "—" / "Rate unavailable"; WordPress: "Balance will show again shortly") rather than blocking anything.
- Offers still carry `amount_msat` when FX is down; only `display.usd` is dropped.

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

## 9. Withdrawals (phase 2, MVP form)

The owner pastes a payout invoice under **Advanced settlement** and presses **Withdraw** (never "Send sats"). The amount is checked against `available_msat` before anything is sent ("That invoice is for more than your available balance."). On success, a `withdrawal` row is written. Real payouts need a real node and real funds, which need Luke's approval; until then only the stub and regtest backends exist.

## 10. Backends

```yaml
settlement:
  enabled: false        # default; phase 2 turns it on in the demo against the stub/regtest
  backend: stub         # stub | regtest | nwc | lnd_rest | hosted
  nwc_uri: env:TOLL_NWC # never shipped to browsers; CI fails if it appears in widget dist
  fee_bps: 1000
```

- `stub` (`StubSettler`): no network. Fake invoices, `payment_hash = SHA256(preimage)`, a `pay()` helper acting as the test client's wallet, optional shared test preimage, and a switch to simulate an outage. CI uses only this.
- `regtest`: optional, Polar-style local nodes. Never mainnet in CI; no mainnet keys in fixtures.
- `nwc`, `lnd_rest`: self-host options; not built; need approval before any real funds.
- `hosted`: phase 4.

Today `normalizeConfig` refuses `settlement.enabled: true` so nobody turns on a half-built rail.

## 11. Degraded mode

If the backend fails health checks or invoice minting fails: keep issuing work challenges, return `offers: []`, log `{"event":"settlement_degraded","reason":…}` and bump the `settlement_degraded` counter, and never return 500 for the site. Writes remain possible through work (spec §8.6.8). The demo's mode tag reads "test payments paused" and WordPress shows the `notice-warning` from docs/copy.md.

## 12. Metrics (already in the counters line)

`settled_msat` (sum of gross msat settled), `settlement_degraded` (count), and `rail`/`cls` tags on `redeem_ok` and `pass_accept`. All are 0 or absent of `settle` rows while settlement is off.

## 13. Logging and secrets

Never log preimages, macaroons, invoices after payment (bolt11), NWC URIs or node macaroons. Settlement secrets stay server-side.

## 14. Phase 2 test plan (spec §19)

- §19.9: `docs/settlement-vectors.json` (offer → invoice → preimage → pass; wrong preimage, substituted invoice, expired offer, replayed preimage), passing on Node and PHP.
- §19.10: `demo/agent-pay.mjs` with the stub: 5 sequential paid writes accepted, replayed preimage rejected; the demo also shows the 20-write run.
- §19.11 stays green: settlement off → widget flow works and `offers` is empty (already tested).
- Degraded mode: stub outage → offers empty, work writes accepted, `settlement_degraded` logged, no 500.

## 15. Open questions (need a product or engineering decision before phase 2 ships)

- **Q1. Macaroon format.** Toll HMAC token (simple, done in the stub) or real libmacaroons-format macaroons so existing L402 clients and proxies work unmodified? Interop argues for real macaroons; it adds a dependency on both Node and PHP.
- **Q2. 402 vs 403.** Spec §4 says agents get 402; §10 says `toll.fetch` handles 403 `toll_required`. Proposal: 402 + `WWW-Authenticate: L402` only when the request says it is an agent (`Toll-Client: agent` header or `client=agent`), 403 otherwise. Needs a yes.
- **Q3. Sub-sat amounts.** Base prices are whole sats today, but velocity/suspicion multipliers can produce sub-sat msat amounts that some wallets round. Round offers up to a whole sat?
- **Q4. FX source.** Which public rate source, and is a single source acceptable (spec says hide USD rather than block when it is down)?
- **Q5. Fee rounding and display.** Fee rounds down per payment (owner-favourable). Should the held fee be visible to the owner anywhere (e.g. an Advanced line), or only in the ledger?
- **Q6. Agent pass shape.** Spec allows "n=1 or exp ≤ 60s"; the draft does both. Confirm both, or allow n>1 with a 60s expiry for bursty-but-paying clients?
- **Q7. Where the held fee goes in phase 4** (hosted processor, batching, partner for owner payouts). Not needed for phase 2.
- **Q8. Copy conflict with the phase 4 dashboard (for the PM).** `docs/copy.md` (Demo strings, Owner block, and WordPress "Usage payouts") keeps the §18 helper "High-volume clients can pay per request. You withdraw from the dashboard." The hosted dashboard is now phase 4, so in the MVP there is no dashboard to withdraw from: withdrawals happen under **Advanced settlement** on the WordPress settings page (and nowhere in the demo). The owner block is not rendered in phase 1, so nothing ships with the old line yet. The PM needs to reword it in `docs/copy.md` before phase 2. The code will pick up the new string from there.
