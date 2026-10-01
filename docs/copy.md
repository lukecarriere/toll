# Toll: words we will and will not say (`docs/copy.md`)

Owner: Product Manager. Sources: SPEC.md §1, §10, §13, §18, §20; PRD §2; design/HANDOFF.md §1–3. SPEC.md wins on any conflict.
Engineering: copy this file to `docs/copy.md` in the repo. The copy lint reads the "Lint list" below.

## Where these rules apply
Public surfaces: `README.md`, widget strings, demo pages, WordPress plugin screens and notices (including Advanced settlement), package names, the public repo description, and commit titles for user-facing files.
Exempt (may use protocol words): `docs/settlement.md`, `docs/settlement-vectors.json`, `packages/settlement-ln/`, code identifiers, and the JSON wire format (for example `amount_msat`, `ln402`, `rail`).

## Lint list (case-insensitive, whole words, CI fails on any hit in a public surface)
From §19.12: bitcoin, btc, satoshi, lightning, l402, wallet.
Added from §1 (PRD §6 testing bar): sats, sat, on-chain, onchain, seed phrase, orange pill, softwar, energy money, proof-of-compute, geopolitics, ai slop, we detect ai.
Also fail on any percentage next to "human", "bot" or "AI" (a risk score as identity, for example "12% human").

## Avoid on default screens (review, not lint)
bot score, human, AI, crypto, token (except the code name `toll-pass`), mining, hash, "I am not a robot" (except the exact checkbox-mode string below), monetary theory of any kind.

## Allowed public framing (§1)
- Stop form spam and automated abuse
- High-volume clients pay more; a person pays once
- Invisible check for real visitors
- No puzzles, no tracking pixels
- Collected usage value is paid out to you
- Agents can pay per request instead of grinding

## Money
- Always USD from the live FX rate (cached ≤ 15 min). Never hardcode "0.004".
- Totals use two decimals: "$12.40". A non-zero amount under a cent: "less than $0.01".
- FX down: hide the amount. Demo shows "—" with "Rate unavailable"; WordPress shows "Balance will show again shortly".
- Never show msat, coin units, invoices or rail names on a default surface.

## README (§20, exact top)
```
Toll
Invisible checks for forms, logins, and write APIs.
High-volume clients pay more. People don't notice.
```
Then install lines (npm / composer / wp plugin / wrangler), a ten-line how it works (background work, a pass, optional usage payouts for operators), privacy, and a protocol link. Optional last line only: *Machine-payable requests settle over an open payment network. Operators can withdraw.*

## Widget strings (exact; `…` is U+2026)
| Use | String |
|---|---|
| Working (≥ 500ms) | Checking… |
| Done after a visible check | Verified |
| Checkbox mode button / accessible name | Verify before sending |
| Error | Couldn't check this form. |
| Error action | Try again |
| No JavaScript | This form needs JavaScript. |

## Demo strings (exact)
- Top bar: Toll demo · Forms · Bot hammer · Agent hammer
- Mode tag: work-only (Phase 1) · test payments on (Phase 2) · test payments paused (settlement degraded)
- Forms intro: Every form on this page is protected
- No-pass card: Try it without a pass · button "Send without a pass" · result "✕ Rejected · 403"
- Hammer runs: 50 writes without the check · 50 writes with the check · Run 50 · grid label "N of 50 accepted"
- Stats, Phase 1: Accepted · Rejected · Mean solve time ("312 ms")
- Stats, Phase 2 adds: Paid requests · Usage value collected
- Owner block: Collect usage payouts · helper "High-volume clients can pay per request. You withdraw from the dashboard." · balance "$X.XX" over "available to withdraw · after the 10% platform fee"

## WordPress strings (exact)
- Menu: Settings → Toll. Line under title: Challenges issued today: N
- **Protect these forms.** "Visitors get an invisible check. Forms that skip it are rejected." Options: Comments · Login · Registration · Lost password · WooCommerce checkout "(WooCommerce is active)" · Contact Form 7 forms · Any form with `data-toll`, help "Always on. Add `data-toll="write"` to a form in your theme to protect it."
- **Visible check.** "Show a "Verify before sending" button instead of an invisible check" · help "Off by default. Most sites don't need it."
- **Longest check.** 4 / 8 / 12 seconds · help "If a check would take longer, the visitor gets a "Verify before sending" button instead of waiting."
- **Keys.** Site key · Secret · Show · Generate new secret · help "Checks run on this site. Keep the secret private; after generating a new one, visitors get a fresh check on their next form."
- **Usage payouts.** Collect usage payouts · helper "High-volume clients can pay per request. You withdraw from the dashboard." (§18, verbatim) · Balance "$12.40" over "available to withdraw, after the 10% platform fee" · "To withdraw, open Advanced settlement below."
- **Advanced settlement** (collapsed on every load) · note "Payment connection, fee and withdrawals"
  - Payment connection: Test mode (no real money) · NWC connection string · LND REST
  - Connection string help: "Stored on this server only. Never sent to visitors' browsers."
  - Platform fee: "10% · recorded on each payment"
  - Withdraw: placeholder "Paste a payout invoice for up to $X.XX" · button "Withdraw" · help "The invoice amount is checked against your balance before anything is sent."
- Notices: "Settings saved." · "Withdrawal sent: $X.XX." · "That invoice couldn't be paid. Check the amount and try again." · "That invoice is for more than your available balance." · "Paid requests are paused. Visitors and clients can still get through with the background check."

## Naming
Product: Toll. WordPress plugin: `toll-gate`. Widget file: `toll.js`, element `<toll-gate>`, form attribute `data-toll`, pass cookie `toll_pass`, header `Authorization: Toll`. Never name a public file or package after a coin or payment network (`bitcoin.js` is out); the internal rail lives in `packages/settlement-ln/`.
