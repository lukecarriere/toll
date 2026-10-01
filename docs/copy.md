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
- `{fee}` is `fee_bps / 100` as a plain number with trailing zeros dropped: 1000 → "10", 750 → "7.5", 25 → "0.25". Default 10.
- Rounding: owner balances and totals round down to the cent, so we never show more than can be withdrawn. Offer prices round up and show at most four decimals ($0.0001). Offers are whole sats underneath (Q3).
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
- Agent hammer card (Phase 2, design/proto/hammer.html): command `node demo/agent-pay.mjs --writes 20` · counts "paid requests" · "usage value collected" · "N ✕" over "replayed payments rejected" ("replayed payment rejected" at 1)
- Owner block: heading "Site owner" · Collect usage payouts · helper "High-volume clients can pay per request. You withdraw from the dashboard." · balance "$X.XX" over "available to withdraw · after the {fee}% platform fee"
  - These two lines stay as written. The helper is §18 verbatim, and in WordPress "the dashboard" is WP admin, where Advanced settlement lives. Withdrawal is MVP (§8.6.6, phase 2), and only the platform fee is held until phase 4, so the owner's net balance really is "available to withdraw". Do not mention the hosted dashboard anywhere.
- Forms page: lede "Use them like a normal visitor. Each one runs an invisible check in the background, and the counts on the right update as you go. Then try the same endpoint without a pass." · panel "Live stats"
- Form cards: Contact "A write. Gated as" + tag · Comments "In-memory thread. Gated as write; your pass covers about 20 comments for 15 minutes." · "Add a comment" · button "Post comment" · Search "A search that POSTs. Gated as search (cheaper than a write)." · No-pass sub "The same contact endpoint, called the way a script would."
- Fields and results: Name · Email · Message · button "Send" · pill "✓ Accepted · 200" · search line "N result(s) for "query"" (singular at 1)
- Hammer page: title "Bot hammer" · lede "Fire 50 writes at the contact endpoint, first as a script that skips the check, then through the widget's background worker. Each square is one request." · run subs "Plain POSTs, no worker, no pass." and "Each request solves in the worker first, like a visitor's browser." · counts "accepted" · "rejected" · "mean solve" · legend "✓ accepted" · "✕ rejected" · "not sent yet"
- Agent hammer: "An automated client sends 20 writes with no widget. It pays each request instead of doing the work, using the test payment backend." · tag "phase 2"

## WordPress strings (exact)
- Menu: Settings → Toll. Line under title: Challenges issued today: N
- Counters: link "Export counters" · help "Downloads the counts as a CSV file. Nothing is sent anywhere."
- **Protect these forms.** "Visitors get an invisible check. Forms that skip it are rejected." Options: Comments · Login · Registration · Lost password · WooCommerce checkout "(WooCommerce is active)" · Contact Form 7 forms · Any form with `data-toll`, help "Always on. Add `data-toll="write"` to a form in your theme to protect it."
- **Visible check.** "Show a "Verify before sending" button instead of an invisible check" · help "Off by default. Most sites don't need it."
- **Longest check.** 4 / 8 / 12 seconds · help "If a check would take longer, the visitor gets a "Verify before sending" button instead of waiting."
- **Keys.** Site key · Secret · Show · Generate new secret · help "Checks run on this site. Keep the secret private; after generating a new one, visitors get a fresh check on their next form."
- **Usage payouts.** Collect usage payouts · helper "High-volume clients can pay per request. You withdraw from the dashboard." (§18, verbatim) · Balance "$12.40" over "available to withdraw, after the {fee}% platform fee" · "To withdraw, open Advanced settlement below."
- **Advanced settlement** (collapsed on every load) · note "Payment connection, fee and withdrawals"
  - Payment connection (Luke picked option A, Oct 1, 2026): Test mode (no real money) · Payment server. The old NWC and LND REST options are gone, because WordPress doesn't take payments itself.
  - Test mode help (Oct 1, 2026; replaces "Test mode lets clients pay with test funds so you can try payouts safely."): "In test mode, no real money moves and clients do the background check instead of paying. To try payouts, choose Payment server and add the address of a server running in test mode." With payouts ticked, the Balance row shows "Payouts start once a payment server address is added." and Withdraw is disabled.
  - Payment server address: placeholder "https://pay.example.com" · help "Payouts need a server that can take payments. Paste its address here. Protection keeps working on this site without it."
  - Payment server key help: "Stored on this server only. Never sent to visitors' browsers."
  - Ticked with no address: "Payouts start once a payment server address is added."
  - Balance and withdrawals come from the payment server; the strings above stay the same.
  - Platform fee: "{fee}% · recorded on each payment"
  - Withdraw: placeholder "Paste a payout invoice for up to $X.XX" · button "Withdraw" · help "The invoice amount is checked against your balance before anything is sent."
- Notices: "Settings saved." · "Withdrawal sent: $X.XX." · "That invoice couldn't be paid. Check the amount and try again." · "That invoice is for more than your available balance." · "Paid requests are paused. Visitors and clients can still get through with the background check." · "The payment server isn't responding. Visitors and clients can still get through with the background check."

## Naming
Product: Toll. WordPress plugin: `toll-gate`. Widget file: `toll.js`, element `<toll-gate>`, form attribute `data-toll`, pass cookie `toll_pass`, header `Authorization: Toll`. Never name a public file or package after a coin or payment network (`bitcoin.js` is out); the internal rail lives in `packages/settlement-ln/`.

## Amendment 2: reads stay free (Oct 1, 2026, Luke, verbatim, do not edit)
- First screen after install (README and WordPress helper text), exact: "Toll checks writes, not page views. Leave public pages open so people and answer engines can read you. Turn Toll on for comments, forms, logins, and APIs."
- Dashboard warning when an owner gates ordinary page views, exact, with an explicit confirm (default stays off): "This hides the site from answer engines and new readers. Toll is for writes."
- Website pages `website/mission.md`, `vision.md`, `values.md`, `ecosystem.md`: Amendment 2 §E as written. Nobody edits the wording. The copy lint still runs on them and they pass. Their one use of "human" ("We do not score visitors as human or not.") is Luke's wording and is allowed there; it stays off the default product screens.
- `docs/positioning.md`: Amendment 2 §B, for contributors, not a public screen.
- Never on any public surface: crawler allow, charge, or block features, or "block training bots".
- No page-view switch in WordPress (PM call, Oct 1): nothing there can gate a page view, so the warning has nothing to attach to.
- Routes editor confirm (when deleting `/` or raising a GET path above read): body is the §A warning above. Buttons: "Keep pages open" (focused, default) and "Gate page views" (destructive).

## Amendment 3: agent discovery (Oct 1, 2026)
Luke's wording, verbatim, do not edit:
- `website/ecosystem.md`, new section added after the existing text: "Agents that need a write-gate can find Toll in public tool catalogs. The article stays free. The tool call is priced. Being quoted in an answer is not the same as being chosen as the tool."
- Manifest and MCP `description` (147 characters): "Invisible check for writes. A person does not notice. A program that fires thousands of writes pays for each one, or stops. Public pages stay free."

Tool names and descriptions (PM copy; the description is the ranking signal, so it must state each tool's job and what it does not do):
- `price_write_action`: "Returns the current USD price, and the work alternative, for one write on a Toll-protected site: a comment, signup, login, form post, or state-changing API call. Use it before a write to choose between paying and doing the work. Not for page views, which are free and need no call. Does not identify the caller."
- `gate_form_write`: "Gets a one-use pass for one write on a Toll-protected site. With no payment it returns the payment offer and a work challenge. With proof of payment it returns the pass. Use only for writes. Does not block public reads, does not detect who the caller is, and does not license or price content."
- `verify_write_pass`: "For the site's own server: checks that a pass sent with a write is valid, unused, and for this site and action. Returns valid or invalid with a reason. Does not score the caller or say whether it is a person or a program."
- `not_for`, exact: ["page views", "crawler blocking", "citation licensing"]. `reads_free`: true.

Price and payment honesty:
- Until a real offer exists, every price carries a status beside it: `"status": "test"` (test or testnet rail) or `"status": "stub"`. The USD display is computed from `amount_msat` and the configured rate, rounded up to $0.0001 exactly like the 402 offer (never typed by hand), and reads like "$0.0100 (test)" for a write at the demo rate. It never stands alone as a bare number. The demo's fixed test rate is not a market price.
- Lint scope: the manifest and MCP files are for machines, so only their `payment` objects may name the payment method (Amendment 3). Every `description` string and all website pages stay under the full lint list.
