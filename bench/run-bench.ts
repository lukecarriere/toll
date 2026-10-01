// Phase 1 benchmark: in-browser PBKDF2 speed and solve-time distribution for the default challenge.
//   npm run bench                 # desktop + Lighthouse mobile preset (+ OS-enforced 4x if sudo/cgroup v2 available)
// Writes raw CSV + JSON and a summary to bench/results/<timestamp>/. Every number comes from the run.
import { build } from "esbuild";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { createDemo } from "../demo/server.ts";
import { normalizeConfig, Metrics } from "../packages/server-node/src/index.ts";
import { randomBytes } from "node:crypto";

const here = new URL(".", import.meta.url).pathname;
const COUNTED = Number(process.env.BENCH_SOLVES ?? 210);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 10);
const CHROME = chromium.executablePath().replace("chromium_headless_shell", "chromium").replace(/chrome-headless-shell-linux64\/chrome-headless-shell$/, "chrome-linux64/chrome");
const CGROUP = "/sys/fs/cgroup/tollbench";
// 25% of one core slowed the worker ~7.8x (other Chromium threads share the quota), so the default
// quota is 45%, which a calibration run put at about 4x below desktop for the worker's KDF. Each run
// reports the achieved ratio (kdf_slowdown_vs_desktop) rather than assuming it.
const QUOTA_PCT = Number(process.env.BENCH_CGROUP_QUOTA_PCT ?? 45);

// Lighthouse mobile preset, from lighthouse core/config/constants.js and Lantern throttling.mobileSlow4G
// (devtools method values): Moto G Power screen, mobile UA, CPU x4, 562.5ms RTT, 1474.56/675 kbps.
const LH_MOBILE = {
  viewport: { width: 412, height: 823 },
  deviceScaleFactor: 1.75,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36",
  cpuSlowdownMultiplier: 4,
  network: { latency: 562.5, downloadThroughput: (1474.56 * 1024) / 8, uploadThroughput: (675 * 1024) / 8 },
};

interface Row { i: number; took_ms: number; solve_wall_ms: number; e2e_ms: number; tries: number; iterations: number; cost: number; n: number; span: number; redeem_status: number }

function pct(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, min: s[0], p50: pct(s, 0.5), p95: pct(s, 0.95), max: s[s.length - 1], mean };
}
const r1 = (x: number) => Math.round(x * 10) / 10;

async function benchPage(page: Page, base: string) {
  await page.route(base + "/bench", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><meta charset=utf-8><title>bench</title>" }));
  await page.route(base + "/bench-worker.js", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: readFileSync(here + "dist/bench-worker.js") }));
  await page.goto(base + "/bench");
}

async function runProfile(page: Page, label: string) {
  const res = await page.evaluate(async ({ COUNTED, WARMUP }) => {
    const w = new Worker("/bench-worker.js");
    let id = 0;
    const call = (m: any) => new Promise<any>((ok) => { const my = ++id; w.onmessage = (e) => ok(e.data); w.postMessage({ ...m, id: my }); });
    // Raw KDF throughput: default cost per call (2000) and a long single-call cost (100000).
    const kdf: any[] = [];
    await call({ kind: "kdf", cost: 2000, calls: 100, inflight: 1 });
    for (let k = 0; k < 5; k++) kdf.push({ cost: 2000, ...(await call({ kind: "kdf", cost: 2000, calls: 500, inflight: 1 })) });
    for (let k = 0; k < 3; k++) kdf.push({ cost: 100000, ...(await call({ kind: "kdf", cost: 100000, calls: 20, inflight: 1 })) });
    const rows: any[] = [];
    let ua = navigator.userAgent;
    for (let i = 0; i < WARMUP + COUNTED; i++) {
      const t0 = performance.now();
      const { challenge } = await (await fetch("/v1/challenge?action=write&client=widget&path=/contact", { cache: "no-store" })).json();
      const s0 = performance.now();
      // Same solver call and options as the widget worker (parallel sub-puzzles, 1 in flight each).
      const sol = await call({ kind: "solve", challenge, inflight: 1, parallel: true });
      const s1 = performance.now();
      const rr = await fetch("/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id: challenge.id, challenge, solution: { nonces: sol.nonces, took_ms: Math.round(sol.took_ms) } }) });
      const t1 = performance.now();
      if (i >= WARMUP) rows.push({ i: i - WARMUP, took_ms: sol.took_ms, solve_wall_ms: s1 - s0, e2e_ms: t1 - t0, tries: sol.tries, iterations: sol.tries * challenge.cost, cost: challenge.cost, n: challenge.n, span: challenge.counter_end - challenge.counter_start, redeem_status: rr.status });
    }
    w.terminate();
    return { rows, kdf, ua };
  }, { COUNTED, WARMUP });
  console.log(`bench: ${label}: ${res.rows.length} counted solves`);
  return res;
}

function cpuInfo() {
  const lscpu = execSync("lscpu", { encoding: "utf8" });
  const get = (k: string) => (new RegExp(`^${k}:\\s*(.+)$`, "m").exec(lscpu)?.[1] ?? "").trim();
  const flags = readFileSync("/proc/cpuinfo", "utf8");
  return { model: get("Model name"), vcpus: os.cpus().length, mhz: os.cpus()[0]?.speed, sha_ni: /\bsha_ni\b/.test(flags), kernel: os.release(), mem_gb: Math.round(os.totalmem() / 2 ** 30) };
}

function setupCgroup(): string | null {
  try {
    execSync(`sudo -n mkdir -p ${CGROUP} && echo "${QUOTA_PCT * 1000} 100000" | sudo -n tee ${CGROUP}/cpu.max >/dev/null`, { stdio: "pipe" });
    const wrapper = here + "dist/chrome-4x.sh";
    writeFileSync(wrapper, `#!/bin/sh\necho $$ | sudo -n tee ${CGROUP}/cgroup.procs >/dev/null\nexec "${CHROME}" "$@"\n`, { mode: 0o755 });
    return wrapper;
  } catch (e) {
    console.log("bench: cgroup v2 CPU quota not available; skipping the OS-enforced 4x profile");
    return null;
  }
}

async function main() {
  mkdirSync(here + "dist", { recursive: true });
  await build({ entryPoints: [here + "src/bench-worker.ts"], bundle: true, minify: true, format: "iife", target: ["es2020"], outfile: here + "dist/bench-worker.js", logLevel: "silent" });
  const lines: string[] = [];
  const config = normalizeConfig({ site_id: "site_bench", secret: randomBytes(32).toString("hex"), issuer_public_url: "http://localhost:8787", rate_limit: { challenge_per_min: 100000 } });
  const { app } = createDemo({ config, metrics: new Metrics((l) => lines.push(l)) });
  const server = await new Promise<any>((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  config.allowed_origins.push(base);

  const started = new Date();
  const env: Record<string, any> = { started_at: started.toISOString(), started_ct: started.toLocaleString("en-US", { timeZone: "America/Chicago" }) + " CT", cpu: cpuInfo(), loadavg_before: os.loadavg().map(r1), node: process.version, policy: config.work, counted_per_profile: COUNTED, warmup_per_profile: WARMUP, percentile_method: "nearest-rank" };
  const profiles: any[] = [];

  // (a) desktop Chromium
  if (!process.env.BENCH_ONLY_OS) {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1350, height: 940 } });
    const page = await ctx.newPage();
    await benchPage(page, base);
    const r = await runProfile(page, "desktop");
    profiles.push({ id: "desktop", label: "Desktop Chromium (box)", browser: browser.version(), throttle: "none", ...r });
    await browser.close();
  }

  // (b) Lighthouse mobile preset, applied the way Lighthouse's devtools throttling applies it.
  const lhProfile = async (browser: Browser, id: string, label: string, note: string) => {
    const ctx = await browser.newContext({ viewport: LH_MOBILE.viewport, deviceScaleFactor: LH_MOBILE.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: LH_MOBILE.userAgent });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: LH_MOBILE.cpuSlowdownMultiplier });
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, ...LH_MOBILE.network });
    await benchPage(page, base);
    // Probe whether CDP CPU throttling can reach a dedicated worker in this Chromium build.
    const probe = await page.evaluate(async () => {
      const t0 = performance.now(); let x = 0; for (let i = 0; i < 2e7; i++) x = (x + i) | 0; return performance.now() - t0;
    });
    const r = await runProfile(page, id);
    profiles.push({ id, label, browser: browser.version(), throttle: note, main_thread_js_probe_ms: r1(probe), ...r });
  };
  if (!process.env.BENCH_ONLY_OS) {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    // Record Chromium's answer when CPU throttling is aimed at a worker target.
    let workerThrottle = "not probed";
    try {
      const bs = await browser.newBrowserCDPSession();
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await benchPage(p, base);
      await p.evaluate(() => { (window as any).__w = new Worker("/bench-worker.js"); });
      await p.waitForTimeout(300);
      const { targetInfos } = await bs.send("Target.getTargets");
      const wt = targetInfos.find((t: any) => t.type === "worker");
      if (wt) {
        // Non-flattened attach: send one command to the worker target and read its reply.
        const { sessionId } = await bs.send("Target.attachToTarget", { targetId: wt.targetId, flatten: false });
        workerThrottle = await new Promise<string>((ok) => {
          const t = setTimeout(() => ok("no reply"), 3000);
          bs.on("Target.receivedMessageFromTarget", (ev: any) => {
            const m = JSON.parse(ev.message);
            if (m.id === 4242) { clearTimeout(t); ok(m.error ? "rejected by Chromium: " + m.error.message : "accepted"); }
          });
          bs.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: 4242, method: "Emulation.setCPUThrottlingRate", params: { rate: 4 } }) }).catch((e: any) => ok("error: " + e.message));
        });
      }
      await ctx.close();
    } catch (e: any) {
      workerThrottle = "probe failed: " + e.message;
    }
    env["worker_cpu_throttle_probe"] = workerThrottle;
    await lhProfile(browser, "lh-mobile-devtools", "Lighthouse mobile preset, devtools throttling (CPU x4 on page)", "CDP Emulation.setCPUThrottlingRate=4 on the page target + Lighthouse mobile network/screen/UA");
    await browser.close();
  }
  const wrapper = process.env.BENCH_NO_CGROUP ? null : setupCgroup();
  env["cgroup_quota_pct_of_one_core"] = wrapper ? QUOTA_PCT : null;
  if (wrapper) {
    const browser = await chromium.launch({ executablePath: wrapper, headless: true });
    await lhProfile(browser, "lh-mobile-os4x", `Lighthouse mobile preset + OS CPU quota (cgroup cpu.max ${QUOTA_PCT}% of one core)`, `As lh-mobile-devtools, plus all Chromium processes in a cgroup v2 with cpu.max=${QUOTA_PCT * 1000}/100000, so the worker thread is slowed too`);
    await browser.close();
    try { execSync(`sudo -n rmdir ${CGROUP}`, { stdio: "pipe" }); } catch { /* still has processes; harmless */ }
  }
  server.close();
  env["loadavg_after"] = os.loadavg().map(r1);
  env["finished_at"] = new Date().toISOString();

  const stamp = started.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = here + "results/" + stamp + "/";
  mkdirSync(outDir, { recursive: true });
  const summary: any[] = [];
  for (const p of profiles) {
    const rows: Row[] = p.rows;
    const header = "i,took_ms,solve_wall_ms,e2e_ms,tries,iterations,cost,n,span,redeem_status";
    writeFileSync(outDir + p.id + ".csv", [header, ...rows.map((r) => [r.i, r1(r.took_ms), r1(r.solve_wall_ms), r1(r.e2e_ms), r.tries, r.iterations, r.cost, r.n, r.span, r.redeem_status].join(","))].join("\n") + "\n");
    const ok = rows.filter((r) => r.redeem_status === 200).length;
    const iterSum = rows.reduce((a, r) => a + r.iterations, 0);
    const tookSum = rows.reduce((a, r) => a + r.took_ms, 0);
    const kdf2000 = p.kdf.filter((k: any) => k.cost === 2000).map((k: any) => k.ips);
    const kdf100k = p.kdf.filter((k: any) => k.cost === 100000).map((k: any) => k.ips);
    summary.push({
      id: p.id, label: p.label, browser: p.browser, ua: p.ua, throttle: p.throttle, main_thread_js_probe_ms: p.main_thread_js_probe_ms ?? null,
      counted: rows.length, redeemed_ok: ok, span: rows[0]?.span, cost: rows[0]?.cost, n: rows[0]?.n,
      took_ms: Object.fromEntries(Object.entries(stats(rows.map((r) => r.took_ms))).map(([k, v]) => [k, r1(v)])),
      e2e_ms: Object.fromEntries(Object.entries(stats(rows.map((r) => r.e2e_ms))).map(([k, v]) => [k, r1(v)])),
      solve_iterations_per_s: Math.round(iterSum / (tookSum / 1000)),
      kdf_ips_cost2000_median: Math.round(stats(kdf2000).p50), kdf_ips_cost2000_runs: kdf2000.map(Math.round),
      kdf_ips_cost100000_median: Math.round(stats(kdf100k).p50), kdf_ips_cost100000_runs: kdf100k.map(Math.round),
      share_solves_ge_500ms: r1((100 * rows.filter((r) => r.took_ms >= 500).length) / rows.length),
    });
  }
  const desk = summary.find((x) => x.id === "desktop");
  for (const x of summary) x.kdf_slowdown_vs_desktop = desk ? Math.round((desk.kdf_ips_cost2000_median / x.kdf_ips_cost2000_median) * 100) / 100 : null;
  writeFileSync(outDir + "results.json", JSON.stringify({ environment: env, lighthouse_mobile_preset: LH_MOBILE, summary, raw: profiles.map((p) => ({ id: p.id, kdf: p.kdf, rows: p.rows })) }, null, 2) + "\n");
  writeFileSync(outDir + "summary.json", JSON.stringify({ environment: env, summary }, null, 2) + "\n");
  writeFileSync(here + "results/LATEST", stamp + "\n");
  console.log(JSON.stringify({ outDir, environment: env, summary }, null, 2));
}

await main();
