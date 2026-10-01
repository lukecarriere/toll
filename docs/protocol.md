# Toll wire protocol v1 (work rail)

Status: phase 0/1, implemented in `packages/protocol` (TypeScript) and `packages/server-php` (PHP). Both pass [`vectors.json`](vectors.json). The paid rail is drafted separately in `docs/settlement.md` and adds no fields to anything below.

Conventions: all JSON, all times are Unix seconds, all IDs are opaque lowercase hex. Integers only (no floats anywhere that gets signed).

## 1. Canonical JSON and signatures

`sig = base64( HMAC-SHA256( site_secret, canonical_json(challenge without "sig") ) )`

Canonical JSON: UTF-8; object keys sorted by code unit at every level; no whitespace; strings escaped exactly as JavaScript's `JSON.stringify` does (so `/` is not escaped and non-ASCII is raw UTF-8, matching PHP `json_encode` with `JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE`); numbers are safe integers. `site_secret` is used as its UTF-8 bytes. Compare MACs in constant time. A challenge without `sig`, or with a bad one, is rejected.

## 2. Challenge object

```json
{
  "v": 1,
  "id": "8f3c0000000000000000000000000001",
  "site": "site_abc123",
  "algo": "pbkdf2-sha256",
  "cost": 2000,
  "n": 4,
  "bits": 32,
  "counter_start": 3000000000,
  "counter_end": 3000000064,
  "targets": ["fa0f2fdb", "a0174c6d", "19596181", "add3d808"],
  "mem_kib": 0,
  "parallelism": 1,
  "salt": "AAECAwQFBgcICQoLDA0ODw==",
  "bound": { "action": "write", "path_prefix": "/contact" },
  "iat": 1790000000,
  "exp": 1790000120,
  "sig": "C4BphBD+YoZR8ZtHUeQKVp2XGRpUPanHhJdmt9fPXlI="
}
```

This is `work[0]` from the vectors.

| Field | Rule |
|---|---|
| `v` | `1` |
| `id` | 16 random bytes, 32 hex chars. Single use. |
| `algo` | `pbkdf2-sha256` (the only algorithm in v1.0; `argon2id` escalation is phase 3). |
| `cost` | PBKDF2 iterations per attempt, 1..10,000,000. |
| `n` | Independent sub-puzzles, 1..16. Default 4. |
| `bits` | Target length in bits, multiple of 8, 8..64. Default 32. |
| `counter_start`, `counter_end` | Search range `[counter_start, counter_end)`, span 1..2^24, end ≤ 2^53. |
| `targets` | `n` lowercase hex strings, `bits/4` chars each. |
| `mem_kib`, `parallelism` | `0` and `1` for pbkdf2 (kept for the argon2id envelope). |
| `salt` | Base64 (standard, padded), 8..64 bytes. 16 random bytes in practice. |
| `bound` | `action` (search, write, account, admin) and a coarse `path_prefix` from the route table (`/` if unmapped). Never the client IP. |
| `iat`, `exp` | `0 < exp - iat ≤ 120`. Verifiers allow `iat` up to 5 s in the future. |

Unknown fields are rejected.

## 3. The work rule (deterministic effort + bits)

For each `i` in `0..n-1`:

```
salt_i  = SHA256( base64decode(salt) || uint32be(i) )
nonce_i = 16 lowercase hex chars of a uint64 counter c, counter_start <= c < counter_end
DK_i    = PBKDF2-HMAC-SHA256( password = ASCII(nonce_i), salt = salt_i, iter = cost, dkLen = 32 )
valid   iff hex(first bits/8 bytes of DK_i) == targets[i]
```

How the issuer builds a challenge: for each `i` it picks a secret counter `x_i` uniformly in the range, computes `DK_i` for `x_i`, and publishes its first `bits` bits as `targets[i]`. It does not store `x_i`; verification recomputes one DK per sub-puzzle.

Why this formulation (spec §9.1 and §23 asked us to pick one and pin it):
- **Bounded, predictable effort.** Each sub-puzzle takes at most `span` attempts and on average `(span+1)/2`. With `n = 4` the total is a sum of four uniforms: the worst case is exactly 2x the mean and the spread is narrow, so a phone is never handed an unlucky 30-second puzzle. Classic "leading zero bits" has an unbounded geometric tail.
- **Policy tunes milliseconds.** The issuer sets `span` from the expected work it wants (§5); `cost` stays fixed so per-attempt overhead stays constant.
- **Cheap to check.** Verifying costs `n x cost` iterations (8,000 by default; the issuer logs it as `verify_ms`, about 3 ms on the box), versus about `n x cost x span / 2` for the client.
- **Any matching counter counts.** With `bits = 32` an accidental second match in range has probability about `span x 2^-32`; if it happens it is still a valid solution.
- Not GPU-hard. PBKDF2 is the default for humans; GPU farms are handled by the settlement rail and by argon2id escalation (phase 3).

Reference solver: scan counters upward from `counter_start`; the vectors' expected nonces are the lowest matching counter.

## 4. Solution and redeem

Solution (from the widget):

```json
{ "id": "8f3c…", "nonces": ["00000000b2d05e05", "…", "…", "…"], "took_ms": 412, "ua_class": "mobile" }
```

`took_ms` and `ua_class` are hints for metrics and adaptive policy only. They are never trusted for authorization.

`POST /v1/redeem`

```json
{ "challenge_id": "8f3c…", "challenge": { …signed challenge… }, "solution": { "nonces": […], "took_ms": 412, "ua_class": "desktop" } }
```

`challenge` is optional: a stateless verifier needs it; the issuer that minted the challenge can look it up by `challenge_id`. The widget always sends it. (The paid form `{ offer_id, kind, preimage, macaroon }` returns `400 unsupported` while settlement is off.)

Verification order (both implementations): shape (`malformed` / `unsupported`) → signature (`bad_sig`) → time (`not_yet_valid` / `expired`) → site (`wrong_site`) → claim the id in the replay store (`replay`) → work (`bad_solution`). The id is claimed before the work is checked, so each signed challenge can cost the server at most one verification. If the replay store is unreachable the redeem fails with 503: writes fail closed.

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

- `work[]`: challenge, canonical `signing_input`, `sub_salt_hex`, expected `solution.nonces`, the full 32-byte `dk_hex` for each nonce, the issuer's `secret_counters`, and the `pass` (claims → token) a redeem at `now` produces with fixed `sub`/`jti`.
- `work_invalid[]`: tampered field, unsigned, wrong secret, expired, future `iat`, wrong / out-of-range / missing / malformed nonces, TTL over 120 s, unsupported algo, each with the expected error code.
- `pass[]`, `pass_invalid[]`, `pass_valid_checks[]`.

The vectors use a test-only secret. Node: `tests/protocol.test.ts`. PHP: `php tests/php/run-vectors.php`.
