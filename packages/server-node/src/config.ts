// toll.yaml loader (spec §14). Values of the form "env:NAME" are read from the environment.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { type ActionClass, type WorkPolicy, isActionClass } from "../../protocol/src/index.ts";

export interface RouteRule { prefix: string; class: ActionClass }

export interface TollConfig {
  site_id: string;
  secret: string;
  issuer_public_url: string;
  hostname: string;
  allowed_origins: string[];
  defaults: {
    pass_ttl_s: number;
    pass_uses: number;
    challenge_ttl_s: number;
    max_solve_ms: number;
  };
  work: WorkPolicy;
  adaptive: { velocity: boolean };
  rate_limit: { challenge_per_min: number };
  cookie: { secure: "auto" | boolean };
  routes: RouteRule[];
  settlement: { enabled: boolean; backend?: string; fee_bps: number };
}

// Policy defaults. Calibration and the measured runs behind them: docs/policy.md.
export const DEFAULT_WORK: WorkPolicy = {
  mode: "standard",
  // Engine tries per 1x unit. Calibrated on the box (docs/policy.md); write = 4 units.
  standard: { alg: "pbkdf2-sha256", cost: 5000, unit_tries: 64 },
  hardened: { alg: "argon2id", cost: 2, memory_kib: 19456, parallelism: 1, unit_tries: 4 },
  max_units: 28,
  device_mult: { mobile: 0.6, desktop: 1.0 },
  velocity_steps: [[20, 2], [40, 4], [80, 8], [160, 16]],
  velocity_window_s: 60,
};

function resolveEnv(v: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof v === "string" && v.startsWith("env:")) return env[v.slice(4)];
  return v;
}

export function normalizeConfig(raw: Record<string, any>, env: NodeJS.ProcessEnv = process.env): TollConfig {
  const site_id = String(raw.site_id ?? "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(site_id)) throw new Error("toll config: site_id is required (letters, digits, _ and -)");
  const secret = resolveEnv(raw.secret, env);
  if (typeof secret !== "string" || secret.length < 16) throw new Error("toll config: secret is missing or shorter than 16 characters (set TOLL_SECRET)");
  const issuer_public_url = String(raw.issuer_public_url ?? "http://localhost:8787");
  const d = raw.defaults ?? {};
  if (d.algos !== undefined) throw new Error("toll config: defaults.algos was replaced by work.mode (standard | hardened); see docs/adapters.md");
  const challenge_ttl_s = Number(d.challenge_ttl_s ?? 120);
  if (!(challenge_ttl_s > 0 && challenge_ttl_s <= 120)) throw new Error("toll config: challenge_ttl_s must be 1..120");
  const routes: RouteRule[] = (raw.routes ?? []).map((r: any) => {
    if (typeof r?.prefix !== "string" || !r.prefix.startsWith("/") || !isActionClass(r.class)) throw new Error("toll config: bad route " + JSON.stringify(r));
    return { prefix: r.prefix, class: r.class };
  });
  const w = raw.work ?? {};
  for (const k of ["cost", "n", "bits", "unit_iterations", "max_iterations"]) if (k in w) throw new Error(`toll config: work.${k} belongs to the retired built-in miner; use work.mode and work.standard / work.hardened (docs/policy.md)`);
  const work: WorkPolicy = {
    ...DEFAULT_WORK,
    ...w,
    standard: { ...DEFAULT_WORK.standard, ...(w.standard ?? {}), alg: "pbkdf2-sha256" },
    hardened: { ...DEFAULT_WORK.hardened, ...(w.hardened ?? {}), alg: "argon2id" },
    device_mult: { ...DEFAULT_WORK.device_mult, ...(w.device_mult ?? {}) },
  };
  if (work.mode !== "standard" && work.mode !== "hardened") throw new Error("toll config: work.mode must be standard or hardened");
  for (const m of [work.standard, work.hardened]) {
    if (!(Number.isInteger(m.cost) && m.cost >= 1)) throw new Error("toll config: work cost must be a positive integer");
    if (!(m.unit_tries > 0)) throw new Error("toll config: work unit_tries must be positive");
  }
  if (!(Number.isInteger(work.hardened.memory_kib) && work.hardened.memory_kib! >= 8192 && work.hardened.memory_kib! <= 262144)) throw new Error("toll config: work.hardened.memory_kib must be 8192..262144");
  const s = raw.settlement ?? {};
  if (s.enabled) throw new Error("toll config: settlement is not available in this version (phase 2). Set settlement.enabled: false");
  return {
    site_id,
    secret,
    issuer_public_url,
    hostname: String(raw.hostname ?? new URL(issuer_public_url).hostname),
    allowed_origins: (raw.allowed_origins ?? [new URL(issuer_public_url).origin]).map(String),
    defaults: {
      pass_ttl_s: Number(d.pass_ttl_s ?? 900),
      pass_uses: Number(d.pass_uses ?? 20),
      challenge_ttl_s,
      max_solve_ms: Number(d.max_solve_ms ?? 8000),
    },
    work,
    adaptive: { velocity: Boolean(raw.adaptive?.velocity ?? false) },
    rate_limit: { challenge_per_min: Number(raw.rate_limit?.challenge_per_min ?? 60) },
    cookie: { secure: raw.cookie?.secure ?? "auto" },
    routes,
    settlement: { enabled: false, backend: s.backend, fee_bps: Number(s.fee_bps ?? 1000) },
  };
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): TollConfig {
  return normalizeConfig(parse(readFileSync(path, "utf8")) ?? {}, env);
}

/** Longest matching route prefix wins. Unmapped GET = read, unmapped POST = write (spec §8.4). */
export function classifyPath(routes: RouteRule[], path: string, method: string): { cls: ActionClass; prefix: string } {
  let best: RouteRule | undefined;
  for (const r of routes) if (path.startsWith(r.prefix) && (!best || r.prefix.length > best.prefix.length)) best = r;
  if (best) return { cls: best.class, prefix: best.prefix };
  const m = method.toUpperCase();
  return { cls: m === "GET" || m === "HEAD" || m === "OPTIONS" ? "read" : "write", prefix: "/" };
}
