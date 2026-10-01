// Renders bench/results/<run>/summary.md from summary.json. Usage: node bench/summarize.ts [run]
import { readFileSync, writeFileSync } from "node:fs";

const here = new URL(".", import.meta.url).pathname;
const run = process.argv[2] ?? readFileSync(here + "results/LATEST", "utf8").trim();
const dir = here + "results/" + run + "/";
const { environment: env, summary } = JSON.parse(readFileSync(dir + "summary.json", "utf8"));
const f = (x: number | null | undefined, d = 0) => (x == null ? "—" : Number(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
const ids = ["desktop-standard", "phone-standard", "desktop-hardened", "phone-hardened"];
const cols = ids.map((id) => summary.find((s: any) => s.id === id));
const q = env.phone_cgroup_quota_pct_of_one_core ?? {};
const head = ["", "Desktop, standard", `Phone-like, standard (CPU quota ${q.standard ?? "—"}% of a core)`, "Desktop, hardened", `Phone-like, hardened (CPU quota ${q.hardened ?? "—"}% of a core)`, "Real Android phone"];
const row = (label: string, get: (s: any) => string) => `| ${label} | ${cols.map((s) => (s ? get(s) : "not run")).join(" | ")} | — |`;
const engine = (s: any) => (s.alg === "argon2id" ? `Argon2id t=${s.engine_params.cost}, m=${f(s.engine_params.memory_kib)} KiB, p=${s.engine_params.parallelism}` : `PBKDF2-SHA-256, ${f(s.engine_params.cost)} iterations per try`);
const lines = [
  `# Benchmark run ${run}`,
  "",
  `Started ${env.started_ct}. Box CPU: ${env.cpu.model}, ${env.cpu.vcpus} vCPU, kernel ${env.cpu.kernel}, ${env.cpu.mem_gb} GB RAM. Node ${env.node}. Load average before ${env.loadavg_before.join(" / ")}, after ${env.loadavg_after.join(" / ")} (shared box).`,
  `Challenge: write (4 units), solved as the widget solves it (the engine's solver and workers as served by the issuer, same worker count), through the real /v1/challenge and /v1/redeem. ${env.warmup_per_profile} warm-up solves, then the counted solves below; every counted solve kept. Percentiles: ${env.percentile_method}.`,
  "",
  `| ${head.join(" | ")} |`,
  `|${head.map(() => "---").join("|")}|`,
  row("Engine", engine),
  row("Workers", (s) => String(s.workers)),
  row("Expected tries / counter_max (issuer)", (s) => `${f(s.expected_tries)} / ${f(s.counter_max)}`),
  row("Counted solves (redeemed OK)", (s) => `${s.counted} (${s.redeemed_ok})`),
  row("Tries per second while solving", (s) => f(s.tries_per_s, 1)),
  row("Slowdown vs desktop, same mode", (s) => f(s.slowdown_vs_desktop, 2) + "x"),
  row("**Solve time p50 (ms)**", (s) => `**${f(s.took_ms.p50, 1)}**`),
  row("**Solve time p95 (ms)**", (s) => `**${f(s.took_ms.p95, 1)}**`),
  row("Solve time max (ms)", (s) => f(s.took_ms.max, 1)),
  row("Solve time mean (ms)", (s) => f(s.took_ms.mean, 1)),
  row("Solves at or over 500 ms (shows Checking…)", (s) => f(s.share_solves_ge_500ms, 1) + "%"),
  row("Fetch + solve + redeem p50 / p95 (ms)", (s) => `${f(s.e2e_ms.p50, 1)} / ${f(s.e2e_ms.p95, 1)}`),
  "",
  "Phone-like = mobile screen and UA (the issuer serves the mobile challenge, device_mult 0.6) with every Chromium process in a cgroup v2 CPU quota, so the solver workers are really slowed. The quota is set per mode for about 4x per core (standard keeps about one core busy, hardened keeps four); the achieved slowdown is the measured row above. It is an emulation on a Xeon, not a phone.",
  "Real Android phone: not available on the box; left empty on purpose (no estimate).",
  "",
  "Raw data: " + summary.map((s: any) => `\`${s.id}.csv\``).join(", ") + ", `results.json`.",
  "",
];
writeFileSync(dir + "summary.md", lines.join("\n"));
console.log(lines.join("\n"));
