# Policy defaults (phase 1, as amended)

This page lists the work policy that ships in phase 1, why each default is what it is, and the
measured benchmark behind it. Every number in the benchmark section comes from a real run
on the build box; the raw files are linked. Nothing here is an estimate unless it says so.

## 1. What the policy controls

`effective_cost` (spec §9.5) decides how much work a challenge asks for. Since Amendment 1 the
puzzle is the work engine's (docs/adapters.md); Toll's policy decides only how many engine tries a
challenge needs:

```
expected_tries = unit_tries[mode] * class_mult[action]
               * device_mult      // 0.6 mobile, 1.0 desktop (from the UA class)
               * velocity_mult    // 1, 2, 4, 8, 16 (off by default in phase 1, see §4)
counter_max    = min(max_units * unit_tries[mode], round(2 * expected_tries))
```

The issuer hides the answer at a secret counter drawn uniformly from `[0, counter_max)`, so a
solve takes about `counter_max / 2` tries on average and never more than `counter_max`. The cost
of one try is fixed per mode. `docs/protocol.md` §3 has the rule.

## 2. Defaults

| Setting | Default | Where | Why |
|---|---|---|---|
| `mode` | `standard` | `work.mode` | Standard is PBKDF2-SHA-256. The browser has it natively in WebCrypto, verification is one HMAC, and minting is one PBKDF2 call. `hardened` switches to Argon2id (memory-hard) for sites under GPU pressure. It is heavier on phones, and minting costs the issuer one Argon2id call per challenge. |
| `standard.cost` | 5,000 PBKDF2 iterations per try | `work.standard.cost` | One try is a few ms per worker on desktop, so cancelling at the time cap is quick and the counter range stays wide. |
| `standard.unit_tries` | 64 | `work.standard.unit_tries` | One "unit" of work. Calibrated on the box so a desktop write (4 units) sits under the 500 ms "Checking…" threshold even at p95. See §3. |
| `hardened` | Argon2id t = 2, m = 19,456 KiB (19 MiB), p = 1 | `work.hardened` | The OWASP minimum Argon2id profile. 19 MiB per worker keeps four workers under 80 MB on a phone, and the server can mint at an acceptable cost. |
| `hardened.unit_tries` | 4 | `work.hardened.unit_tries` | A desktop write expects 16 Argon2id tries. See §3 for the measured time on both profiles. |
| class multipliers | read 0, search 1, write 4, account 8, admin 16 | `packages/protocol/src/classes.ts` | §8.4 ordering. Read asks for no work. The phase 1 demo exercises search and write. A pass for a higher class covers lower ones. |
| `device_mult` | mobile 0.6, desktop 1.0 | `work.device_mult` | Spec §9.5. A phone gets 60% of the desktop work. |
| `max_units` | 28 | `work.max_units` | Cap on the worst case of any one challenge (`counter_max ≤ 28 units`, so 14 units expected at most). With velocity at its top step a write would expect 64 units; the cap holds it to 28 worst case. The widget also has an 8 s wall-clock cap (`defaults.max_solve_ms`, §9.5): past it, the widget stops and shows the checkbox state. |
| `velocity_steps` | 20→x2, 40→x4, 80→x8, 160→x16 per 60 s | `work.velocity_steps` | Spec §9.3 and §9.5. Keyed by site + /24 (IPv4) or /48 (IPv6) + action. Raises cost only; never blocks. |
| `adaptive.velocity` | `false` | `adaptive.velocity` | Off by default in phase 1. The multiplier is implemented and tested, but the right thresholds need real traffic (phase 3 work). |
| `pass_ttl_s` / `pass_uses` | 900 s / 20 uses | `defaults` | Spec §8.3 example values. |
| `challenge_ttl_s` | 120 s | `defaults` | Spec §8.1; the issuer refuses longer values. |
| `rate_limit.challenge_per_min` | 60 per IP | `rate_limit` | Protects the issuer's CPU: minting costs one KDF call: about 1 ms in standard mode, about 52 ms p50 (91 ms p95) of Argon2id in hardened mode (§4). The demo raises it to 300 so the hammer can be re-run. |

## 3. Measured benchmark

<!-- BENCH:START (generated from bench/results/2026-10-01T01-24-06/summary.md) -->
Run `2026-10-01T01-24-06` (UTC stamp). Work engine as of Amendment 1; the retired built-in miner's run (`2026-10-01T00-32-07`) is kept in `bench/results/` as history only.

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

Raw data in `bench/results/2026-10-01T01-24-06/`: `desktop-standard.csv`, `desktop-hardened.csv`, `phone-standard.csv`, `phone-hardened.csv`, `results.json`.
<!-- BENCH:END -->

### How to read it

- **Desktop** is headless Chromium on the box with no throttling.
- **Phone-like** uses a mobile screen and UA, so the issuer serves the mobile challenge (device_mult 0.6). Every Chromium process runs in a Linux cgroup v2 CPU quota, so the solver workers really are slowed. DevTools CPU throttling does not reach dedicated workers, so it can't be used here.
  - The quota differs by mode because the two engines use the CPU differently. WebCrypto PBKDF2 keeps about one core busy even with four workers; the desktop rate is barely above one worker's. WASM Argon2id keeps all four busy.
  - Achieved slowdowns are **3.27x** (standard) and **4.15x** (hardened), measured, not assumed.
  - This is the closest the box gets to a mid-range phone, and it is still an emulation.
- **Real Android phone** is empty on purpose: there is no phone on the box. It has to be filled from a real device before the phone defaults are trusted.
- `took_ms` is the page's own solve time, which is what decides whether "Checking…" is shown. The fetch + solve + redeem row adds the two HTTP round trips to a local issuer.

### Reproduce

```
npm run bench                       # all four profiles; needs passwordless sudo for the phone-like ones
BENCH_NO_CGROUP=1 npm run bench     # desktop only
BENCH_SOLVES=50 npm run bench       # fewer solves
node bench/summarize.ts             # re-render summary.md for the latest run
```

Method details: `bench/README.md`.

## 4. What the numbers mean for the defaults

Measured against the §9.3 targets (run above):

- **Standard mode, desktop (target 200–400 ms).** p50 209 ms, p95 404 ms, max 515 ms. That is inside the band; 1 of 210 solves (0.5%) crossed 500 ms and would have shown "Checking…". `unit_tries` stays at 64. A first calibration run of 40 solves gave the same picture (p50 191 ms).
- **Standard mode, phone-like (target 300–600 ms).** p50 416 ms, p95 715 ms. The p50 is inside the band, p95 is over it, and 40% of solves would show "Checking…".
  - This emulation is only 3.27x slower than desktop, not 4x, so a real 4x phone would be somewhat slower still.
  - That is better than the retired miner on its 4x emulation (p50 708 ms).
  - The default is not changed; it needs real-device data.
- **Hardened mode, desktop.** p50 549 ms, p95 1,042 ms; 57% of solves show "Checking…". Memory-hard work is heavier by design, which is why it is opt-in.
- **Hardened mode, phone-like.** p50 1,405 ms, p95 2,296 ms; 95% show "Checking…", and the worst case (2.6 s) stays well under the 8 s cap. That is the §9.3 "1–2 s" escalation band, as a *default* for every visitor. **Hardened mode should stay opt-in for sites under GPU pressure**, not become the default. The Data Scientist should decide whether to lower `hardened.unit_tries` (to 2 or 3) or `device_mult.mobile` in hardened mode.
- **Server cost.**
  - Verifying is one HMAC in both modes (the engine's key signature).
  - Minting costs one KDF call. A quick Node 22 measurement (20 mints after 5 warm-ups, 9/30 8:45 PM CT, shared box) gave PBKDF2 p50 1.1 ms (p95 1.4 ms) and Argon2id at 19 MiB, in WASM, p50 52 ms (p95 91 ms).
  - Hardened mode makes challenge floods a real server cost, so keep the per-IP challenge limit.
- **Velocity (off by default).** Work scales linearly with the multiplier up to `max_units` (28 units, 7x a write). This is derived, not measured: a desktop standard write reaches the "1–2 s" band around x4–x8.

## 5. Pay vs grind

> **Needs a re-run (Amendment 1).** This section was computed for the retired built-in miner
> (`unit_iterations` 400,000, cost 2,000, the 2026-10-01T00-32-07 bench). The engine now uses
> PBKDF2 at 5,000 iterations per try × 64 tries per unit (standard), or Argon2id (hardened), and
> the bench in §3 is new. The conclusion for standard mode is unlikely to change, since it is
> still PBKDF2-SHA-256. The hardened column is new and has no GPU figure yet. The table below is
> left as the Data Scientist wrote it until they re-run it.

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

- Real Android device column (empty). Until it is filled, the phone defaults are unverified. On the OS-quota emulation, standard mode's p50 is inside the §9.3 phone band and its p95 is over it; hardened mode is in the 1–2 s band (see §4). Decision for Luke and the Data Scientist: keep 0.6, lower it, or wait for device data.
- Hardened mode on phones: lower `hardened.unit_tries` or the mobile multiplier, or keep it as an opt-in heavy mode (Data Scientist).
- Pay vs grind (§5) needs a re-run on the new engine, including a GPU figure for Argon2id.
- Velocity thresholds need real traffic before `adaptive.velocity` is turned on by default.
- `device_mult` comes from the UA class only; the "previous took_ms EMA" input from §9.5 is logged
  (`redeem_ok.took_ms`) but not yet fed back into cost.
- `suspicion_mult` (§9.5, optional) is not implemented.
