# Toll wire protocol v1 (work rail)

Status: phase 0/1 as amended (Amendment 1), implemented in `packages/protocol` + `packages/work-adapter` (TypeScript) and `packages/server-php` (PHP, with the engine's PHP library). Both pass [`vectors.json`](vectors.json). The paid rail (phase 2, local test backend) is specified in `docs/settlement.md`; it adds the paid redeem body, `offers[]` for agents and a 402 for agents, and no fields to challenges or passes.

Conventions: all JSON, all times are Unix seconds, all IDs are opaque lowercase hex. Integers only (no floats anywhere that gets signed).

## 1. Canonical JSON and signatures

`sig = base64( HMAC-SHA256( site_secret, canonical_json(challenge without "sig") ) )`

Canonical JSON: UTF-8; object keys sorted by code unit at every level; no whitespace; strings escaped exactly as JavaScript's `JSON.stringify` does (so `/` is not escaped and non-ASCII is raw UTF-8, matching PHP `json_encode` with `JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE`); numbers are safe integers. `site_secret` is used as its UTF-8 bytes. Compare MACs in constant time. A challenge without `sig`, or with a bad one, is rejected.

## 2. Challenge object

Amendment 1: Toll owns the envelope (id, site, binding, times, signature). The puzzle itself is
the work engine's payload, carried opaque in `work` and covered by `sig`. Engine choice, versions
and the exact payload mapping are in [`adapters.md`](adapters.md).

```json
{
  "v": 1,
  "id": "8f3c0000000000000000000000000001",
  "site": "site_abc123",
  "alg": "pbkdf2-sha256",
  "work": {
    "parameters": {
      "algorithm": "PBKDF2/SHA-256",
      "cost": 5000,
      "data": {
        "tid": "8f3c0000000000000000000000000001"
      },
      "keyLength": 32,
      "keyPrefix": "9cdcd33d250393629e060363a88207a2",
      "keySignature": "817437fac73ee1903189479e94d7bb3277ad49b8d84cf8cda94f667f5fb52d47",
      "nonce": "a9672c76f5c19572873a77f0becd1936",
      "salt": "d9855363f429b350586179cce92c8915"
    },
    "signature": "fc7649ed77867d38558561e2c42aefb955be0de3db8a30ca470f5c5e33bcfeef"
  },
  "bound": {
    "action": "write",
    "path_prefix": "/contact"
  },
  "iat": 1790000000,
  "exp": 1790000120,
  "sig": "Ng3EqzOkeFqUiQCZKu89ZokneV+x5jF2W1FwFQcdxfw="
}
```

This is `work[0]` from the vectors.

| Field | Rule |
|---|---|
| `v` | `1` |
| `id` | 16 random bytes, 32 hex chars. Single use. Also bound inside the engine payload (`work.parameters.data.tid`). |
| `site` | 1..128 chars. |
| `alg` | `pbkdf2-sha256` (standard mode, default) or `argon2id` (hardened mode). Tells the client which solver worker to load; must equal the algorithm inside `work`. |
| `work` | The engine payload, unchanged. Opaque to the origin and to the envelope code. Canonical JSON ≤ 4,096 bytes. |
| `bound` | `action` (search, write, account, admin) and a coarse `path_prefix` from the route table (`/` if unmapped). Never the client IP. |
| `iat`, `exp` | `0 < exp - iat ≤ 120`. Verifiers allow `iat` up to 5 s in the future. The engine payload has no expiry of its own; `exp` here governs. |

Unknown fields are rejected.

## 3. The work rule

The engine's rule, summarised (normative text: the engine's own spec, pinned version in adapters.md):
the issuer picks a secret counter `x` uniformly in `[0, counter_max)`, derives
`DK = KDF(password = nonce || uint32be(x), salt)` with the mode's KDF (PBKDF2-HMAC-SHA256 with
`cost` iterations, or Argon2id with `cost` passes and `memoryCost` KiB), and publishes a prefix of
`DK` (`keyPrefix`) plus an HMAC of the full key (`keySignature`). The client scans counters upward
from 0 until the derived key starts with `keyPrefix` and returns `{ counter, derivedKey }`.

- **Bounded, predictable effort.** At most `counter_max` tries, on average about half. `counter_max` is never sent; the client cannot tell how far it has to go.
- **Policy tunes milliseconds.** The issuer sets `counter_max` from the expected tries it wants (policy.md §1); `cost` stays fixed per mode.
- **Cheap to check.** Verifying is one HMAC (the key signature), falling back to one KDF call. Minting costs one KDF call (the secret counter's key).
- **Modes.** Standard (PBKDF2) is the default for humans. Hardened (Argon2id, memory-hard) is for sites under GPU pressure; it is heavier on phones and costs the issuer one Argon2id call per challenge.

## 4. Solution and redeem

Solution (from the widget):

```json
{ "work": { "counter": 41, "derivedKey": "9cdc…" }, "took_ms": 412, "ua_class": "mobile" }
```

`took_ms` and `ua_class` are hints for metrics and adaptive policy only. They are never trusted for authorization.

`POST /v1/redeem`

```json
{ "challenge_id": "8f3c…", "challenge": { …signed challenge… }, "solution": { "work": { "counter": 41, "derivedKey": "…" }, "took_ms": 412, "ua_class": "desktop" } }
```

`challenge` is optional: a stateless verifier needs it; the issuer that minted the challenge can look it up by `challenge_id`. The widget always sends it. The paid form `{ offer_id, kind: "ln402", preimage, macaroon }` (settlement.md §6) returns `{ pass, exp, cls, rail: "settle" }` with a one-use, 60 s pass when settlement is on, and `400 unsupported` while it is off.

Verification order (both implementations): shape (`malformed` / `unsupported`) → Toll signature (`bad_sig`) → time (`not_yet_valid` / `expired`) → site (`wrong_site`) → claim the id in the replay store (`replay`) → engine: payload algorithm equals `alg` (`malformed`), `data.tid` equals `id`, engine signature, solution (`bad_solution`). The id is claimed before the work is checked, so each signed challenge can cost the server at most one verification. If the replay store is unreachable the redeem fails with 503: writes fail closed. Then Toll mints the pass (§5).

Response 200: `{ "pass": "<token>", "exp": 1790000901, "cls": "write", "rail": "work" }`, plus `Set-Cookie: toll_pass=…; Path=/; Max-Age=900; HttpOnly; SameSite=Lax` (and `Secure` over HTTPS). An existing valid cookie for a higher class is not overwritten by a lower one.

Errors: 400 malformed/unsupported, 401 bad_sig/expired/not_yet_valid/replay/bad_solution/unknown_challenge, 429 rate limited, 503 store unavailable.

## 5. Pass

A compact HMAC JWT (HS256) signed with the site secret. Header and payload are canonical JSON, base64url without padding:

```
header  = {"alg":"HS256","typ":"JWT"}
payload = {"cls":"write","exp":1790000901,"iat":1790000001,"jti":"…32 hex…","n":20,"site":"site_abc123","sub":"pass_…16 hex…","v":1}
token   = b64url(header) "." b64url(payload) "." b64url(HMAC-SHA256(secret, b64url(header) "." b64url(payload)))
```

Defaults: human work passes `exp = iat + 900`, `n = 20`. Transport: `Authorization: Toll <pass>` (also `Bearer`), the hidden form field `toll-pass`, or the `toll_pass` cookie.

A verifier rejects a pass that is past `exp`, for another site, for a lower class than the action (a `search` pass cannot authorize `write`; higher classes cover lower ones), or whose `n` uses are spent. The issuer tracks remaining uses per `jti` in its store; an unknown `jti` starts at the token's `n`.

## 6. Action classes

| Class | Multiplier | Typical routes |
|---|---|---|
| read | 0 (free) | every GET/HEAD/OPTIONS page view (`/`, articles, docs, feeds) |
| search | 1x | search |
| write | 4x | comments, forms, votes, cart; unmapped POST |
| account | 8x | signup, login, password reset |
| admin | 16x | staff mutations |

Reads stay free (Amendment 2): the default route list starts with `{prefix: "/", class: "read"}`, and a GET, HEAD or OPTIONS request is `read` whatever prefix it matches unless that route says `get: true`. The `/` read route never lowers a write: an unmapped POST stays `write`. A route with `cost: 0` is `read`; any other `cost` is a config error. Gating page views (a `/` route above read, or `get: true` above read) is refused at load with the page-view warning from docs/copy.md unless the config sets `confirm_page_view_gating: true`; then the issuer logs `page_view_gate_confirmed {warning, prefixes}` once at start and counts it. Code that calls `protect(toll, {action})` on its own GET handler still gates that handler: the owner marked it. The edge worker and the WordPress plugin never gate a GET.

## 7. HTTP API

| Endpoint | Notes |
|---|---|
| `GET /v1/challenge?site=&action=&path=&client=widget\|agent&offers=0` | `{ challenge, offers }`. `site` defaults to the configured site. `action=read` is 400. Rate-limited per IP (default 60/min, 429 after). `offers` is `[]` unless the request is an agent (`client=agent` or `Toll-Client: agent`) and settlement is on and healthy (settlement.md §2, §4). `offers=0` asks for the challenge only (always `offers: []`, no invoice minted); it is what a 402's `challenge_url` carries. |
| `POST /v1/redeem` | §4. |
| `POST /v1/siteverify` | Form or JSON: `secret`, `response` (a pass, or a JSON redeem payload), optional `action`. Returns `{ success, action, hostname, challenge_ts }` or `{ success: false, "error-codes": […] }`. Spends one pass use. |
| `GET /v1/status` | Cookie or `Authorization` pass → `{ ok: true, exp, cls, n }` (n = remaining uses), else `{ ok: false }`. |
| `GET /v1/price?action=&path=` | Amendment 3 (`price_write_action`). `{ action, amount_msat, usd, status, display, basis: "current", load_multiplier, work: { challenge_url }, reads_free: true }`. `action` is a paid class (`read` is 400). Mints nothing and counts nothing. This is the price that applies right now for the caller: the same policy (velocity multiplier for the caller's coarse key) and the same `rail.price()` as the 402 offer (`offerUsd`, rounded up to $0.0001), so it equals the 402 the caller would get now. `load_multiplier` is that velocity multiplier (1 with no load or velocity off; null with no paid offer). On WordPress (`GET /wp-json/toll/v1/price`) the 402 relays the payment server's offer for the visitor's network. While the payment server reports no `load_pricing` for the class, that is the base price and `load_multiplier` is 1; when it does, the site asks `POST /v1/owner/quote` for the visitor's network and shows that amount and multiplier (the amount its 402 would carry now), or the base amount with `load_multiplier: null` if the quote fails. `status` is `"test"` for the local test backend, or `"stub"` with null amount/usd when this issuer makes no paid offer (settlement off, payouts off, the edge, WordPress without a payment server). `display` reads like `"$0.0100 (test)"`, never a bare number. |
| `GET /v1/health` | `{ ok: true, v: "1.0.0", settlement: "off" }`, or with settlement on `{ ok, v, settlement: "stub", settlement_degraded, usd_rate: "ok" \| "unavailable" }`; a small HTML status table when the client asks for `text/html`. No balances. |

**Agent discovery (Amendment 3):** `GET https://<toll-host>/.well-known/toll.json` is the listing. It is free on every issuer (no pass, no challenge, no payment, `Access-Control-Allow-Origin: *`) and returns `{ name: "Toll", description, docs, api, reads_free: true, not_for: ["page views", "crawler blocking", "citation licensing"], tools: [...] }`. The three tools are `price_write_action`, `gate_form_write` and `verify_write_pass`. Each has `name`, `description` (docs/copy.md, verbatim), `input_schema`, `endpoint`, `price` (`{ amount_msat, usd, status, display, basis: "base" }`: the base price, the 402 at load multiplier 1; `gate_form_write` adds `by_action` and, only when that site's offers can actually rise with load for at least one priced action, `note`: "Base price. The 402 offer is the price that applies, and it can go up while the site is under load." (docs/copy.md, verbatim). Node: the note appears when paid offers are on and `adaptive.velocity` is on; with load pricing off, `basis: "base"` stays and the note is omitted. WordPress: the note follows the payment server's `load_pricing`, see the owner API below; the edge has no paid price, so no note) and `payment` (`{ status: "stub", protocol, methods: [{ kind: "ln402", status: "test" }] or [], x402: { status: "stub" } }`, docs/adapters.md §4). `api` is the `/v1` base (WordPress: `<home>/wp-json/toll/v1`). `docs` is Toll's public site root from the one setting `TOLL_SITE_URL` (an environment variable for Node, the demo and the edge Worker binding; a PHP constant of the same name in `wp-config.php` for WordPress; rules in packages/protocol/src/site-url.ts: an absolute `https://` URL with a host name, trailing slashes removed). On Node an explicit `discovery.docs_url` in the config wins. Unset or empty, `docs` is `null` and the documents are byte-identical to a build without the setting; an invalid value is logged once and treated as unset. `api`, the `agents.json` pointer and every other URL of the protected site still come from the request (WordPress: the home URL). `GET /.well-known/agents.json` is only `{ manifest: "<origin>/.well-known/toll.json" }`. The MCP server (packages/mcp) exposes the same tools over stdio.

Owner API (Node issuer, off unless `settlement.owner_key` is set): `GET /v1/owner/price[?net=1]` (`{ status, prices: { write: { amount_msat }, ... } | null, load_pricing: { write: bool, ... } | null, fx: { usd_per_btc, fetched_at } | null }`, so a WordPress site derives the same USD with `Settlement::offerUsd`; `load_pricing` says per class whether the offers relayed by `/v1/owner/offers` can rise with load. It is `true` only when the caller declares that it sends its visitors' networks (`?net=1`) **and** this issuer applies a load multiplier (paid offers collecting and `adaptive.velocity` on); otherwise `false` for every class, so a site that sends no network (an older plugin) never shows the base-price note. The current plugin always asks with `?net=1` and caches the answer site-wide for 30 s in one transient marked `net_declared`; an unmarked cached answer is fetched again), `GET /v1/owner/balance`, `POST /v1/owner/withdraw`, and for agents on that site `POST /v1/owner/offers {action, net?}` (offers plus the `www_authenticate` value to relay), `POST /v1/owner/redeem {offer_id, kind, preimage, macaroon, net?}` (checks and books the payment; the site mints its own pass) and `POST /v1/owner/quote {action, net?}` (`{ status, action, amount_msat, load_multiplier, fx: { usd_per_btc, fetched_at } | null }`, the price a relayed offer for that network would carry now; amounts and multiplier are null with `status: "stub"` when no paid offers are made; `400 malformed` for a bad action; read-only: no offer, no velocity hit, no counter or log line), with `Authorization: Bearer <owner_key>`, server to server, for a WordPress site set to Payment server (settlement.md §9).

`net` is the visitor's coarse network, exactly as the velocity key uses it (`coarseNet` in packages/protocol/src/policy.ts): `a.b.c.0/24` for IPv4 (octets 0–255, an IPv4-mapped `::ffff:a.b.c.d` counts as IPv4) or the first three hextets as four lowercase hex digits plus `::/48` for IPv6 (`2001:0db8:0001::/48`). The site never sends the full address. With a valid `net`, offers and quotes use the same policy and multiplier as this issuer's own 402 for an address in that network (`coarseKey` gives the network and its addresses the same key), and a relayed paid redeem counts toward that network's velocity like a paid redeem here, so a paying swarm's price rises on the site too. A missing or malformed `net` is not an error: the base price (multiplier 1) and no velocity hit. The network is held only as an in-memory velocity window key; it is never logged, written to the ledger or any store, or echoed in an answer. docs/net-vectors.json pins the Node and PHP forms to the same output.

Which address is the visitor's on WordPress: `REMOTE_ADDR`, unless the owner defines `TOLL_TRUSTED_PROXIES` in wp-config.php (comma-separated IPv4/IPv6 addresses and CIDR ranges, e.g. `define('TOLL_TRUSTED_PROXIES', '10.0.0.0/8, 2001:db8::/32');`; there is no settings field). When `REMOTE_ADDR` is in that list, `X-Forwarded-For` is read right to left, skipping only listed proxies; the first entry that is not a listed proxy is the visitor's. If that entry is not a plain IPv4 or IPv6 address (`unknown`, empty, an address with a port, a bracketed IPv6 address such as `[2001:db8::1]` or `[2001:db8::1]:443`, a zone id, or anything else), the walk stops there and no `net` is sent (the visitor gets the base price); it never falls back to `REMOTE_ADDR` or to an entry further left. A request from a listed proxy with no visitor entry (`X-Forwarded-For` missing, empty, only commas or spaces, or only listed proxies) also sends no `net`, never the proxy's own network. `::ffff:a.b.c.d` is treated as `a.b.c.d` for `REMOTE_ADDR`, every `X-Forwarded-For` entry and the proxy list, so a mapped visitor address gives its IPv4 `/24` network. Unset or empty: `X-Forwarded-For` is never read. The plugin's per-IP challenge rate limit keeps using `REMOTE_ADDR`.

**WordPress issuer** (packages/wp-toll-gate): the same endpoints under `/wp-json/toll/v1/` (`challenge`, `redeem`, `status`, `health`, `siteverify`), same bodies and errors, with three differences: it is work-only (`offers` is always `[]` and a paid redeem is 400 `unsupported`), the standard engine only, and challenges are bound to `/wp-comments-post.php`, `/wp-login.php` or `/`. Counters use the names above, stored in the site's options and exported as CSV from Settings → Toll.

CORS: the request `Origin` is echoed only if it is in `allowed_origins`, with credentials allowed; never `*`.

Protected routes (middleware): a request without a valid pass gets `403 {"error":"toll_required","challenge":{…}}` (JSON clients, curl), or a short HTML page saying "This form needs JavaScript." when the client prefers HTML. Over the challenge rate limit, the 403 omits the challenge. `toll.fetch` solves the challenge in the 403 and retries once. An agent request (`client=agent` or `Toll-Client: agent`) gets `402 {"error":"payment_required","challenge_url":"/v1/challenge?site=…&action=…&path=…&client=agent&offers=0","offers":[…]}` with a `WWW-Authenticate` payment challenge instead, when an offer is available (settlement.md §4); otherwise the same 403. The 402 carries no inline challenge: the work option stays available through `challenge_url` (root-relative to the issuer origin, bound to the same site, action and path), and the challenge is minted only if the agent fetches it, so a paid write never pays for a work mint. A 403 never carries offers.

Metrics for protected routes (JSON lines on stdout): `pass_accept {rail, cls, action, remaining}`; `pass_reject {reason, action}` only for a pass that was presented and refused (`expired`, `exhausted` (a spent one-use pass replayed), `bad_sig`, `malformed`, `wrong_site`, `class_too_low`); `pass_absent {action, status}` for a request that carried no pass at all (first contact, `status` 402 or 403), which is **not** a rejection. Rejection rates are `pass_reject / (pass_accept + pass_reject)`. The counters line adds `pass_absent` and `turned_away` (gate 403s of any kind: work challenge, no-JS page, rate-limited; agent 402s are not counted). `challenge_minted` fires per challenge actually minted (the 403's inline challenge or a `/v1/challenge` fetch). `work_after_402 {action, site, cls}` fires when `/v1/challenge` is fetched with `offers=0`, i.e. an agent followed a 402's `challenge_url` to do the work instead of paying (`challenge_minted` fires for it as well); the counters line and `/demo/stats` carry a matching `work_after_402` counter, right after `paid`. Discovery (M11): `manifest_fetch` and `agents_json_fetch` count `GET /.well-known/toll.json` and `/.well-known/agents.json` (event lines of the same names, no visitor fields; the WordPress CSV has matching per-UTC-day columns). The MCP server keeps its own per-UTC-day counters (`mcp_tools_list`, `mcp_call_<tool>`, `mcp_offer_returned`, `mcp_paid`; packages/mcp/README.md). The counters line also carries `page_view_gate_confirmed` (1 when the owner confirmed gating page views at start, else 0). The 402 funnel: `offer_shown` = `paid` + `work_after_402` + abandoned, so **abandoned 402s = `offer_shown` − `paid` − `work_after_402`** (agents that got a 402 and neither paid nor fetched the work challenge, including `agent-pay`'s deliberate spent-pass check).

## 8. Test vectors

[`vectors.json`](vectors.json) (regenerate with `npm run vectors`; output is deterministic):

- `engine_secrets`: the engine's two HMAC secrets derived from the Toll secret (`HMAC-SHA256(secret, "toll/work-adapter/v1/challenge" | ".../key")`, hex).
- `work[]`: engine-issued fixtures (standard write, standard search, hardened account): challenge, canonical `signing_input`, the issuer's `secret_counter`, the `solution`, and the `pass` (claims → token) a redeem at `now` produces with fixed `sub`/`jti`.
- `work_invalid[]` (15): tampered envelope or engine payload, unsigned, wrong secret, expired, future `iat`, wrong key, wrong counter, solution for another challenge, engine payload bound to another id, broken engine signature, missing solution, TTL over 120 s, unsupported alg, each with the expected error code.
- `pass[]`, `pass_invalid[]`, `pass_valid_checks[]`.

The vectors use a test-only secret. Node: `tests/protocol.test.ts`. PHP: `php tests/php/run-vectors.php` (after `composer install` in `packages/server-php`). The browser test also checks the shipped workers reproduce each fixture.
