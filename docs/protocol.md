# Toll wire protocol v1 (work rail)

Status: phase 0/1 as amended (Amendment 1), implemented in `packages/protocol` + `packages/work-adapter` (TypeScript) and `packages/server-php` (PHP, with the engine's PHP library). Both pass [`vectors.json`](vectors.json). The paid rail is drafted separately in `docs/settlement.md` and adds no fields to anything below.

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

`challenge` is optional: a stateless verifier needs it; the issuer that minted the challenge can look it up by `challenge_id`. The widget always sends it. (The paid form `{ offer_id, kind, preimage, macaroon }` returns `400 unsupported` while settlement is off.)

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
| read | 0 (free) | unmapped GET |
| search | 1x | search |
| write | 4x | comments, forms, votes, cart; unmapped POST |
| account | 8x | signup, login, password reset |
| admin | 16x | staff mutations |

## 7. HTTP API

| Endpoint | Notes |
|---|---|
| `GET /v1/challenge?site=&action=&path=&client=widget\|agent` | `{ challenge, offers: [] }`. `site` defaults to the configured site. `action=read` is 400. Rate-limited per IP (default 60/min, 429 after). `offers` is always `[]` with settlement off. |
| `POST /v1/redeem` | §4. |
| `POST /v1/siteverify` | Form or JSON: `secret`, `response` (a pass, or a JSON redeem payload), optional `action`. Returns `{ success, action, hostname, challenge_ts }` or `{ success: false, "error-codes": […] }`. Spends one pass use. |
| `GET /v1/status` | Cookie or `Authorization` pass → `{ ok: true, exp, cls, n }` (n = remaining uses), else `{ ok: false }`. |
| `GET /v1/health` | `{ ok: true, v: "1.0.0", settlement: "off" }`; a small HTML status table when the client asks for `text/html`. |

CORS: the request `Origin` is echoed only if it is in `allowed_origins`, with credentials allowed; never `*`.

Protected routes (middleware): a request without a valid pass gets `403 {"error":"toll_required","challenge":{…}}` (JSON clients, curl), or a short HTML page saying "This form needs JavaScript." when the client prefers HTML. Over the challenge rate limit, the 403 omits the challenge. `toll.fetch` solves the challenge in the 403 and retries once.

## 8. Test vectors

[`vectors.json`](vectors.json) (regenerate with `npm run vectors`; output is deterministic):

- `engine_secrets`: the engine's two HMAC secrets derived from the Toll secret (`HMAC-SHA256(secret, "toll/work-adapter/v1/challenge" | ".../key")`, hex).
- `work[]`: engine-issued fixtures (standard write, standard search, hardened account): challenge, canonical `signing_input`, the issuer's `secret_counter`, the `solution`, and the `pass` (claims → token) a redeem at `now` produces with fixed `sub`/`jti`.
- `work_invalid[]` (15): tampered envelope or engine payload, unsigned, wrong secret, expired, future `iat`, wrong key, wrong counter, solution for another challenge, engine payload bound to another id, broken engine signature, missing solution, TTL over 120 s, unsupported alg, each with the expected error code.
- `pass[]`, `pass_invalid[]`, `pass_valid_checks[]`.

The vectors use a test-only secret. Node: `tests/protocol.test.ts`. PHP: `php tests/php/run-vectors.php` (after `composer install` in `packages/server-php`). The browser test also checks the shipped workers reproduce each fixture.
