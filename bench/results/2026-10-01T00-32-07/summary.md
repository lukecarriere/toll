# Benchmark run 2026-10-01T00-32-07

Started 9/30/2026, 7:32:07 PM CT. Box CPU: Intel(R) Xeon(R) Processor, 8 vCPU (clock not reported by the VM), SHA-NI yes, kernel 6.12.94+, 16 GB RAM. Node v22.23.3. Load average before 1.6 / 1.2 / 1, after 1 / 1 / 1.1.
Default challenge: write, cost 2000, n 4, bits 32, unit_iterations 400,000. 10 warm-up solves, then 210 counted solves per profile; every counted solve kept. Percentiles: nearest-rank.
Worker CPU throttling via CDP: rejected by Chromium: Operation is only supported for pages, not workers.

|  | Desktop Chromium | Lighthouse mobile preset (devtools CPU x4) | Lighthouse mobile preset + OS CPU quota (45% of a core) | Real Android phone |
|---|---|---|---|---|
| Browser | 153.0.8010.12 | 153.0.8010.12 | 153.0.8010.12 | — |
| Challenge served (span per sub-puzzle) | 399 (4 x 2,000 iterations per try) | 239 (4 x 2,000 iterations per try) | 239 (4 x 2,000 iterations per try) | — |
| Counted solves (redeemed OK) | 210 (210) | 210 (210) | 210 (210) | — |
| Worker PBKDF2, iterations/s at cost 2,000 (median of 5) | 5,017,561 | 4,904,365 | 1,233,198 | — |
| Worker PBKDF2, iterations/s at cost 100,000 (median of 3) | 5,366,246 | 6,339,144 | 1,256,281 | — |
| Slowdown vs desktop (KDF, cost 2,000) | 1.00x | 1.02x | 4.07x | — |
| Effective iterations/s while solving | 5,972,670 | 5,853,120 | 1,397,734 | — |
| Solve time p50 (ms) | 268.0 | 163.0 | 707.8 | — |
| Solve time p95 (ms) | 396.3 | 253.1 | 995.5 | — |
| Solve time max (ms) | 524.0 | 326.6 | 1,399.6 | — |
| Solve time mean (ms) | 271.4 | 167.8 | 693.7 | — |
| Solves at or over 500 ms (shows Checking…) | 0.5% | 0.0% | 88.1% | — |
| Fetch + solve + redeem p50 / p95 (ms) | 282.5 / 411.3 | 1,320.4 / 1,415.7 | 1,904.0 / 2,199.6 | — |

Real Android phone: not available on the box; left empty on purpose (no estimate).

Raw data: `desktop.csv`, `lh-mobile-devtools.csv`, `lh-mobile-os4x.csv`, `results.json`.
