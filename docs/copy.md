# Toll: words we will and will not say (`docs/copy.md`)

Owner: Product Manager. Sources, newest wins: `brand/BRAND_BRIEF.md` (Luke, Oct 1, 2026; overrides everything below and every earlier spec line for public copy), then SPEC.md §10, §13, §18, §20; PRD §2; design/HANDOFF.md §1–3.
Luke's ruling (Oct 1, 2026, ~12:50 PM CT): no existing copy is locked anymore, including the Amendment 2 pages and this file. The Creative Director owns the words and uses the brief's own lines where they fit. Every public claim must match what the product actually does today; QA checks each one against the code.
Engineering: copy this file to `docs/copy.md` in the repo. The copy lint reads the "Lint list" below. This file is exempt from the lint because it holds the list.

## Where these rules apply
Public surfaces: `README.md`, `website/` pages, readme.txt, widget strings, demo pages, WordPress plugin screens and notices (including Advanced settlement), `docs/` pages meant for readers (not this file), package names, the public repo description, and commit titles for user-facing files.
Exempt (may use protocol words): `docs/settlement.md`, `docs/settlement-vectors.json`, `packages/settlement-ln/`, code identifiers, the JSON wire format (for example `amount_msat`, `ln402`, `rail`), the `payment` objects in the manifest and MCP files, and standard licence text (the GPL's own wording).

## Lint list (case-insensitive, whole words, CI fails on any hit in a public surface)
From the brand brief (Oct 1): clear, clearlane, tsa, precheck, skip the line, skip-the-line, tax, taxes, taxed, taxing, surcharge, surcharges, paywall, paywalls, on-ramp, on-ramps, make ai pay, bitcoin, lightning, wallet, wallets, sats, detect ai, detects ai, human score, captcha, captchas, puzzle, puzzles.
From §19.12: btc, satoshi, l402.
From §1 (PRD §6 testing bar): sat, on-chain, onchain, seed phrase, orange pill, softwar, energy money, proof-of-compute, geopolitics, ai slop, we detect ai.
Also fail on any percentage next to "human", "bot" or "AI" (a risk score as identity, for example "12% human").

## Avoid (review, not lint)
Any claim that Toll detects bots or AI, or says who a visitor is. Coins, robots, shields, closed highways, airports, security lines, or a free-road-versus-paid-ramp explanation, in words or pictures. Bot score, human, crypto, token (except the code name `toll-pass`), mining, hash, "I am not a robot", monetary theory of any kind. No numbers for spam reduction, speed, or time saved until we have measured them.

## Brand lines (brief, verbatim where cleared)
Cleared for public use (true of the product today):
- Less traffic. Better road. (primary subtitle)
- The nicest drives are the ones with less traffic.
- The quieter road for comments and forms.
- Spam takes another road.
- Fewer cars in the comment lane.
- A toll road, for forms. The site stays open.
- Kept up, because not everyone gets on.
- Stop form spam without closing the site.
- Your homepage stays open. Your forms stay quiet.
- Less traffic where it counts.
- Built for the road with fewer cars.
- Spam is just too much traffic.

Held until the Creative Director rewords them (the claim is not true today, or uses a banned word). The lint has no exemption for the brief's own two lines that use the banned word; they get reworded instead.
- "Less junk. Less waiting. Same website." Visitors don't wait less; the check adds a little work before a post.
- "You get there faster when the road is quiet." Same reason. "Time saved" may only mean the owner's moderation time, with no number.
- "People pass through. Floods do not." / "Time saved, because the junk never merges." / "One small booth. Then the road is empty." The check makes floods costly, it doesn't stop them outright, so no "never", "empty", or "do not".
- "Beautiful drive. Almost no junk." We have no measured spam figure behind "almost no".
- "A quieter comment box. No puzzle." Banned word.
- Plugin one-liner "Toll keeps comment forms, logins, and write APIs quiet. Visitors read for free and post without a puzzle. Floods take another road." Banned word; "logins" stays only if QA confirms each adapter gates logins out of the box.

Search (PM call, Oct 1): search keeps its Amendment 2 default, a check at the write price that the owner can set to 0. So "Toll only checks writes" and "Visitors read for free" must not imply search is free. Say page views and articles are free, and name search alongside writes where the line lists what Toll checks.

Retired (Oct 1): the SPEC §1 "allowed public framing" list. Of its lines, these are also not true today: "High-volume clients pay more; a person pays once" and "Agents can pay per request instead of grinding" (payment is a test backend, so any payment claim says test), and "Collected usage value is paid out to you" (payouts need a payment server; none is live).

## Money
- Always USD from the live FX rate (cached ≤ 15 min). Never hardcode "0.004".
- Totals use two decimals: "$12.40". A non-zero amount under a cent: "less than $0.01".
- `{fee}` is `fee_bps / 100` as a plain number with trailing zeros dropped: 1000 → "10", 750 → "7.5", 25 → "0.25". Default 10.
- Rounding: owner balances and totals round down to the cent, so we never show more than can be withdrawn. Offer prices round up and show at most four decimals ($0.0001). Offers are whole sats underneath (Q3).
- FX down: hide the amount. Demo shows "—" with "Rate unavailable"; WordPress shows "Balance will show again shortly".
- Never show msat, coin units, invoices or rail names on a default surface.

## README (top; Creative Director rewrites it from the brief)
The old §20 top below is retired. "High-volume clients pay more" is a payment claim (test only today) and "People don't notice" is unmeasured until the phone run.
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

## Amendment 2: reads stay free (Oct 1, 2026; wording unlocked by Luke the same day)
The meaning stays: page views stay free, Toll checks writes, and gating page views needs a warning and an explicit confirm. The Creative Director may reword every line below in the brief's voice; search is covered as described under Brand lines.
- First screen after install (README and WordPress helper text), exact: "Toll checks writes, not page views. Leave public pages open so people and answer engines can read you. Turn Toll on for comments, forms, logins, and APIs."
- Dashboard warning when an owner gates ordinary page views, exact, with an explicit confirm (default stays off): "This hides the site from answer engines and new readers. Toll is for writes."
- Website pages `website/mission.md`, `vision.md`, `values.md`, `ecosystem.md`: Amendment 2 §E, now being rewritten in the brief's voice (Luke, Oct 1). The full lint list, including the brief's words, runs on them. Their one use of "human" ("We do not score visitors as human or not.") is Luke's wording and is allowed there; it stays off the default product screens.
- `docs/positioning.md`: Amendment 2 §B, for contributors, not a public screen.
- Never on any public surface: crawler allow, charge, or block features, or "block training bots".
- No page-view switch in WordPress (PM call, Oct 1): nothing there can gate a page view, so the warning has nothing to attach to.
- Routes editor confirm (when deleting `/` or raising a GET path above read): body is the §A warning above. Buttons: "Keep pages open" (focused, default) and "Gate page views" (destructive).

## Amendment 3: agent discovery (Oct 1, 2026)
Luke's wording, unlocked Oct 1; the Creative Director may reword it:
- `website/ecosystem.md`, new section added after the existing text: "Agents that need a write-gate can find Toll in public tool catalogs. The article stays free. The tool call is priced. Being quoted in an answer is not the same as being chosen as the tool."
- Manifest and MCP `description` (147 characters): "Invisible check for writes. A person does not notice. A program that fires thousands of writes pays for each one, or stops. Public pages stay free."
  - Accuracy flag (Oct 1): a heavy client can also do the work instead of paying, payment is a test backend, and "does not notice" is unmeasured on phones. Rewording goes to the Creative Director; keep it under 160 characters, with no banned words.

Tool names and descriptions (PM copy; the description is the ranking signal, so it must state each tool's job and what it does not do):
- `price_write_action`: "Returns the current USD price, and the work alternative, for one write on a Toll-protected site: a comment, signup, login, form post, or state-changing API call. Use it before a write to choose between paying and doing the work. Not for page views, which are free and need no call. Does not identify the caller."
- `gate_form_write`: "Gets a one-use pass for one write on a Toll-protected site. With no payment it returns the payment offer and a work challenge. With proof of payment it returns the pass. Use only for writes. Does not block public reads, does not detect who the caller is, and does not license or price content."
- `verify_write_pass`: "For the site's own server: checks that a pass sent with a write is valid, unused, and for this site and action. Returns valid or invalid with a reason. Does not score the caller or say whether it is a person or a program."
- `not_for`, exact: ["page views", "crawler blocking", "citation licensing"]. `reads_free`: true.

Price and payment honesty:
- Until a real offer exists, every price carries a status beside it: `"status": "test"` (test or testnet rail) or `"status": "stub"`. The USD display is computed from `amount_msat` and the configured rate, rounded up to $0.0001 exactly like the 402 offer (never typed by hand), and reads like "$0.0100 (test)" for a write at the demo rate. It never stands alone as a bare number. The demo's fixed test rate is not a market price.
- Lint scope: the manifest and MCP files are for machines, so only their `payment` objects may name the payment method (Amendment 3). Every `description` string and all website pages stay under the full lint list.
- Base price label (Oct 1, ~4:30 AM): the manifest price field is labelled base price, and each priced tool in the manifest carries this exact note: "Base price. The 402 offer is the price that applies, and it can go up while the site is under load." `price_write_action` returns the price that applies right now, including any load increase, so its description ("Returns the current USD price…") stays as written. Parity tests run at load multiplier 1.
