# Threat model (phase 1 draft)

Status: draft written with phase 1. The full threat model is a phase 3 deliverable (PRD P2-6); this version records what the work rail does today and what the settlement draft plans. Spec §16 lists the required topics; each has a section.

## Assets and promises
- Writes on protected routes only happen with a valid pass (fail closed).
- Visitors' form contents never leave the page through Toll; no third-party cookies; no IP blocking.
- The site secret never reaches a browser.

## 1. GPU farms vs work (why settlement exists)
PBKDF2-SHA256 is cheap on GPUs. The findings memo estimates a rented RTX 4090 grinds a default-size challenge for a tiny fraction of a cent, far below the write offer price. Work therefore stops cheap scripts and casual spam (it costs real CPU per request and per pass, see the bench numbers in docs/policy.md) but does not stop a funded operator. What does: per-request latency that grows with velocity, the hardened mode (memory-hard Argon2id, available now as `work.mode: hardened`, off by default), and the settlement rail, where a funded client's spending becomes the site owner's income. Today (phase 1) velocity escalation exists in the policy code but is off by default.

## 2. Pre-computation and replay
- Every challenge has a fresh 16-byte id and a fresh engine nonce and salt; the key prefix cannot be precomputed. The engine payload is bound to the Toll id (`data.tid`) under the engine's own HMAC and again under the Toll signature.
- The puzzle is solved and verified by a pinned, self-hosted engine (docs/adapters.md). Neither the visitor's browser nor the issuer calls any third-party service; the widget dist build fails on any absolute URL or captcha/CDN host.
- `challenge.id` is single use (replay store, TTL `exp - now + 60`); the id is claimed before the work check so one signed challenge costs at most one server-side verify.
- Challenges live at most 120 s. Passes expire (900 s) and carry a use count (20) tracked per `jti`.
- Replay store unavailable → redeem and protected writes return 503, never accept.

## 3. Forgery
- Challenges, passes and (drafted) offers are HMAC-SHA256 with the site secret over canonical bytes; MACs compared in constant time. Unknown fields and unsigned challenges are rejected.
- Domain separation: challenge MACs cover canonical JSON (starts with `{`), pass MACs cover `b64url.b64url` (starts with `eyJ`), offer MACs are prefixed `toll-offer-v1.`.

## 4. Server cost (abuse of the issuer itself)
- Minting a challenge costs the server one KDF call (the secret counter's key): one 5,000-iteration PBKDF2 in standard mode, one Argon2id (19 MiB, t=2) in hardened mode. Verifying costs one HMAC (the engine's key signature), so a flood of bad solutions is cheap to reject. `GET /v1/challenge` and the challenge attached to a 403 share a per-IP limit (default 60/min); over the limit the 403 carries no challenge. A distributed flood can still make the issuer spend CPU; an edge cache of pre-minted challenges is a phase 3 option, and matters most in hardened mode.
- Bodies are capped at 1 MB; the middleware reads only urlencoded/JSON bodies.

## 5. Stolen passes and XSS
- A pass is a bearer credential for its class until it expires or its uses run out. The cookie is HttpOnly + SameSite=Lax (+ Secure on HTTPS). The widget holds a pass in memory for the hidden `toll-pass` field and `toll.fetch`, so XSS on the page can read it; XSS already owns the page's forms, so this adds little, and the pass is capped at 20 actions / 15 minutes.
- Passes are not bound to IP (spec §8.1); binding to a first-party cookie is optional.

## 6. Invoice substitution (settlement draft)
Offer id and payment hash are inside the offer MAC, so paying a cheap invoice cannot redeem an expensive offer. Unit-tested in the stub.

## 7. Underpaying (settlement draft)
The amount is fixed in the MAC'd caveats and in the invoice; proof is the preimage of that exact invoice's payment hash. Partial or different-amount payments produce a different hash.

## 8. Settlement outage (settlement draft)
Degrade to work-only: offers empty, `settlement_degraded` logged, writes still possible through work, never a 500.

## 9. Privacy
No form bodies, cookies, Authorization values, passes, IPs or invoices in logs (tested). The widget never reads field values (tested by capturing the browser's requests to the issuer). No calls to third-party CAPTCHA services.

## 10. The honest limit
A funded treasury can still pay. Toll does not claim to stop it; it makes that spending payable to the site owner, and makes grinding instead of paying slow at volume.
