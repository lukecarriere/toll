// Renders bench/results/<run>/summary.md from summary.json. Usage: node bench/summarize.ts [run]
import { readFileSync, writeFileSync } from "node:fs";

const here = new URL(".", import.meta.url).pathname;
const run = process.argv[2] ?? readFileSync(here + "results/LATEST", "utf8").trim();
const dir = here + "results/" + run + "/";
const { environment: env, summary } = JSON.parse(readFileSync(dir + "summary.json", "utf8"));
const f = (x: number | null | undefined, d = 0) => (x == null ? "—" : Number(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
const col = (id: string) => summary.find((s: any) => s.id === id);
const cols = ["desktop", "lh-mobile-devtools", "lh-mobile-os4x"].map(col);
const head = ["", "Desktop Chromium", "Lighthouse mobile preset (devtools CPU x4)", `Lighthouse mobile preset + OS CPU quota (${env.cgroup_quota_pct_of_one_core ?? "—"}% of a core)`, "Real Android phone"];
const row = (label: string, get: (s: any) => string) => `| ${label} | ${cols.map((s) => (s ? get(s) : "not run")).join(" | ")} | — |`;
const lines = [
  `# Benchmark run ${run}`,
  "",
  `Started ${env.started_ct}. Box CPU: ${env.cpu.model}, ${env.cpu.vcpus} vCPU${env.cpu.mhz ? ` at ${env.cpu.mhz} MHz` : " (clock not reported by the VM)"}, SHA-NI ${env.cpu.sha_ni ? "yes" : "no"}, kernel ${env.cpu.kernel}, ${env.cpu.mem_gb} GB RAM. Node ${env.node}. Load average before ${env.loadavg_before.join(" / ")}, after ${env.loadavg_after.join(" / ")} (shared box).`,
  `Default challenge: write, cost ${env.policy.cost}, n ${env.policy.n}, bits ${env.policy.bits}, unit_iterations ${f(env.policy.unit_iterations)}. ${env.warmup_per_profile} warm-up solves, then ${env.counted_per_profile} counted solves per profile; every counted solve kept. Percentiles: ${env.percentile_method}.`,
  `Worker CPU throttling via CDP: ${env.worker_cpu_throttle_probe}.`,
  "",
  `| ${head.join(" | ")} |`,
  `|${head.map(() => "---").join("|")}|`,
  row("Browser", (s) => s.browser),
  row("Challenge served (span per sub-puzzle)", (s) => `${f(s.span)} (${s.n} x ${f(s.cost)} iterations per try)`),
  row("Counted solves (redeemed OK)", (s) => `${s.counted} (${s.redeemed_ok})`),
  row("Worker PBKDF2, iterations/s at cost 2,000 (median of 5)", (s) => f(s.kdf_ips_cost2000_median)),
  row("Worker PBKDF2, iterations/s at cost 100,000 (median of 3)", (s) => f(s.kdf_ips_cost100000_median)),
  row("Slowdown vs desktop (KDF, cost 2,000)", (s) => f(s.kdf_slowdown_vs_desktop, 2) + "x"),
  row("Effective iterations/s while solving", (s) => f(s.solve_iterations_per_s)),
  row("Solve time p50 (ms)", (s) => f(s.took_ms.p50, 1)),
  row("Solve time p95 (ms)", (s) => f(s.took_ms.p95, 1)),
  row("Solve time max (ms)", (s) => f(s.took_ms.max, 1)),
  row("Solve time mean (ms)", (s) => f(s.took_ms.mean, 1)),
  row("Solves at or over 500 ms (shows Checking…)", (s) => f(s.share_solves_ge_500ms, 1) + "%"),
  row("Fetch + solve + redeem p50 / p95 (ms)", (s) => `${f(s.e2e_ms.p50, 1)} / ${f(s.e2e_ms.p95, 1)}`),
  "",
  "Real Android phone: not available on the box; left empty on purpose (no estimate).",
  "",
  "Raw data: " + summary.map((s: any) => `\`${s.id}.csv\``).join(", ") + ", `results.json`.",
  "",
];
writeFileSync(dir + "summary.md", lines.join("\n"));
console.log(lines.join("\n"));
