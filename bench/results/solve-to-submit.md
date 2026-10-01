# Solve-to-submit: before (main fa12195, unchanged widget)

Harness: `bench/solve-to-submit.ts`. Run with Node 22 after a build:
`npm run build && node bench/solve-to-submit.ts --label before` (writes `solve-to-submit-before.json`).

Setup: Playwright Chromium 153.0.8010.12 (headless shell), Node v22.23.3, 8 vCPU Intel Xeon box.
Each run is a fresh browser context on the demo forms page (`/`, `#contact` form).
- Phone emulation: 412x823 viewport, mobile UA (so the issuer serves the mobile challenge, device_mult 0.6),
  and CDP `Emulation.setCPUThrottlingRate` rate 4. The CDP throttle slows the page's main thread only, not
  dedicated workers (see `bench/README.md`), so the solve itself runs at box speed. Treat the slow-policy
  solve times as a lower bound for a real mid-range phone.
- Policies: `default` (demo default) and `slow` (`unit_tries` 1100, `max_units` 64, counter at 0.95 of max).
- Scenarios, 10 runs each:
  - **a** reads for 3s, clicks into the message field, types 8 characters, clicks Submit (typical).
  - **b** focuses the field and clicks Submit 300ms after the load event (worst case).
  - **c** like a, with no idle time: `requestIdleCallback` is replaced so it only fires at its 2000ms timeout.
    This was cheap to simulate, so it is included.
- Metrics (percentiles are nearest-rank):
  - *Submit to POST*: from the Submit click to the form's POST `/contact` leaving the browser (CDP request start).
  - *Solve done vs Submit*: when the pass was in hand (end of the `/v1/redeem` response), relative to the Submit
    click. A negative value means the pass was ready before the visitor pressed Submit.
  - *Solve*: from the `/v1/challenge` request start to the end of the `/v1/redeem` response.
  - *Long tasks*: `PerformanceObserver('longtask')` entries overlapping the solve window (total over 10 runs, and
    the longest). The observer was checked separately and does report long tasks in this Chromium build.
  - *Drawn before interaction*: runs where `<toll-gate>` drew anything (here always "Checking…") before the
    visitor's first focus, input, pointerdown or submit in the form.

## Before

| Scenario | Policy | Submit to POST median (ms) | p90 | Solve done vs Submit median (ms) | p90 | Solve median (ms) | p90 | Long tasks in solve (total / max ms) | Drawn before interaction | Outcome |
|---|---|---|---|---|---|---|---|---|---|---|
| a typical | default | 11 | 13 | -3499 | -3378 | 140 | 252 | 0 / 0 | 0/10 | 10 posted |
| a typical | slow | 249 | 257 | 234 | 240 | 3906 | 3928 | 0 / 0 | 10/10 | 10 posted |
| b submit at 300ms | default | 10 | 12 | -110 | -64 | 178 | 219 | 0 / 0 | 0/10 | 10 posted |
| b submit at 300ms | slow | 3646 | 3754 | 3633 | 3717 | 3905 | 3981 | 0 / 0 | 0/10 | 10 posted |
| c no idle time | default | 12 | 12 | -1495 | -1409 | 164 | 245 | 0 / 0 | 0/10 | 10 posted |
| c no idle time | slow | 2224 | 2329 | 2207 | 2310 | 3887 | 4005 | 0 / 0 | 10/10 | 10 posted |

Reading the numbers:
- With the default policy the pass is ready before Submit in every scenario, so Submit to POST is about 10ms.
- With the slow policy the wait after Submit is the rest of the solve: about 0.25s typical, 3.6s worst case, 2.2s with no idle time.
- No main-thread long tasks during any solve: the work runs in workers.
- Gap 1 shows up in a/slow and c/slow: "Checking…" was drawn in 10 of 10 runs before the visitor touched the form
  (about 0.5s after the idle solve started). In b the visitor interacts at about 70-90ms, before anything is drawn.

## After

Not measured. The gap-1 fix was parked by the Engineering Manager on Oct 1 before the after-run.
