# Server time per paid write, before/after the lazy work challenge (2026-09-30 CT)

40 paid writes per mode after 5 warm-up, local test backend, Node v22.23.3, same box.
Before = main 0302215 (402 carried an inline work challenge). After = the lazy change (402 carries
`challenge_url`; the challenge is minted only if fetched). `after.json` was measured on the working
tree before commit (`dirty: true`, base 0302215). Times in ms, median (p95).

| Mode | Before: per write | After: per write | Gate 402 before → after | challenge_minted / write |
|---|---|---|---|---|
| standard | 3.80 (4.75) | 2.14 (2.84) | 2.24 → 0.75 | 1 → 0 |
| hardened | 51.12 (63.08) | 1.83 (2.18) | 48.95 → 0.65 | 1 → 0 |

Redeem (~0.6-0.8) and retry (~0.5-0.7) are unchanged. The ~49 ms Argon2id mint that hardened mode
paid on every 402 is gone from paid writes; hardened and standard now cost the same per paid write.
The test payer (~0.4 ms, stands in for the client's payment app) is not included.
