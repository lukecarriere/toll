# Benchmark: in-browser work speed

`npm run bench` measures, in real Chromium on the box:

- raw WebCrypto PBKDF2-SHA256 speed inside a dedicated Web Worker (iterations per second), at the default `cost` of 2,000 iterations per call and at 100,000 per call;
- the solve-time distribution for the **default challenge** the issuer serves (`action=write`), with 10 warm-up solves and 210 counted solves per profile, every counted solve kept. Each solve is redeemed against the issuer, so only real, valid solutions are counted.

The page uses the same solver code and options as the widget worker (`packages/protocol/src/work.ts`, all sub-puzzles in parallel, one KDF call in flight each).

Profiles:

| id | What it is |
|---|---|
| `desktop` | Desktop Chromium (Playwright's Chromium build, new headless), 1350x940, no throttling. |
| `lh-mobile-devtools` | Lighthouse's mobile preset applied the way Lighthouse's devtools throttling does it: Moto G Power screen and user agent, `Emulation.setCPUThrottlingRate(4)` on the page, and the mobileSlow4G network (562.5 ms RTT, 1474.56 / 675 kbps). The issuer sees a mobile UA and serves the lighter mobile challenge (device_mult 0.6). |
| `lh-mobile-os4x` | Same preset, plus every Chromium process placed in a cgroup v2 with a CPU quota, so the worker is slowed too. |

Why the third profile exists: Chromium's CDP CPU throttling does not reach dedicated workers. The run records Chromium's answer when asked to throttle a worker target (`environment.worker_cpu_throttle_probe`, "Operation is only supported for pages, not workers"). The widget grinds only in a worker, so in `lh-mobile-devtools` the solve runs at full desktop speed; only the network and the UA-based challenge size change. `lh-mobile-os4x` gets a real slowdown from the OS instead. 25% of one core turned out to slow the worker about 7.8x (the other Chromium threads share the quota), so the default quota is 45%. Each run reports the slowdown it actually got (`kdf_slowdown_vs_desktop`) rather than assuming 4x.

A real Android phone is not available on the box, so there is no phone column. It has to be measured on a device before launch (PRD §3, M1).

Output: `bench/results/<UTC timestamp>/` with one CSV per profile (one row per counted solve), `results.json` (environment, preset constants, summary, raw rows and KDF runs) and `summary.json`. `bench/results/LATEST` names the newest run. Percentiles are nearest-rank.

Columns: `took_ms` is the solve time measured inside the worker; `solve_wall_ms` is the page's view of the same solve (postMessage round trip); `e2e_ms` is fetch challenge + solve + redeem, which includes the emulated network on mobile profiles; `iterations = tries x cost`.

Environment variables: `BENCH_SOLVES` (default 210), `BENCH_WARMUP` (10), `BENCH_CGROUP_QUOTA_PCT` (45), `BENCH_NO_CGROUP=1` to skip the OS profile. The OS profile needs passwordless `sudo` and cgroup v2; it creates `/sys/fs/cgroup/tollbench` and removes it afterwards.
