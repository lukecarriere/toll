// Benchmark for the work engine (docs/adapters.md): solve-time distribution in real Chromium for the
// default write challenge, in standard mode (PBKDF2) and hardened mode (Argon2id), on two profiles:
//   desktop   Chromium on the box, no throttling
//   phone     mobile screen + UA (the issuer serves the lighter mobile challenge) and every Chromium
//             process in a cgroup v2 CPU quota, so the solver workers are really slowed
// The page solves exactly as the widget does: the engine's solver driving the engine's workers as
// served by the issuer (/toll/v1/toll.worker*.js, same CSP), same concurrency, through the real
// /v1/challenge and /v1/redeem. Every number comes from the run; nothing is estimated.
//   npm run bench    env: BENCH_SOLVES (210), BENCH_WARMUP (10), BENCH_SOLVES_HARDENED_PHONE,
//                         BENCH_CGROUP_QUOTA_PCT_STANDARD (45), BENCH_CGROUP_QUOTA_PCT_HARDENED (180),
//                         BENCH_NO_CGROUP=1, BENCH_PROFILES=desktop-standard,...
import { build } from "esbuild";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { chromium, type Page } from "playwright";
import { createDemo } from "../demo/server.ts";
import { normalizeConfig, Metrics } from "../packages/server-node/src/index.ts";
import { randomBytes } from "node:crypto";

const here = new URL(".", import.meta.url).pathname;
const COUNTED = Number(process.env.BENCH_SOLVES ?? 210);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 10);
const COUNTED_HARD_PHONE = Number(process.env.BENCH_SOLVES_HARDENED_PHONE ?? COUNTED);
const CHROME = chromium.executablePath().replace("chromium_headless_shell", "chromium").replace(/chrome-headless-shell-linux64\/chrome-headless-shell$/, "chrome-linux64/chrome");
const CGROUP = "/sys/fs/cgroup/tollbench";
// Phone-like = about 4x slower per core. 45% of one core measured ~4x slower for one busy thread
// (other Chromium threads share the quota). The quota is set per mode from how many cores the
// desktop solve actually keeps busy: WebCrypto PBKDF2 (standard) keeps about one core busy even
// with 4 workers (desktop tries/s barely exceed one worker's), so 45%; WASM Argon2id (hardened)
// keeps all 4 workers busy, so 4 x 45% = 180%. A first run with 180% for both left standard
// unthrottled (0.99x). Each run reports the slowdown it actually got instead of assuming it.
const QUOTA_PCT: Record<"standard" | "hardened", number> = {
  standard: Number(process.env.BENCH_CGROUP_QUOTA_PCT_STANDARD ?? 45),
  hardened: Number(process.env.BENCH_CGROUP_QUOTA_PCT_HARDENED ?? 180),
};
const PHONE = {
  viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36",
};

interface Row { i: number; took_ms: number; e2e_ms: number; tries: number; counter_max: number; expected_tries: number; alg: string; redeem_status: number }

function pct(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, min: s[0], p50: pct(s, 0.5), p95: pct(s, 0.95), max: s[s.length - 1], mean };
}
const r1 = (x: number) => Math.round(x * 10) / 10;

async function startIssuer(mode: "standard" | "hardened") {
  const events: any[] = [];
  const config = normalizeConfig({ site_id: "site_bench", secret: randomBytes(32).toString("hex"), issuer_public_url: "http://localhost:8787", rate_limit: { challenge_per_min: 100000 }, work: { mode } });
  const { app } = createDemo({ config, metrics: new Metrics((l) => { const e = JSON.parse(l); if (e.event === "challenge_minted") events.push(e); }) });
  const server = await new Promise<any>((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  config.allowed_origins.push(base);
  return { base, config, events, close: () => new Promise((ok) => server.close(ok)) };
}

async function benchPage(page: Page, base: string) {
  await page.route(base + "/bench", (r) => r.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta charset=utf-8><title>bench</title><script src="/bench-solver.js"></script>` }));
  await page.route(base + "/bench-solver.js", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: readFileSync(here + "dist/bench-solver.js") }));
  await page.goto(base + "/bench");
}

async function runProfile(page: Page, label: string, counted: number) {
  const res = await page.evaluate(async ({ counted, WARMUP }) => {
    const solve = (window as any).benchSolve as (w: any, url: string, n: number) => Promise<any>;
    const CONC = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)); // same as the widget
    const rows: any[] = [];
    for (let i = 0; i < WARMUP + counted; i++) {
      const t0 = performance.now();
      const { challenge } = await (await fetch("/v1/challenge?action=write&client=widget&path=/contact", { cache: "no-store" })).json();
      const url = challenge.alg === "argon2id" ? "/toll/v1/toll.worker-argon2id.js" : "/toll/v1/toll.worker.js";
      const s0 = performance.now();
      const sol = await solve(challenge.work, url, CONC);
      const took = performance.now() - s0;
      const rr = await fetch("/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id: challenge.id, challenge, solution: { work: { counter: sol.counter, derivedKey: sol.derivedKey }, took_ms: Math.round(took) } }) });
      if (i >= WARMUP) rows.push({ i: i - WARMUP, took_ms: took, e2e_ms: performance.now() - t0, tries: sol.counter + 1, alg: challenge.alg, redeem_status: rr.status });
    }
    return { rows, ua: navigator.userAgent, concurrency: CONC };
  }, { counted, WARMUP });
  console.log(`bench: ${label}: ${res.rows.length} counted solves`);
  return res;
}

function cpuInfo() {
  const lscpu = execSync("lscpu", { encoding: "utf8" });
  const get = (k: string) => (new RegExp(`^${k}:\\s*(.+)$`, "m").exec(lscpu)?.[1] ?? "").trim();
  return { model: get("Model name"), vcpus: os.cpus().length, kernel: os.release(), mem_gb: Math.round(os.totalmem() / 2 ** 30) };
}

function setQuota(pct: number) {
  execSync(`echo "${Math.round(pct * 1000)} 100000" | sudo -n tee ${CGROUP}/cpu.max >/dev/null`, { stdio: "pipe" });
}

function setupCgroup(): string | null {
  try {
    execSync(`sudo -n mkdir -p ${CGROUP}`, { stdio: "pipe" });
    setQuota(QUOTA_PCT.standard);
    const wrapper = here + "dist/chrome-phone.sh";
    writeFileSync(wrapper, `#!/bin/sh\necho $$ | sudo -n tee ${CGROUP}/cgroup.procs >/dev/null\nexec "${CHROME}" "$@"\n`, { mode: 0o755 });
    return wrapper;
  } catch {
    console.log("bench: cgroup v2 CPU quota not available; skipping the phone-like profile");
    return null;
  }
}

async function main() {
  mkdirSync(here + "dist", { recursive: true });
  // The page-side solver: the same module toll.js bundles (@toll/work-adapter/browser).
  writeFileSync(here + "dist/bench-entry.ts", `import { solveWithWorkers } from "@toll/work-adapter/browser";\n(window as any).benchSolve = (challenge: any, url: string, concurrency: number) => solveWithWorkers({ challenge, concurrency, createWorker: () => new Worker(url), timeout: 300000 });\n`);
  await build({ entryPoints: [here + "dist/bench-entry.ts"], bundle: true, minify: true, format: "iife", target: ["es2020"], outfile: here + "dist/bench-solver.js", logLevel: "silent", nodePaths: [here + "../node_modules"] });
  const want = (id: string) => !process.env.BENCH_PROFILES || process.env.BENCH_PROFILES.split(",").includes(id);

  const started = new Date();
  const env: Record<string, any> = { started_at: started.toISOString(), started_ct: started.toLocaleString("en-US", { timeZone: "America/Chicago" }) + " CT", cpu: cpuInfo(), loadavg_before: os.loadavg().map(r1), node: process.version, warmup_per_profile: WARMUP, percentile_method: "nearest-rank", phone_cgroup_quota_pct_of_one_core: null as null | Record<string, number> };
  const profiles: any[] = [];
  const issuers = { standard: await startIssuer("standard"), hardened: await startIssuer("hardened") };
  env.policy = issuers.standard.config.work;

  const run = async (executablePath: string, phone: boolean) => {
    const browser = await chromium.launch({ executablePath, headless: true });
    for (const mode of ["standard", "hardened"] as const) {
      const id = `${phone ? "phone" : "desktop"}-${mode}`;
      if (!want(id)) continue;
      const iss = issuers[mode];
      if (phone) setQuota(QUOTA_PCT[mode]);
      const ctx = await browser.newContext(phone ? PHONE : { viewport: { width: 1350, height: 940 } });
      const page = await ctx.newPage();
      await benchPage(page, iss.base);
      const before = iss.events.length;
      const r = await runProfile(page, id, phone && mode === "hardened" ? COUNTED_HARD_PHONE : COUNTED);
      const minted = iss.events.slice(before + WARMUP);
      r.rows.forEach((row: any, k: number) => { row.counter_max = minted[k]?.counter_max; row.expected_tries = minted[k]?.expected_tries; });
      profiles.push({ id, mode, phone, browser: browser.version(), ...r });
      await ctx.close();
    }
    await browser.close();
  };

  if (want("desktop-standard") || want("desktop-hardened")) await run(CHROME, false);
  const wrapper = process.env.BENCH_NO_CGROUP ? null : setupCgroup();
  if (wrapper && (want("phone-standard") || want("phone-hardened"))) {
    env.phone_cgroup_quota_pct_of_one_core = QUOTA_PCT;
    await run(wrapper, true);
    try { execSync(`sudo -n rmdir ${CGROUP}`, { stdio: "pipe" }); } catch { /* processes still exiting */ }
  }
  await issuers.standard.close();
  await issuers.hardened.close();
  env.loadavg_after = os.loadavg().map(r1);
  env.finished_at = new Date().toISOString();

  const stamp = started.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = here + "results/" + stamp + "/";
  mkdirSync(outDir, { recursive: true });
  const summary: any[] = [];
  for (const p of profiles) {
    const rows: Row[] = p.rows;
    writeFileSync(outDir + p.id + ".csv", ["i,took_ms,e2e_ms,tries,counter_max,expected_tries,alg,redeem_status", ...rows.map((r) => [r.i, r1(r.took_ms), r1(r.e2e_ms), r.tries, r.counter_max, r.expected_tries, r.alg, r.redeem_status].join(","))].join("\n") + "\n");
    const triesSum = rows.reduce((a, r) => a + r.tries, 0);
    const tookSum = rows.reduce((a, r) => a + r.took_ms, 0);
    const m = p.mode === "hardened" ? env.policy.hardened : env.policy.standard;
    summary.push({
      id: p.id, mode: p.mode, profile: p.phone ? "phone" : "desktop", browser: p.browser, ua: p.ua, workers: p.concurrency,
      alg: rows[0]?.alg, engine_params: m, counter_max: rows[0]?.counter_max, expected_tries: rows[0]?.expected_tries,
      counted: rows.length, redeemed_ok: rows.filter((r) => r.redeem_status === 200).length,
      took_ms: Object.fromEntries(Object.entries(stats(rows.map((r) => r.took_ms))).map(([k, v]) => [k, r1(v)])),
      e2e_ms: Object.fromEntries(Object.entries(stats(rows.map((r) => r.e2e_ms))).map(([k, v]) => [k, r1(v)])),
      tries_per_s: r1(triesSum / (tookSum / 1000)),
      share_solves_ge_500ms: r1((100 * rows.filter((r) => r.took_ms >= 500).length) / rows.length),
    });
  }
  for (const x of summary) {
    const d = summary.find((s) => s.id === "desktop-" + x.mode);
    x.slowdown_vs_desktop = d ? Math.round((d.tries_per_s / x.tries_per_s) * 100) / 100 : null;
  }
  writeFileSync(outDir + "results.json", JSON.stringify({ environment: env, phone_profile: PHONE, summary, raw: profiles.map((p) => ({ id: p.id, rows: p.rows })) }, null, 2) + "\n");
  writeFileSync(outDir + "summary.json", JSON.stringify({ environment: env, summary }, null, 2) + "\n");
  writeFileSync(here + "results/LATEST", stamp + "\n");
  console.log(JSON.stringify({ outDir, summary: summary.map((s) => ({ id: s.id, counted: s.counted, ok: s.redeemed_ok, p50: s.took_ms.p50, p95: s.took_ms.p95, tries_per_s: s.tries_per_s, slowdown: s.slowdown_vs_desktop })) }, null, 2));
}

await main();
