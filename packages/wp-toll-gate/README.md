# packages/wp-toll-gate

The `toll-gate` WordPress plugin (spec §13, phase 3). Local only: not published anywhere.

- Protects **comments** and **login** by default; **registration**, **lost password**, **WooCommerce checkout** and **Contact Form 7** are opt-in on Settings → Toll. A theme form with `data-toll="write"` gets the widget too; to verify it, the theme calls `toll_gate_verify_request('write')` before handling the post.
- The issuer is the site itself (`/wp-json/toll/v1/{challenge,redeem,status,health,siteverify}`, same wire format as docs/protocol.md). Challenges are minted and solutions verified in PHP with the pinned work engine library (packages/server-php). Nothing is called outside the site, except the owner's own payment server when "Collect usage payouts" is on and set to Payment server.
- **Fails closed.** A protected form with no valid pass, an expired or used-up pass, or a pass for a lower class is rejected (comments: HTTP 403 "This form needs JavaScript."; login, registration, lost password, checkout: an error). If the library or the database can't answer, the form is rejected too. Staff with `moderate_comments` skip the comment check.
- **Passes:** a check gives a 900-second pass good for 20 actions (spec §18), as an HttpOnly, SameSite=Lax `toll_pass` cookie and as a hidden `toll-pass` field the widget adds. Each challenge id is single-use, and each pass use is counted atomically in the options table (plain `INSERT` for first use, a conditional `UPDATE` for uses), so two requests can't spend the same use. Expired rows are cleaned up hourly.
- **Work policy:** the standard engine (PBKDF2) with the same numbers as the Node issuer (desktop write 512 tries max, phone 0.6x). Velocity, escalation and paid offers are Node-issuer features for now (docs/policy.md §6): the WordPress issuer is work-only and offers are always `[]`.
- **Counters** with the Node names (`pass_accept`, `pass_reject`, `pass_absent`, `turned_away`, `offer_shown`, `paid`, `work_after_402`) plus "Challenges issued today", stored in one option. **Export counters** on the settings page downloads `toll-counters.csv` (those seven columns, one row of totals). It only runs when the signed-in owner clicks it (capability + nonce).
- **Usage payouts (option A).** WordPress takes no payments itself, so there is no payment backend code here. Test mode keeps a local test ledger (no money); Payment server reads the balance from, and sends withdrawals to, a Toll issuer's owner API (docs/settlement.md §9). The key is stored server-side and never printed into a page.

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
- `tests/php/run-issuer.php` and `tests/php-issuer.test.ts`: the PHP mint, pass and policy code, and its agreement with the Node issuer.
- The copy lint scans every file in this folder.

## Layout

- `toll-gate.php` (bootstrap), `uninstall.php`
- `includes/`: `lib.php` (loads packages/server-php), `strings.php` (all copy, word for word from docs/copy.md), `options.php`, `counters.php`, `store.php` (replay and pass uses), `issuer.php` (REST), `gate.php` (forms), `payouts.php`, `admin.php` (Settings → Toll)
- `assets/admin.css`, `assets/admin.js`; `assets/widget` links to `packages/widget/dist`
- `dev/`: local WordPress script and the built-in server router

## Before any release (not done)

A release zip would bundle `packages/server-php` (src + vendor) under `lib/server-php` and copy the widget files in place of the `assets/widget` link. Not built: publishing waits on the Android timing run and on Luke's licence decision (wordpress.org requires a GPL-compatible licence; packages/server-php is marked proprietary and the plugin header has no License line yet).
