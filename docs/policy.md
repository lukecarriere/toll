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
| `adaptive.velocity` | `false` | `adaptive.velocity` | Off by default. Turns on phase 3 adaptive (§6): velocity multipliers on work and price, plus Argon2id escalation. Built and tested; the thresholds still need real traffic before it is on by default. |
| `escalate` | at x4 velocity, and `admin` | `work.escalate` | Phase 3 (§6). With adaptive on, a standard-mode challenge switches to the hardened (Argon2id) engine at `velocity_mult >= 4` or for the listed classes. |
| `pass_ttl_s` / `pass_uses` | 900 s / 20 uses | `defaults` | Spec §8.3 example values. |
| `challenge_ttl_s` | 120 s | `defaults` | Spec §8.1; the issuer refuses longer values. |
| `rate_limit.challenge_per_min` | 60 per IP | `rate_limit` | Protects the issuer's CPU: minting costs one KDF call: about 1 ms in standard mode, about 52 ms p50 (91 ms p95) of Argon2id in hardened mode (§4). The demo raises it to 300 so the hammer can be re-run. |

## 3. Measured benchmark

<!-- BENCH:START (generated from bench/results/2026-10-01T01-24-06/summary.md) -->
Run `2026-10-01T01-24-06` (UTC stamp). Work engine as of Amendment 1; the retired built-in miner's run (`2026-10-01T00-32-07`) is kept in `bench/results/` as history only.

Started 9/30/2026, 8:24:06 PM CT. Box CPU: Intel(R) Xeon(R) Processor, 8 vCPU, kernel 6.12.94+, 16 GB RAM. Node v22.23.3. Load average before 2.2 / 3.6 / 2.9, after 5.1 / 4.1 / 3.7.
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
- **Hardened mode, phone-like.** p50 1,405 ms, p95 2,296 ms; 95% show "Checking…", and the worst case (2.6 s) stays well under the 8 s cap. That is the §9.3 "1–2 s" escalation band, as a *default* for every visitor. **Hardened mode should stay opt-in for sites under GPU pressure**, not become the default. A later measurement should decide whether to lower `hardened.unit_tries` (to 2 or 3) or `device_mult.mobile` in hardened mode.
- **Server cost.**
  - Verifying is one HMAC in both modes (the engine's key signature).
  - Minting costs one KDF call. A quick Node 22 measurement (20 mints after 5 warm-ups, 9/30 8:45 PM CT) gave PBKDF2 p50 1.1 ms (p95 1.4 ms) and Argon2id at 19 MiB, in WASM, p50 52 ms (p95 91 ms).
  - Hardened mode makes challenge floods a real server cost, so keep the per-IP challenge limit.
- **Velocity (off by default).** Work scales linearly with the multiplier up to `max_units` (28 units, 7x a write). This is derived, not measured: a desktop standard write reaches the "1–2 s" band around x4–x8.

## 5. Pay vs grind

Redone on 2026-09-30 (CT) for the pinned work engine (Amendment 1; see
`docs/adapters.md`). It replaces the table for the retired custom miner. The question is whether an
automated client spends less paying the settlement offer or grinding the work check on rented GPUs.
All grind figures are **derived** from public benchmarks. No GPU was run on this project.

**Inputs**
- Work (§2): standard is PBKDF2-SHA-256 at 5,000 iterations per try with 64 tries per unit. Hardened is
  Argon2id with t = 2, m = 19 MiB, p = 1, and 4 tries per unit. Classes are search 1, write 4,
  account 8 and admin 16 units, and `max_units` is 28. Expected tries = (`counter_max` + 1) / 2, as in
  `packages/protocol/src/policy.ts`. Desktop `device_mult` is 1.0. A client claiming a mobile UA gets
  0.6x the work, since the multiplier comes from the UA only.
- Prices: `docs/settlement.md` §3, `amount_msat = base_msat × velocity_mult` (search 2,000, write
  10,000, account 25,000 and admin 100,000 msat), at about $85,000 per BTC (Sep 30, 2026, findings memo).
- GPU, standard: an RTX 4090 runs about 8.86 billion PBKDF2-HMAC-SHA256 iterations a second (hashcat
  mode 10900, 8,865.7 kH/s at 999 iterations).
- GPU, hardened: an RTX 4090 manages 1,667 Argon2id hashes a second at 64 MB, t = 3, p = 1 (the hashcat
  pull request that added mode 34000, Netherlands Forensic Institute). Scaling linearly by memory ×
  passes to 19 MiB × 2 gives about 8,400 a second. That scaling is an assumption, not a measurement.
- GPU rental is about $0.34 an hour (RunPod community cloud), about $0.000094 per GPU-second. Spot is
  cheaper, so these grind costs are upper bounds.
- Each check below is one challenge. A solved challenge mints a 20-use, 900 s pass, so the grind cost
  per protected write is up to 20x lower again (multiply each pay ÷ grind ratio by up to 20).

| Class | Velocity | Pay per check | Standard: expected tries | Standard: GPU cost per check | Standard: pay ÷ grind | Hardened: expected tries | Hardened: GPU cost per check | Hardened: pay ÷ grind |
|---|---|---|---|---|---|---|---|---|
| search | x1 | $0.0017 | 64.5 | $3.4e-9 | 494,335x | 4.5 | $5.0e-8 | 33,691x |
| search | x2 | $0.0034 | 128.5 | $6.9e-9 | 496,258x | 8.5 | $9.5e-8 | 35,673x |
| search | x4 | $0.0068 | 256.5 | $1.4e-8 | 497,226x | 16.5 | $1.9e-7 | 36,754x |
| search | x8 | $0.0136 | 512.5 | $2.7e-8 | 497,711x | 32.5 | $3.6e-7 | 37,319x |
| search | x16 | $0.0272 | 896.5 (cap) | $4.8e-8 | 569,050x | 56.5 (cap) | $6.3e-7 | 42,934x |
| write | x1 | $0.0085 | 256.5 | $1.4e-8 | 621,532x | 16.5 | $1.9e-7 | 45,942x |
| write | x2 | $0.0170 | 512.5 | $2.7e-8 | 622,139x | 32.5 | $3.6e-7 | 46,649x |
| write | x4 | $0.0340 | 896.5 (cap) | $4.8e-8 | 711,313x | 56.5 (cap) | $6.3e-7 | 53,667x |
| write | x8 | $0.0680 | 896.5 (cap) | $4.8e-8 | 1,422,626x | 56.5 (cap) | $6.3e-7 | 107,334x |
| write | x16 | $0.1360 | 896.5 (cap) | $4.8e-8 | 2,845,252x | 56.5 (cap) | $6.3e-7 | 214,668x |
| account | x1 | $0.0212 | 512.5 | $2.7e-8 | 777,673x | 32.5 | $3.6e-7 | 58,311x |
| account | x2 | $0.0425 | 896.5 (cap) | $4.8e-8 | 889,141x | 56.5 (cap) | $6.3e-7 | 67,084x |
| account | x4 | $0.0850 | 896.5 (cap) | $4.8e-8 | 1,778,282x | 56.5 (cap) | $6.3e-7 | 134,167x |
| account | x8 | $0.1700 | 896.5 (cap) | $4.8e-8 | 3,556,565x | 56.5 (cap) | $6.3e-7 | 268,335x |
| account | x16 | $0.3400 | 896.5 (cap) | $4.8e-8 | 7,113,130x | 56.5 (cap) | $6.3e-7 | 536,670x |
| admin | x1 | $0.0850 | 896.5 (cap) | $4.8e-8 | 1,778,282x | 56.5 (cap) | $6.3e-7 | 134,167x |
| admin | x2 | $0.1700 | 896.5 (cap) | $4.8e-8 | 3,556,565x | 56.5 (cap) | $6.3e-7 | 268,335x |
| admin | x4 | $0.3400 | 896.5 (cap) | $4.8e-8 | 7,113,130x | 56.5 (cap) | $6.3e-7 | 536,670x |
| admin | x8 | $0.6800 | 896.5 (cap) | $4.8e-8 | 14,226,259x | 56.5 (cap) | $6.3e-7 | 1,073,340x |
| admin | x16 | $1.3600 | 896.5 (cap) | $4.8e-8 | 28,452,518x | 56.5 (cap) | $6.3e-7 | 2,146,680x |

**What it says**
1. **Paying never wins on cost in either mode.** For a write at x1, paying costs about 620,000x more
   than grinding in standard mode, and about 46,000x more in hardened mode. Counting the 20-use pass,
   that's about 12 million x and 900,000x per write.
2. **Hardened mode narrows the gap by about 13x, not more.** By the measured browser times (§3) and the
   derived GPU times, a GPU solves a standard write about 1,400x faster than a desktop browser (0.14 ms
   vs 209 ms p50). In hardened mode it's about 280x faster (about 2 ms vs 549 ms p50). Memory-hard work
   is the right lever, but at the 19 MiB OWASP minimum it remains far cheaper to grind than to pay.
3. **Velocity still widens the gap.** Price keeps doubling, but work stops at `max_units` (write x4,
   account x2, admin x1 in both modes), so grind cost per check tops out at about $0.00000005 (standard)
   or $0.0000006 (hardened).
4. **Agents pay for convenience, not savings.** The agent SDK pays by default (spec §6.3) and needs no
   GPU. Settlement's value against a funded attacker is that its spend lands with the site owner (spec
   §16), not that it is cheaper than the work.
5. **Per-IP rate limits, not cost, cap a GPU grinder.** One 4090 can solve about 150 capped hardened
   challenges a second (about 9,000 a minute) or about 2,000 capped standard ones a second (about
   120,000 a minute), against 60 challenges a minute per IP.
   Residential proxies get around per-IP limits (21% of bad-bot attacks used them, Imperva 2025).
6. **Issuer cost in hardened mode.** Minting a hardened challenge costs the issuer about 52 ms p50 of
   CPU (§2), so a challenge flood costs the server more than solving costs the attacker. The per-IP
   challenge limit is the guard. Since `6395b1f`, an agent's 402 links `challenge_url` instead of
   minting a challenge, so paid traffic mints none (median server time per paid write in hardened
   mode fell from 51.1 ms to 1.8 ms).
7. **Read the paid share (M6) only at velocity x1.** Escalation raises price and work by the same
   multiplier, the step to Argon2id narrows the gap about 13x, and past the work cap only the price
   rises, so paying never beats grinding at any tier. A cost-driven client will stop paying as
   velocity rises, and M6 falling toward 0 under attack is expected, not a fault. Paid passes are
   1 use within 60 s, so each paid check covers exactly one write (the per-write paid figures above
   are unchanged).

**Phone weight for hardened mode (recommendation, 2026-09-30):** keep hardened opt-in
and at its current weight on phones for now. The phone-like run already includes `device_mult` 0.6.
Reaching the 300–600 ms phone band would need roughly 0.26, which is about 2 to 3 Argon2id tries per
write, and lowering memory would give up the GPU resistance that is the reason to use hardened at all.
Because the multiplier comes from the UA, any phone discount is also a discount for a grinder that
claims a mobile UA. The p95 of 2.3 s is well inside the 8 s cap and never blocks. Revisit with the real
Android run before launch.

**For product (not a spec change):** a client over the work cap still gets the work option, so it
never has to pay. Whether a high-velocity, over-cap client should ever be offered payment only is a
product call (§9.5 "never hard-block humans"), and it needs real traffic first.

## 6. Phase 3 adaptive (built 2026-10-01 CT)

With `adaptive.velocity: true`:
- **Velocity raises work and price together.** Redeems (work *and* paid) are counted per coarse key (site + /24 or /48 + action, 60 s window). The same `velocity_mult` (1, 2, 4, 8, 16 at 20, 40, 80, 160 redeems) multiplies the challenge's expected tries and the offer's `amount_msat` (`base_msat × velocity_mult`, rounded up to 1,000 msat).
- **Argon2id escalation (spec §9.2, §9.3).** In standard mode, at `velocity_mult >= 4` or for `admin`, the challenge uses the hardened engine (Argon2id t = 2, m = 19 MiB). Hardened mode is Argon2id throughout. Escalation never lowers the work: `units` (expected tries ÷ the engine's `unit_tries`) is non-decreasing (test 19.6), and each Argon2id try is far heavier.
- Per-check numbers, desktop, write (`tests/adaptive.test.ts`; times derived from the §3 tries-per-second rates, not measured here):

| Redeems in 60 s | velocity | engine | expected tries | units | offer amount_msat | est. desktop solve |
|---|---|---|---|---|---|---|
| 0 | x1 | PBKDF2 | 256.5 | 4.0 | 10,000 | ~0.2 s |
| 20 | x2 | PBKDF2 | 512.5 | 8.0 | 20,000 | ~0.44 s |
| 40 | x4 | Argon2id | 56.5 (cap) | 14.1 | 40,000 | ~1.9 s |
| 80 | x8 | Argon2id | 56.5 (cap) | 14.1 | 80,000 | ~1.9 s |
| 160 | x16 | Argon2id | 56.5 (cap) | 14.1 | 160,000 | ~1.9 s |

  Admin with no burst: Argon2id, 56.5 tries (cap), 100,000 msat. The phone-like rate (7.3 tries/s, mobile 0.6x work) puts an escalated write at about 5 s, inside the §9.3 3–8 s burst band and under the 8 s cap.
- **Passes.** Human (work) pass 900 s / 20 uses (`defaults`). Settle pass single-use: `n = 1`, at most 60 s (settlement.md Q6, reconciled).
- Never a block: another /24 is unaffected, and the window slides back to x1.

## 7. Open items

- Real Android device column (empty). Until it is filled, the phone defaults are unverified. On the OS-quota emulation, standard mode's p50 is inside the §9.3 phone band and its p95 is over it; hardened mode is in the 1–2 s band (see §4). Decision: keep 0.6, lower it, or wait for device data.
- Hardened mode on phones: lower `hardened.unit_tries` or the mobile multiplier, or keep it as an opt-in heavy mode.
- Pay vs grind (§5) needs a re-run on the new engine, including a GPU figure for Argon2id.
- Velocity thresholds need real traffic before `adaptive.velocity` is turned on by default (phase 3 behaviour is built, §6).
- `device_mult` comes from the UA class only; the "previous took_ms EMA" input from §9.5 is logged
  (`redeem_ok.took_ms`) but not yet fed back into cost.
- `suspicion_mult` (§9.5, optional) is not implemented.
