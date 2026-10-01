# Benchmark run 2026-10-01T01-24-06

Started 9/30/2026, 8:24:06 PM CT. Box CPU: Intel(R) Xeon(R) Processor, 8 vCPU, kernel 6.12.94+, 16 GB RAM. Node v22.23.3. Load average before 2.2 / 3.6 / 2.9, after 5.1 / 4.1 / 3.7 (shared box).
Challenge: write (4 units), solved as the widget solves it (the engine's solver and workers as served by the issuer, same worker count), through the real /v1/challenge and /v1/redeem. 10 warm-up solves, then the counted solves below; every counted solve kept. Percentiles: nearest-rank.

|  | Desktop, standard | Phone-like, standard (CPU quota 45% of a core) | Desktop, hardened | Phone-like, hardened (CPU quota 180% of a core) | Real Android phone |
|---|---|---|---|---|---|
| Engine | PBKDF2-SHA-256, 5,000 iterations per try | PBKDF2-SHA-256, 5,000 iterations per try | Argon2id t=2, m=19,456 KiB, p=1 | Argon2id t=2, m=19,456 KiB, p=1 | — |
| Workers | 4 | 4 | 4 | 4 | — |
| Expected tries / counter_max (issuer) | 257 / 512 | 154 / 307 | 17 / 32 | 10 / 19 | — |
| Counted solves (redeemed OK) | 210 (210) | 210 (210) | 210 (210) | 210 (210) | — |
| Tries per second while solving | 1,169.1 | 357.9 | 30.3 | 7.3 | — |
| Slowdown vs desktop, same mode | 1.00x | 3.27x | 1.00x | 4.15x | — |
| **Solve time p50 (ms)** | **208.5** | **416.2** | **548.5** | **1,405.1** | — |
| **Solve time p95 (ms)** | **404.2** | **714.9** | **1,041.7** | **2,295.7** | — |
| Solve time max (ms) | 514.5 | 908.4 | 1,348.8 | 2,614.9 | — |
| Solve time mean (ms) | 219.7 | 444.8 | 571.1 | 1,422.6 | — |
| Solves at or over 500 ms (shows Checking…) | 0.5% | 40.0% | 56.7% | 95.2% | — |
| Fetch + solve + redeem p50 / p95 (ms) | 223.0 / 417.7 | 498.3 / 798.5 | 640.4 / 1,110.8 | 1,520.8 / 2,401.9 | — |

Phone-like = mobile screen and UA (the issuer serves the mobile challenge, device_mult 0.6) with every Chromium process in a cgroup v2 CPU quota, so the solver workers are really slowed. The quota is set per mode for about 4x per core (standard keeps about one core busy, hardened keeps four); the achieved slowdown is the measured row above. It is an emulation on a Xeon, not a phone.
Real Android phone: not available on the box; left empty on purpose (no estimate).

Raw data: `desktop-standard.csv`, `desktop-hardened.csv`, `phone-standard.csv`, `phone-hardened.csv`, `results.json`.
