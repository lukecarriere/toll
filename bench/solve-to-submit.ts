// Solve-to-submit benchmark for toll.js in real Chromium (Playwright), phone-like.
// For each run: a fresh context on the demo forms page (#contact form), then a scripted visitor.
// Measured per run:
//   submit_to_post_ms   visitor clicks Submit -> the form's POST /contact leaves the browser
//                       (CDP requestWillBeSent wall time, via Playwright request.timing())
//   solve_done_rel_submit_ms   when the pass was in hand (end of the /v1/redeem response) relative
//                       to the Submit click; negative = finished before the visitor pressed Submit
//   solve_ms            /v1/challenge request start -> /v1/redeem response end
//   longtasks           PerformanceObserver('longtask') entries during the solve window (count, max)
//   shown_before_interaction   whether <toll-gate> drew anything before the visitor's first
//                       interaction with the form (focus, input, pointerdown, submit)
// Phone emulation: mobile viewport + UA (the issuer then serves the mobile challenge, device_mult
// 0.6) and CDP Emulation.setCPUThrottlingRate rate 4 on the page. Note (bench/README.md): the CDP
// throttle slows the page's main thread only, not dedicated workers, so the solve itself runs at
// box speed; the main-thread parts (timers, rendering, submit handling, long tasks) are throttled.
// Scenarios:
//   a  reads ~3s, clicks into the message field, types, clicks Submit (typical)
//   b  focuses the field and clicks Submit ~300ms after the load event (worst case)
//   c  like a, but no idle time: requestIdleCallback only ever fires at its timeout (2000ms)
// Policies: default demo policy, and "slow" (unit_tries 1100, max_units 64, counter at 0.95 of max).
//   npm run build && node bench/solve-to-submit.ts --label before [--runs 10] [--scenarios a,b,c]
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import { chromium, type Browser, type Request } from "playwright";
import { startDemo, type Running } from "../tests/helpers.ts";

const here = new URL(".", import.meta.url).pathname;
const arg = (k: string, d: string) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const LABEL = arg("label", "before");
const RUNS = Number(arg("runs", "10"));
const SCENARIOS = arg("scenarios", "a,b,c").split(",");
const CPU_RATE = 4;
const PHONE = {
  viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36",
};

interface Run {
  i: number; outcome: "posted" | "capped" | "error" | "timeout";
  submit_to_post_ms: number | null; solve_done_rel_submit_ms: number | null; solve_ms: number | null;
  solve_start_rel_load_ms: number | null; took_ms: number | null;
  longtasks: { count: number; max_ms: number }; longtasks_run: { count: number; max_ms: number };
  first_view: string | null; first_view_rel_load_ms: number | null; first_interaction_rel_load_ms: number | null;
  shown_before_interaction: boolean; views: string[];
}

function pct(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
function summ(xs: (number | null)[]) {
  const s = xs.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  return { n: s.length, median: Math.round(pct(s, 0.5)), p90: Math.round(pct(s, 0.9)), min: Math.round(s[0]), max: Math.round(s[s.length - 1]) };
}

// In-page probe: long tasks, a cheap 50ms sampler of what <toll-gate> draws, first interaction,
// the Submit click. Everything goes to Node through a binding at once (the page navigates away
// after the POST).
const PROBE = (scenario: string) => `(() => {
  const mark = (k, d) => { try { window.__bench(k, d); } catch {} };
  const t = () => performance.timeOrigin + performance.now();
  ${scenario === "c" ? "window.requestIdleCallback = (cb, o) => setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), (o && o.timeout) || 0);" : ""}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) mark("longtask", { start: performance.timeOrigin + e.startTime, dur: e.duration }); }).observe({ type: "longtask", buffered: true }); } catch {}
  addEventListener("load", () => mark("load", { t: t() }));
  let first = false;
  for (const ev of ["focusin", "input", "pointerdown", "submit"]) addEventListener(ev, (e) => {
    if (!first && e.target && e.target.closest && e.target.closest("#contact form")) { first = true; mark("interaction", { t: t(), ev }); }
  }, true);
  addEventListener("click", (e) => { if (e.target && e.target.closest && e.target.closest("#contact button[type=submit]")) mark("submit", { t: t() }); }, true);
  let last = "none";
  setInterval(() => {
    const g = document.querySelector("#contact toll-gate");
    if (!g || !g.shadowRoot) return;
    const r = g.shadowRoot, vis = (el) => el && !el.hidden;
    const s = r.querySelector('[role="status"]'), a = r.querySelector('[role="alert"]'), b = r.querySelector("button.btn");
    const v = g.hidden ? "none" : [vis(s) ? "status:" + s.textContent : "", vis(a) ? "alert" : "", vis(b) ? "button:" + b.textContent : ""].filter(Boolean).join("|") || "empty";
    if (v !== last) { last = v; mark("view", { t: t(), v }); }
  }, 50);
})();`;

async function oneRun(browser: Browser, demo: Running, scenario: string, i: number): Promise<Run> {
  const ctx = await browser.newContext({ ...PHONE, reducedMotion: "no-preference" });
  const page = await ctx.newPage();
  const marks: { k: string; d: any }[] = [];
  await page.exposeBinding("__bench", (_src, k: string, d: any) => { marks.push({ k, d }); });
  await page.addInitScript(PROBE(scenario));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_RATE });
  let challengeReq: Request | null = null, redeemReq: Request | null = null, postReq: Request | null = null;
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/v1/challenge") && !challengeReq) challengeReq = r;
    if (u.includes("/v1/redeem")) redeemReq = r;
    if (r.method() === "POST" && new URL(u).pathname === "/contact" && !postReq) postReq = r;
  });
  const posted = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/contact", { timeout: 30000 });
  const capped = page.waitForFunction(() => { const g = document.querySelector("#contact toll-gate") as any; const b = g?.shadowRoot?.querySelector("button.btn"); return b && !b.hidden; }, null, { timeout: 30000, polling: 100 });
  let outcome: Run["outcome"] = "timeout";
  try {
    await page.goto(demo.url + "/", { waitUntil: "load" });
    const loadAt = await page.evaluate(() => performance.timeOrigin + (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).loadEventStart);
    if (scenario === "b") {
      await page.focus("#m");
      const wait = loadAt + 300 - (await page.evaluate(() => performance.timeOrigin + performance.now()));
      if (wait > 0) await page.waitForTimeout(wait);
      await page.click("#contact button[type=submit]");
    } else {
      await page.waitForTimeout(3000);
      await page.click("#m");
      await page.keyboard.type(" Thanks!", { delay: 60 });
      await page.click("#contact button[type=submit]");
    }
    outcome = await Promise.race([posted.then(() => "posted" as const), capped.then(() => "capped" as const)]);
    if (outcome === "posted") await page.waitForURL(/sent=contact/, { timeout: 15000 }).catch(() => {});
    else await page.waitForTimeout(200);
    if (redeemReq) await (redeemReq as Request).response().catch(() => null);
    const get = (k: string) => marks.find((m) => m.k === k)?.d;
    const submitAt = get("submit")?.t ?? null;
    const inter = get("interaction")?.t ?? null;
    const timing = (r: Request | null) => (r ? r.timing() : null);
    const ct = timing(challengeReq), rt = timing(redeemReq), pt = timing(postReq);
    const solveStart = ct ? ct.startTime : null;
    const solveEnd = rt && rt.responseEnd > 0 ? rt.startTime + rt.responseEnd : null;
    let took: number | null = null;
    try { took = redeemReq ? JSON.parse((redeemReq as Request).postData() ?? "{}").solution?.took_ms ?? null : null; } catch { /* */ }
    const lts = marks.filter((m) => m.k === "longtask").map((m) => m.d as { start: number; dur: number });
    const inSolve = solveStart && solveEnd ? lts.filter((l) => l.start + l.dur >= solveStart && l.start <= solveEnd) : [];
    const views = marks.filter((m) => m.k === "view").map((m) => m.d as { t: number; v: string });
    const firstShown = views.find((v) => v.v !== "none");
    const lt = (xs: { dur: number }[]) => ({ count: xs.length, max_ms: Math.round(Math.max(0, ...xs.map((x) => x.dur))) });
    const r1 = (x: number | null) => (x == null ? null : Math.round(x));
    return {
      i, outcome,
      submit_to_post_ms: pt && submitAt ? r1(pt.startTime - submitAt) : null,
      solve_done_rel_submit_ms: solveEnd && submitAt ? r1(solveEnd - submitAt) : null,
      solve_ms: solveStart && solveEnd ? r1(solveEnd - solveStart) : null,
      solve_start_rel_load_ms: solveStart ? r1(solveStart - loadAt) : null,
      took_ms: took,
      longtasks: lt(inSolve), longtasks_run: lt(lts),
      first_view: firstShown?.v ?? null,
      first_view_rel_load_ms: firstShown ? r1(firstShown.t - loadAt) : null,
      first_interaction_rel_load_ms: inter ? r1(inter - loadAt) : null,
      shown_before_interaction: !!firstShown && (inter == null || firstShown.t < inter),
      views: views.map((v) => v.v),
    };
  } catch (e) {
    return { i, outcome: "error", submit_to_post_ms: null, solve_done_rel_submit_ms: null, solve_ms: null, solve_start_rel_load_ms: null, took_ms: null, longtasks: { count: 0, max_ms: 0 }, longtasks_run: { count: 0, max_ms: 0 }, first_view: null, first_view_rel_load_ms: null, first_interaction_rel_load_ms: null, shown_before_interaction: false, views: [String((e as Error).message).slice(0, 200)] };
  } finally {
    posted.catch(() => {}); capped.catch(() => {});
    await ctx.close();
  }
}

async function main() {
  if (!existsSync(here + "../packages/widget/dist/toll.js")) throw new Error("run `npm run build` first");
  const policies: { id: string; demo: Running }[] = [
    { id: "default", demo: await startDemo() },
    { id: "slow", demo: await startDemo({ work: { standard: { unit_tries: 1100 }, max_units: 64 } }, { pickCounter: (m) => 0.95 * m }) },
  ];
  const browser = await chromium.launch();
  const out: any = {
    label: LABEL, at: new Date().toISOString(), runs_per_cell: RUNS, cpu_throttling_rate: CPU_RATE,
    phone: PHONE, node: process.version, chromium: browser.version(), cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model,
    note: "CDP CPU throttling slows the page main thread only; the solve runs in dedicated workers at box speed (bench/README.md).",
    cells: [] as any[],
  };
  try {
    for (const sc of SCENARIOS) for (const pol of policies) {
      const runs: Run[] = [];
      for (let i = 0; i < RUNS; i++) {
        const r = await oneRun(browser, pol.demo, sc, i);
        runs.push(r);
        console.log(`solve-to-submit ${LABEL} ${sc}/${pol.id} #${i}: ${r.outcome} submit->POST ${r.submit_to_post_ms}ms, solve done ${r.solve_done_rel_submit_ms}ms vs submit, solve ${r.solve_ms}ms, longtasks ${r.longtasks.count} (max ${r.longtasks.max_ms}ms), first view ${r.first_view}@${r.first_view_rel_load_ms} (interaction @${r.first_interaction_rel_load_ms})`);
      }
      const ok = runs.filter((r) => r.outcome === "posted");
      out.cells.push({
        scenario: sc, policy: pol.id,
        outcomes: runs.reduce((a: Record<string, number>, r) => ((a[r.outcome] = (a[r.outcome] ?? 0) + 1), a), {}),
        submit_to_post_ms: summ(ok.map((r) => r.submit_to_post_ms)),
        solve_done_rel_submit_ms: summ(runs.map((r) => r.solve_done_rel_submit_ms)),
        solve_ms: summ(runs.map((r) => r.solve_ms)),
        longtasks_in_solve: { total: runs.reduce((a, r) => a + r.longtasks.count, 0), max_ms: Math.max(0, ...runs.map((r) => r.longtasks.max_ms)), per_run_median: summ(runs.map((r) => r.longtasks.count))?.median ?? 0 },
        longtasks_whole_run: { total: runs.reduce((a, r) => a + r.longtasks_run.count, 0), max_ms: Math.max(0, ...runs.map((r) => r.longtasks_run.max_ms)) },
        shown_before_interaction_runs: runs.filter((r) => r.shown_before_interaction).length,
        runs,
      });
    }
  } finally {
    await browser.close();
    await Promise.all(policies.map((p) => p.demo.close()));
  }
  mkdirSync(here + "results", { recursive: true });
  const file = here + `results/solve-to-submit-${LABEL}.json`;
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log("solve-to-submit: wrote " + file);
  for (const c of out.cells) console.log(`${c.scenario}/${c.policy}: submit->POST median ${c.submit_to_post_ms?.median} p90 ${c.submit_to_post_ms?.p90}; solve done vs submit median ${c.solve_done_rel_submit_ms?.median} p90 ${c.solve_done_rel_submit_ms?.p90}; longtasks ${c.longtasks_in_solve.total} max ${c.longtasks_in_solve.max_ms}ms; shown before interaction ${c.shown_before_interaction_runs}/${RUNS}; ${JSON.stringify(c.outcomes)}`);
}

await main();
