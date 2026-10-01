# Benchmark: in-browser work speed

`npm run bench` measures, in real Chromium on the box, the solve-time distribution for the
**default write challenge** in both work modes:

- **standard**: PBKDF2-SHA-256, the default;
- **hardened**: Argon2id, the memory-hard mode.

The page solves exactly the way the widget does. It uses the work engine's solver (the same
module `toll.js` bundles, `@toll/work-adapter/browser`), driving the engine's workers as the
issuer serves them (`/toll/v1/toll.worker.js` and `toll.worker-argon2id.js`, with their CSP), with
the same worker count (`min(4, cores)`). It goes through the real `/v1/challenge` and `/v1/redeem`,
and every solve is redeemed, so only real, valid solutions are counted. Each profile runs 10 warm-up
solves, then 210 counted solves, and every counted solve is kept.

Profiles:

| id | What it is |
|---|---|
| `desktop-standard`, `desktop-hardened` | Desktop Chromium (Playwright's Chromium build, new headless), 1350x940, no throttling. |
| `phone-standard`, `phone-hardened` | Mobile screen and UA, so the issuer serves the lighter mobile challenge (device_mult 0.6). Every Chromium process is placed in a cgroup v2 with a CPU quota, so the worker threads are slowed: 45% of one core for standard, and 180% (4 x 45%) for hardened. |

Why a cgroup and not DevTools CPU throttling: Chromium's CDP throttle does not reach dedicated
workers. The previous run recorded Chromium's answer, "Operation is only supported for pages, not
workers", and all solving happens in workers.

45% of one core slowed one busy thread about 4x in an earlier calibration. The quota follows how many
cores the desktop solve really keeps busy:
- WebCrypto PBKDF2 (standard) keeps about one core busy even with 4 workers, so its quota is 45%. A first run at 180% left it unthrottled (0.99x).
- WASM Argon2id (hardened) keeps all four workers busy, so its quota is 180%.

Each run reports the slowdown it actually got (`slowdown_vs_desktop`, tries per second against
desktop in the same mode) instead of assuming 4x.

A real Android phone is not available on the box, so there is no phone column. It has to be
measured on a device before launch (PRD §3, M1).

Output goes to `bench/results/<UTC timestamp>/`:
- one CSV per profile, one row per counted solve: `took_ms`, `e2e_ms`, `tries = counter + 1`, and the issuer's `counter_max` and `expected_tries`;
- `results.json`;
- `summary.json`;
- `summary.md` (from `node bench/summarize.ts`).

`bench/results/LATEST` names the newest run. Percentiles are nearest-rank.

Environment variables:
- `BENCH_SOLVES` (default 210)
- `BENCH_WARMUP` (10)
- `BENCH_SOLVES_HARDENED_PHONE` (defaults to `BENCH_SOLVES`)
- `BENCH_CGROUP_QUOTA_PCT_STANDARD` (45)
- `BENCH_CGROUP_QUOTA_PCT_HARDENED` (180)
- `BENCH_NO_CGROUP=1` skips the phone-like profiles.
- `BENCH_PROFILES=desktop-standard,phone-hardened,...` runs only the listed profiles.

The phone-like profiles need passwordless `sudo` and cgroup v2. The bench creates
`/sys/fs/cgroup/tollbench` and removes it afterwards.

History: `results/2026-10-01T00-32-07/` was measured on the **retired** built-in PBKDF2 miner
(before Amendment 1). Its CSV columns differ, and it is kept for comparison only.
