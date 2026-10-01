# Policy defaults (phase 1)

This page lists the work policy that ships in phase 1, why each default is what it is, and the
measured benchmark behind it. Every number in the benchmark section comes from a real run
on the build box; the raw files are linked. Nothing here is an estimate unless it says so.

## 1. What the policy controls

`effective_cost` (spec §9.5) decides how much work a challenge asks for. In this version:

```
expected_iterations = unit_iterations * class_mult[action]
                    * device_mult      // 0.6 mobile, 1.0 desktop (from the UA class)
                    * velocity_mult    // 1, 2, 4, 8, 16 (off by default in phase 1, see §4)
                    worst case (n * cost * span) clamped to max_iterations
```

The issuer turns `expected_iterations` into a challenge with fixed `cost` (PBKDF2 iterations per try),
`n` sub-puzzles and `bits`, and picks `span = counter_end - counter_start` so that the expected
number of tries is `expected_iterations / cost`. Each sub-puzzle's answer is uniform in its span, so
the expected tries per sub-puzzle are `(span + 1) / 2` and the worst case is `span`. See
`docs/protocol.md` §3 for the exact rule.

## 2. Defaults

| Setting | Default | Where | Why |
|---|---|---|---|
| `algos` | `["pbkdf2-sha256"]` | `defaults.algos` | WebCrypto has PBKDF2 natively in every browser and in PHP (`hash_pbkdf2`). Argon2id is phase 3 (§9.2). |
| `cost` | 2,000 iterations per try | `work.cost` | Small enough that one try is ~0.4 ms on the box's desktop Chromium, so the solver can cancel quickly and the span is wide (hard to guess); large enough that verification stays one KDF call per sub-puzzle (n x 2,000 iterations on the server). |
| `n` | 4 sub-puzzles | `work.n` | Lets the worker run four searches in parallel and narrows the spread of solve time (the sum of four uniform draws), which keeps p95 closer to p50. |
| `bits` | 32 | `work.bits` | The published target is the first 4 bytes of the derived key. 32 bits makes a false match inside a span of a few hundred tries vanishingly unlikely (about span / 2^32). |
| `unit_iterations` | 400,000 | `work.unit_iterations` | One "unit" of work. Calibrated on the box so a write (4 units) lands inside the §9.3 "quiet human, desktop" band of 200–400 ms. See §3 for the measured result. |
| class multipliers | read 0, search 1, write 4, account 8, admin 16 | `packages/protocol/src/classes.ts` | §8.4 ordering. Read asks for no work. The phase 1 demo exercises search and write. A pass for a higher class covers lower ones. |
| `device_mult` | mobile 0.6, desktop 1.0 | `work.device_mult` | Spec §9.5. A phone gets 60% of the desktop work. |
| `max_iterations` | 11,000,000 | `work.max_iterations` | Cap on the worst case of any one challenge (`n x cost x span`). Example: with velocity at its top step a write would expect 25.6M iterations; the cap holds it to 11M worst case, 5.5M expected. The widget also has an 8 s wall-clock cap (`defaults.max_solve_ms`, §9.5): past it, it stops and shows the checkbox state. |
| `velocity_steps` | 20→x2, 40→x4, 80→x8, 160→x16 per 60 s | `work.velocity_steps` | Spec §9.3 and §9.5. Keyed by site + /24 (IPv4) or /48 (IPv6) + action. Raises cost only; never blocks. |
| `adaptive.velocity` | `false` | `adaptive.velocity` | Off by default in phase 1: the multiplier is implemented and tested, but the right thresholds need real traffic (phase 3 work). |
| `pass_ttl_s` / `pass_uses` | 900 s / 20 uses | `defaults` | Spec §8.3 example values. |
| `challenge_ttl_s` | 120 s | `defaults` | Spec §8.1; the issuer refuses longer values. |
| `rate_limit.challenge_per_min` | 60 per IP | `rate_limit` | Protects the issuer's CPU (minting costs n x cost KDF iterations). The demo raises it to 300 so the hammer can be re-run. |

## 3. Measured benchmark

<!-- BENCH:START (generated from bench/results/2026-10-01T00-32-07/summary.md) -->
Run `2026-10-01T00-32-07` (UTC stamp).

Started 9/30/2026, 7:32:07 PM CT. Box CPU: Intel(R) Xeon(R) Processor, 8 vCPU (clock not reported by the VM), SHA-NI yes, kernel 6.12.94+, 16 GB RAM. Node v22.23.3. Load average before 1.6 / 1.2 / 1, after 1 / 1 / 1.1 (shared box).
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

Raw data in `bench/results/2026-10-01T00-32-07/`: `desktop.csv`, `lh-mobile-devtools.csv`, `lh-mobile-os4x.csv`, `results.json`.
<!-- BENCH:END -->

### How to read it

- **Desktop Chromium** is headless Chromium on the box with no throttling.
- **Lighthouse mobile preset (devtools CPU x4)** applies Lighthouse's mobile settings the way
  Lighthouse's devtools mode does: Moto G Power screen and UA, CPU x4 via
  `Emulation.setCPUThrottlingRate`, and the slow-4G network. **Chromium does not apply that CPU
  throttle to dedicated workers** (the probe line above records Chromium's answer), and all
  hashing runs in a worker (§10), so in this column the solve runs at desktop speed. The challenge
  is still smaller (device_mult 0.6, the UA is mobile), which is why solve times drop. Treat this
  column as "what Lighthouse would report", not as phone speed.
- **Lighthouse mobile preset + OS CPU quota** is the same profile with every Chromium process placed
  in a Linux cgroup v2 with a CPU quota, so the worker thread really is slowed. The achieved slowdown
  is measured, not assumed (the "Slowdown vs desktop" row). This is the closest the box gets to a
  mid-range phone, and it is still an emulation.
- **Real Android phone** is empty on purpose: there is no phone on the box. Phase 1 ships without it
  (PM decision); it should be filled from a real device before the phone defaults are trusted.
- `took_ms` is the worker's own solve time (what the widget reports and what decides whether
  "Checking…" is shown). The fetch + solve + redeem row adds the two HTTP round trips; in the mobile
  columns those include Lighthouse's emulated 562.5 ms RTT.

### Reproduce

```
npm run bench                       # all profiles; needs passwordless sudo for the cgroup profile
BENCH_NO_CGROUP=1 npm run bench     # skip the OS-quota profile
BENCH_SOLVES=50 npm run bench       # fewer solves
node bench/summarize.ts             # re-render summary.md for the latest run
```

Method details: `bench/README.md`.

## 4. What the numbers mean for the defaults

Measured against the §9.3 targets (run above):

- **Quiet human, desktop (target 200–400 ms):** p50 268 ms, p95 396 ms, max 524 ms. Inside the band;
  1 of 210 solves (0.5%) crossed 500 ms and would have shown "Checking…". No change.
- **Quiet human, phone (target 300–600 ms):** the only phone-like column is the OS-quota emulation
  (measured 4.07x slower than desktop): p50 708 ms, p95 996 ms, and 88% of solves would show
  "Checking…". That is **above the band**. Holding p50 near 450 ms on a device that slow would
  need `device_mult.mobile` around 0.38 instead of 0.6. **The default is not changed**: a cgroup
  quota on a Xeon is not a phone, and §9.5 fixes 0.6. This needs a real-device run and a decision
  (see "Open items").
- **The Lighthouse devtools column cannot show phone speed** because Chromium does not throttle workers.
  Its p50 of 163 ms is the smaller mobile challenge (span 239 vs 399) run at desktop speed.
- **Server cost:** verifying a write is n x cost = 8,000 PBKDF2 iterations (about 1.6 ms if Node ran at the
  browser worker's measured rate. Server-side speed was not benchmarked). Minting costs the same.
- **Velocity (off by default):** work scales linearly with the multiplier, so (derived, not measured) a
  desktop write reaches the §9.3 "1–2 s" band only around x4. Thresholds need real traffic before velocity is on by default.

## 5. Pay vs grind

Filled by the Data Scientist, 2026-09-30 (CT). Question: for an automated client, is it cheaper to pay
the settlement offer or to grind the PBKDF2 work challenge on rented GPUs? Everything below is
**derived** from the inputs listed; no GPU run was made on this project.

**Inputs**
- Work: `unit_iterations` 400,000; class multipliers search 1, write 4, account 8, admin 16; desktop
  `device_mult` 1.0; velocity x1–x16; `max_iterations` 11M worst case, about 5.5M expected (§2).
- Prices: `docs/settlement.md` §3, `amount_msat = base_msat × velocity_mult` (search 2,000, write
  10,000, account 25,000, admin 100,000 msat), converted at about $85,000 per BTC (Sep 30, 2026 spot,
  findings memo). Real offers use the live rate.
- GPU: one RTX 4090 does about 8.86 billion PBKDF2-HMAC-SHA256 iterations a second (public hashcat
  benchmark, mode 10900: 8,865.7 kH/s at 999 iterations). Rented at about $0.34 an hour (RunPod
  community cloud), which is about $0.000094 per GPU-second. Spot prices go lower, so grind costs here
  are an upper bound.
- Desktop browser time is scaled from the measured write p50 (268 ms at 1.6M iterations, §3).
- "Per write" divides one solve across the 20 uses of a work pass (`pass_uses: 20`, 900 s), which
  any client that solves the work gets.

| Class | Velocity | Expected work (iterations) | Desktop browser time | One RTX 4090 time | Grind cost per challenge | Grind cost per write (20-use pass) | Pay per write | Pay ÷ grind (per challenge) | Pay ÷ grind (per write) |
|---|---|---|---|---|---|---|---|---|---|
| search | x1 | 400,000 | 67 ms | 0.05 ms | $4.3e-9 | $2.1e-10 | $0.0017 | 398,558x | 7,971,151x |
| search | x2 | 800,000 | 134 ms | 0.09 ms | $8.5e-9 | $4.3e-10 | $0.0034 | 398,558x | 7,971,151x |
| search | x4 | 1,600,000 | 268 ms | 0.18 ms | $1.7e-8 | $8.5e-10 | $0.0068 | 398,558x | 7,971,151x |
| search | x8 | 3,200,000 | 536 ms | 0.36 ms | $3.4e-8 | $1.7e-9 | $0.0136 | 398,558x | 7,971,151x |
| search | x16 | 5,500,000 (cap) | 921 ms | 0.62 ms | $5.9e-8 | $2.9e-9 | $0.0272 | 463,776x | 9,275,521x |
| write | x1 | 1,600,000 | 268 ms | 0.18 ms | $1.7e-8 | $8.5e-10 | $0.0085 | 498,197x | 9,963,939x |
| write | x2 | 3,200,000 | 536 ms | 0.36 ms | $3.4e-8 | $1.7e-9 | $0.0170 | 498,197x | 9,963,939x |
| write | x4 | 5,500,000 (cap) | 921 ms | 0.62 ms | $5.9e-8 | $2.9e-9 | $0.0340 | 579,720x | 11,594,401x |
| write | x8 | 5,500,000 (cap) | 921 ms | 0.62 ms | $5.9e-8 | $2.9e-9 | $0.0680 | 1,159,440x | 23,188,803x |
| write | x16 | 5,500,000 (cap) | 921 ms | 0.62 ms | $5.9e-8 | $2.9e-9 | $0.1360 | 2,318,880x | 46,377,605x |
| account | x1 | 3,200,000 | 536 ms | 0.36 ms | $3.4e-8 | $1.7e-9 | $0.0212 | 622,746x | 12,454,923x |
| account | x2 | 5,500,000 (cap) | 921 ms | 0.62 ms | $5.9e-8 | $2.9e-9 | $0.0425 | 724,650x | 14,493,002x |
| account | x4 | 5,500,000 (cap) | 921 ms | 0.62 ms | $5.9e-8 | $2.9e-9 | $0.0850 | 1,449,300x | 28,986,003x |
| account | x8 | 5,500,000 (cap) | 921 ms | 0.62 ms | $5.9e-8 | $2.9e-9 | $0.1700 | 2,898,600x | 57,972,006x |
| account | x16 | 5,500,000 (cap) | 921 ms | 0.62 ms | $5.9e-8 | $2.9e-9 | $0.3400 | 5,797,201x | 115,944,013x |
| admin | x1 | 5,500,000 (cap) | 921 ms | 0.62 ms | $5.9e-8 | $2.9e-9 | $0.0850 | 1,449,300x | 28,986,003x |
| admin | x2 | 5,500,000 (cap) | 921 ms | 0.62 ms | $5.9e-8 | $2.9e-9 | $0.1700 | 2,898,600x | 57,972,006x |
| admin | x4 | 5,500,000 (cap) | 921 ms | 0.62 ms | $5.9e-8 | $2.9e-9 | $0.3400 | 5,797,201x | 115,944,013x |
| admin | x8 | 5,500,000 (cap) | 921 ms | 0.62 ms | $5.9e-8 | $2.9e-9 | $0.6800 | 11,594,401x | 231,888,025x |
| admin | x16 | 5,500,000 (cap) | 921 ms | 0.62 ms | $5.9e-8 | $2.9e-9 | $1.3600 | 23,188,803x | 463,776,051x |

**What it says**
1. On the PBKDF2 rail, paying never wins on cost. Grinding a write is about 500,000x cheaper per
   challenge at x1, and about 10 million x cheaper per write once the 20-use pass is counted. The
   findings memo's "at least 200x" assumed a 100M iterations/s browser; at the measured browser speed
   the real gap is about 2,500 times larger, so read the memo figure as a loose lower bound.
2. Velocity widens the gap instead of closing it. The price keeps doubling, but work stops at the
   `max_iterations` cap (reached at write x4, account x2, admin x1), so a GPU's cost per challenge
   tops out at about $0.00000006 while a write offer climbs to $0.136 at x16. Difficulty and price stop
   moving together once the cap is hit (spec §6.7).
3. One 4090 solves about 1,600 capped challenges a second (about 32,000 writes a second on 20-use
   passes). Throughput is limited by the per-IP challenge rate limit (60 a minute), not by cost, and
   residential proxies get around per-IP limits (21% of bad-bot attacks used them, Imperva 2025).
4. So agents pay for convenience, not savings: the agent SDK pays by default (spec §6.3) and needs no
   GPU setup. Settlement's value against a funded attacker is that its spend lands with the site
   owner (spec §16), not that it is cheaper than the work.
5. The only work-side lever that narrows the gap is memory-hard work (argon2id, phase 3). Its GPU
   throughput has not been measured; add a GPU column for it here in phase 3.

**For product (not a spec change):** with the current rules, a client over the work cap still gets
the work option, so it never has to pay. Whether a high-velocity, over-cap client should ever be
offered payment only is a product call (it touches §9.5 "never hard-block humans"), and it needs
real traffic data first.

## 6. Open items

- Real Android device column (empty). Until it is filled, the phone defaults are unverified. On the OS-quota emulation they miss the §9.3 phone band (see §4). Decision for Luke and the Data Scientist: keep 0.6, lower it, or wait for device data.
- Velocity thresholds need real traffic before `adaptive.velocity` is turned on by default.
- `device_mult` comes from the UA class only; the "previous took_ms EMA" input from §9.5 is logged
  (`redeem_ok.took_ms`) but not yet fed back into cost.
- `suspicion_mult` (§9.5, optional) is not implemented.
