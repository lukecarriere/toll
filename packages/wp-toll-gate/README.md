# packages/wp-toll-gate

The `toll-gate` WordPress plugin (spec §13, phase 3). Local only: not published anywhere.

The settings page opens with the install line from docs/copy.md, as a plain paragraph under the heading: "Toll checks writes and searches, not page views. Leave public pages open so people and answer engines can read you. Turn Toll on for comments, forms, logins, and APIs."

- Protects **comments** and **login** by default; **registration**, **lost password**, **WooCommerce checkout** and **Contact Form 7** are opt-in on Settings → Toll. A theme form with `data-toll="write"` gets the widget too; to verify it, the theme calls `toll_gate_verify_request('write')` before handling the post.
- The issuer is the site itself (`/wp-json/toll/v1/{challenge,redeem,status,health,siteverify}`, same wire format as docs/protocol.md). Challenges are minted and solutions verified in PHP with the pinned work engine library (packages/server-php). Nothing is called outside the site, except the owner's own payment server when "Collect usage payouts" is on and set to Payment server (balance, withdraw, and offers and paid redeems for agents).
- **Reads stay free** (Amendment 2). The plugin only checks form posts. Its route list (`TOLL_GATE_ROUTES`) is `/` read, `/wp-comments-post.php` write, `/wp-login.php` account; nothing in it, and no setting, can gate a page view (no page-view switch, by PM decision).
- **Agent discovery** (Amendment 3). `/.well-known/toll.json` and the `/.well-known/agents.json` pointer are served to anyone, with no check, before WordPress routes the request (`includes/discovery.php`). Fetches are counted as `manifest_fetch` and `agents_json_fetch`. `GET /wp-json/toll/v1/price` gives one paid request's price that applies now (`basis: "current"`; `load_multiplier` 1, because the relayed offer carries no load multiplier). The manifest labels its prices `basis: "base"`. The base-price note appears only when the payment server reports `load_pricing` for a priced class. Today its relayed offers apply no load multiplier, so the note is omitted. With payouts on and a payment server set, amounts and the rate come from that server (`GET /v1/owner/price`, cached 30 s), and the USD is derived here with `Settlement::offerUsd`, the same round-up as the 402 offer. Otherwise prices are null with status `stub` (work only).
- **Fails closed.** A protected form with no valid pass, an expired or used-up pass, or a pass for a lower class is rejected (comments: HTTP 403 "This form needs JavaScript."; login, registration, lost password, checkout: an error). If the library or the database can't answer, the form is rejected too. Staff with `moderate_comments` skip the comment check.
- **Passes:** a check gives a 900-second pass good for 20 actions (spec §18), as an HttpOnly, SameSite=Lax `toll_pass` cookie and as a hidden `toll-pass` field the widget adds. Each challenge id is single-use, and each pass use is counted atomically in the options table (plain `INSERT` for first use, a conditional `UPDATE` for uses), so two requests can't spend the same use. Expired rows are cleaned up hourly.
- **Work policy:** the standard engine (PBKDF2) with the same numbers as the Node issuer (desktop write 512 tries max, phone 0.6x). Velocity and escalation are Node-issuer features for now (docs/policy.md §6).
- **Agents** (`Toll-Client: agent` header or `client=agent`) get JSON instead of the no-JavaScript page on comments and the wp-login.php forms. With "Collect usage payouts" ticked, Payment server chosen and an address set, that is the Node 402 (`WWW-Authenticate`, `{error:"payment_required", challenge_url, offers}`): the offers are minted by the payment server and relayed as they are, a paid redeem at `/wp-json/toll/v1/redeem` is checked by that server, and the plugin mints a one-use, 60-second pass. Otherwise (payouts off, Test mode, no address, or the server down or slower than 1.5 s) it is the work-only 403 with an inline challenge, never a 500. WooCommerce checkout and Contact Form 7 stay work-only for agents. Details: docs/settlement.md §9.
- **Counters** with the Node names (`pass_accept`, `pass_reject`, `pass_absent`, `turned_away`, `offer_shown`, `paid`, `work_after_402`, `page_view_gate_confirmed`, `manifest_fetch`, `agents_json_fetch`) plus `challenges_minted`, one database row per UTC day and counter (atomic increments; rows older than 90 days are dropped by the hourly cleanup). The settings page shows "Challenges issued today" from today's UTC `challenges_minted`. **Export counters** downloads `toll-counters.csv`: one row per UTC day for the last 30 days, oldest first, with columns `date,timezone,pass_accept,pass_reject,pass_absent,turned_away,offer_shown,paid,work_after_402,challenges_minted,page_view_gate_confirmed,manifest_fetch,agents_json_fetch,since,exported_at` (`timezone` is always `UTC`; `page_view_gate_confirmed` is always 0 here, kept for the same columns as Node; `since` is when counting started and `exported_at` the download time, both ISO 8601 UTC). It only runs when the signed-in owner clicks it (capability + nonce).
- **Usage payouts (option A).** WordPress takes no payments itself, so there is no payment backend code here. Test mode is work-only (no balance, Withdraw disabled, agents do the background check); Payment server reads the balance from, and sends withdrawals to, a Toll issuer's owner API (docs/settlement.md §9). The key is stored server-side and never printed into a page.

## Run it on a local WordPress

Needs PHP 8.1+ with `pdo_sqlite` (Debian/Ubuntu: `php8.4-sqlite3`), `curl`, `unzip`, and `composer install` in `packages/server-php`. No MySQL and no Docker: PHP's built-in server plus the SQLite database integration.

```sh
(cd packages/server-php && composer install)
npm run build                                    # the widget files the plugin serves
packages/wp-toll-gate/dev/setup-local-wp.sh      # first run downloads WordPress 7.1.2, SQLite integration 3.0.2, WP-CLI 2.12.0
# -> http://127.0.0.1:8888   admin credentials: /workspace/wp-local/ADMIN_CREDENTIALS.txt (not in git)
packages/wp-toll-gate/dev/setup-local-wp.sh stop
```

The script installs into `$WP_LOCAL_DIR` (default `/workspace/wp-local`), links this folder as `wp-content/plugins/toll-gate`, activates it, sets pretty permalinks (the widget calls `/wp-json/toll/...`), turns off comment moderation, avatars and the comment flood limit for testing, and blocks outgoing HTTP to other hosts (`WP_HTTP_BLOCK_EXTERNAL`). WP-CLI: `php /workspace/wp-local/wp-cli.phar --path=/workspace/wp-local/site ...`.

To try **Payment server**: start the Node demo (`npm run demo`, stub backend), then in Settings → Toll tick "Collect usage payouts", open Advanced settlement, pick Payment server, address `http://127.0.0.1:8787`, and paste the key from `demo/.owner-key`. An address where nothing listens (e.g. `http://127.0.0.1:8799`) shows the server-down state.

## Tests

- `tests/wp.test.ts` (part of `npm test`; skipped when the local site isn't running): REST issuer, comment gate (accepted with a pass, 403 without), login gate, siteverify, counters and CSV export, every settings state, the comment form in a browser at 390 and 1440 px, no-JavaScript rejection, and copy scans (no coin words, no vendor names) of the settings page, the Plugins row and the comment form. The connected state needs the Node demo on :8787. `TOLL_RENDERS=<dir>` also saves screenshots.
- `tests/wp-agent.test.ts` (same conditions): agents on the comment form. Test mode and payouts off give the 403 work check (agent-pay 20/20 by work); Payment server against the Node demo gives the 402 (agent-pay 20/20 paid, replay rejected, spent pass refused, counters and the admin balance match the server); a stand-in server checks that offers and proofs are relayed unchanged and that a down, slow or broken server means work, not a 500.
- Run agent-pay against the site by hand: `npm run agent-pay -- --writes 20 --base http://127.0.0.1:8888 --issuer http://127.0.0.1:8888/wp-json/toll --path /wp-comments-post.php --form "comment_post_ID=1&author=Agent&email=agent@example.test" --field comment --pay-url http://127.0.0.1:8787/demo/stub-pay --stats http://127.0.0.1:8787`
- `tests/php/run-issuer.php` and `tests/php-issuer.test.ts`: the PHP mint, pass and policy code, and its agreement with the Node issuer.
- The copy lint scans every file in this folder.

## Layout

- `toll-gate.php` (bootstrap), `uninstall.php`
- `includes/`: `lib.php` (loads packages/server-php), `strings.php` (all copy, word for word from docs/copy.md), `options.php`, `counters.php`, `store.php` (replay and pass uses), `issuer.php` (REST), `gate.php` (forms), `payouts.php`, `admin.php` (Settings → Toll)
- `assets/admin.css`, `assets/admin.js`; `assets/widget` links to `packages/widget/dist`
- `dev/`: local WordPress script and the built-in server router

## Before any release (not done)

A release zip would bundle `packages/server-php` (src + vendor) under `lib/server-php` and copy the widget files in place of the `assets/widget` link. Not built: publishing waits on the Android timing run.

## Licence

This plugin and `packages/server-php` are GPL-2.0-or-later (Luke, Oct 1, 2026): the plugin header carries `License: GPL-2.0-or-later` and the GPL-2.0 URI, `packages/server-php/composer.json` says `GPL-2.0-or-later`, and each package has the full GPL-2.0 text in `LICENSE`. The bundled third-party code is MIT, which is GPL-compatible: the pinned work engine PHP library and Composer's autoloader in `server-php/vendor` (names and versions in docs/adapters.md), and the widget's solver and workers (notices in `assets/widget/LICENSES.txt`). The Node packages and the hosted service stay proprietary.
