// Server time per paid write (agent pays per request, local test backend), standard vs hardened.
//   node bench/paid-write.ts --label before|after [--n 40] [--out bench/results/paid-write-<ts>]
// The demo app runs in-process behind a plain node:http server that times every request from
// arrival to the end of the response (hrtime). A paid write is: gate (POST /contact -> 402),
// redeem (POST /v1/redeem), retry (POST /contact with the pass -> 200). The test payer
// (POST /demo/stub-pay) stands in for the client's payment app and is reported separately.
// Also counts challenge_minted events during the measured writes.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { normalizeConfig, Metrics, MemoryStore } from "../packages/server-node/src/index.ts";
import { createDemo } from "../demo/server.ts";
import { createAgent, testBackendPayer } from "../packages/agent/src/index.ts";
import { execFileSync } from "node:child_process";

const arg = (k: string, d: string) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const label = arg("label", "run");
const N = Number(arg("n", "40"));
const WARM = 5;
const out = arg("out", "bench/results/paid-write-" + new Date().toISOString().slice(0, 19).replace(/:/g, "-"));
const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "";

const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : NaN; };
const r2 = (x: number) => Math.round(x * 100) / 100;
const stat = (xs: number[]) => ({ n: xs.length, median: r2(q(xs, 0.5)), p95: r2(q(xs, 0.95)), mean: r2(xs.reduce((a, b) => a + b, 0) / xs.length) });

async function runMode(mode: "standard" | "hardened") {
  const lines: string[] = [];
  const config = normalizeConfig({
    site_id: "site_bench", secret: "bench-secret-for-local-measurement-only-0123", issuer_public_url: "http://localhost:8787",
    rate_limit: { challenge_per_min: 100000 }, routes: [{ prefix: "/contact", class: "write" }],
    work: { mode }, settlement: { enabled: true, backend: "stub", fee_bps: 1000, fx: { source: "fixed", usd_per_btc: 100000 } },
  });
  const demo = createDemo({ config, metrics: new Metrics((l) => lines.push(l)), store: new MemoryStore() });
  let current: Record<string, number> | null = null;
  const server = createServer((req, res) => {
    const t0 = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (!current) return;
      const path = (req.url ?? "").split("?")[0];
      const key = path === "/contact" ? (res.statusCode === 200 ? "retry" : "gate") : path === "/v1/redeem" ? "redeem" : path === "/demo/stub-pay" ? "payer" : path === "/v1/challenge" ? "challenge" : "other";
      current[key] = (current[key] ?? 0) + ms;
    });
    demo.app(req, res);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const agent = createAgent({ base, pay: testBackendPayer(base), work: false });
  const rows: Record<string, number>[] = [];
  let minted = 0;
  for (let i = 0; i < WARM + N; i++) {
    current = {};
    const before = lines.length;
    const r = await agent.fetch("/contact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "bench" }) });
    if (r.response.status !== 200 || r.via !== "paid") throw new Error(`${mode}: write ${i} ended ${r.response.status} via ${r.via}`);
    const m = lines.slice(before).filter((l) => l.includes('"event":"challenge_minted"')).length;
    if (i >= WARM) { rows.push(current); minted += m; }
  }
  current = null;
  server.closeAllConnections?.();
  await new Promise<void>((ok) => server.close(() => ok()));
  const col = (k: string) => rows.map((r) => r[k] ?? 0);
  const server_ms = rows.map((r) => (r.gate ?? 0) + (r.redeem ?? 0) + (r.retry ?? 0) + (r.challenge ?? 0));
  return { mode, n: rows.length, warmup: WARM, server_per_paid_write_ms: stat(server_ms), gate_402_ms: stat(col("gate")), redeem_ms: stat(col("redeem")), retry_ms: stat(col("retry")), challenge_fetch_ms: stat(col("challenge")), test_payer_ms: stat(col("payer")), challenge_minted_per_write: minted / rows.length };
}

const results = { label, sha, dirty, at: new Date().toISOString(), node: process.version, n: N, modes: [await runMode("standard"), await runMode("hardened")] };
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/${label}.json`, JSON.stringify(results, null, 2) + "\n");
for (const m of results.modes) console.log(`${label} ${m.mode}: server per paid write median ${m.server_per_paid_write_ms.median} ms (p95 ${m.server_per_paid_write_ms.p95}) · gate 402 median ${m.gate_402_ms.median} ms · redeem ${m.redeem_ms.median} · retry ${m.retry_ms.median} · challenge_minted/write ${m.challenge_minted_per_write}`);
console.log("wrote " + `${out}/${label}.json`);
