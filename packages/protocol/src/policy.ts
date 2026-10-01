// Work policy, spec §9.3 and §9.5 (behavioural since Amendment 1: the vendor supplies the proof-of-work check).
// Turns an action class plus context into engine parameters for the work adapter.
//
// expected_tries = unit_tries[mode] * class_mult * device_mult * velocity_mult * suspicion_mult
// The engine hides a counter uniform in [0, counter_max) with counter_max = 2 * expected_tries, so
// the mean is expected_tries and the worst case is counter_max tries. counter_max is capped at
// max_units * unit_tries (the owner's "longest check" turned into work).

import { type ActionClass, CLASS_MULT } from "./classes.ts";

export type WorkAlg = "pbkdf2-sha256" | "argon2id";
export type WorkMode = "standard" | "hardened";

export interface EngineMode {
  alg: WorkAlg;
  /** PBKDF2 iterations per try, or Argon2id passes (t). */
  cost: number;
  /** Argon2id memory in KiB (m). */
  memory_kib?: number;
  /** Argon2id lanes (p). */
  parallelism?: number;
  /** Expected tries for a 1x action class on a desktop with no velocity. */
  unit_tries: number;
}

export interface WorkPolicy {
  /** standard = PBKDF2 (fast, GPU-friendly); hardened = Argon2id (memory-hard). */
  mode: WorkMode;
  standard: EngineMode;
  hardened: EngineMode;
  /** Worst-case cap per challenge, in units of unit_tries. */
  max_units: number;
  device_mult: { mobile: number; desktop: number };
  /** Velocity steps: [count threshold within window, multiplier], ascending. */
  velocity_steps: [number, number][];
  velocity_window_s: number;
  /**
   * Argon2id escalation (spec §9.2, §9.3; phase 3). With adaptive on, a standard-mode challenge
   * switches to the hardened engine when velocity_mult >= at_velocity (burst from one coarse key)
   * or the action class is listed (admin with no pass). Hardened mode is always Argon2id anyway.
   */
  escalate?: { at_velocity: number; classes: ActionClass[] };
}

export const DEFAULT_ESCALATE = { at_velocity: 4, classes: ["admin"] as ActionClass[] };

export interface PolicyContext {
  ua_class: "mobile" | "desktop";
  /** Redeems in the window for the coarse key (site + /24 or /48 + action). */
  recent_redeems: number;
  suspicion_mult?: number;
  velocity_enabled: boolean;
}

export function velocityMult(policy: WorkPolicy, count: number): number {
  let m = 1;
  for (const [threshold, mult] of policy.velocity_steps) if (count >= threshold) m = mult;
  return m;
}

export interface WorkParamsOut {
  mode: WorkMode;
  alg: WorkAlg;
  cost: number;
  memory_kib?: number;
  parallelism?: number;
  /** Exclusive bound of the hidden counter: worst case tries. */
  counter_max: number;
  expected_tries: number;
  /** expected_tries in units of the engine's unit_tries (comparable across an escalation). */
  units: number;
  /** True when adaptive escalation switched a standard-mode challenge to the hardened engine. */
  escalated: boolean;
  mults: { class: number; device: number; velocity: number; suspicion: number };
}

export function workParams(policy: WorkPolicy, action: ActionClass, ctx: PolicyContext): WorkParamsOut {
  const cls = CLASS_MULT[action];
  if (cls === 0) throw new Error("read is free");
  const device = policy.device_mult[ctx.ua_class];
  const velocity = ctx.velocity_enabled ? velocityMult(policy, ctx.recent_redeems) : 1;
  const esc = policy.escalate ?? DEFAULT_ESCALATE;
  const escalated = policy.mode === "standard" && ctx.velocity_enabled && (velocity >= esc.at_velocity || esc.classes.includes(action));
  const mode: WorkMode = escalated ? "hardened" : policy.mode;
  const m = policy[mode];
  const suspicion = Math.min(8, Math.max(1, ctx.suspicion_mult ?? 1));
  const expected = m.unit_tries * cls * device * velocity * suspicion;
  const cap = Math.max(1, Math.floor(policy.max_units * m.unit_tries));
  const counter_max = Math.min(cap, Math.max(1, Math.round(2 * expected)));
  const out: WorkParamsOut = {
    mode,
    alg: m.alg,
    cost: m.cost,
    counter_max,
    expected_tries: (counter_max + 1) / 2,
    units: Math.round(((counter_max + 1) / 2 / m.unit_tries) * 100) / 100,
    escalated,
    mults: { class: cls, device, velocity, suspicion },
  };
  if (m.alg === "argon2id") { out.memory_kib = m.memory_kib ?? 32768; out.parallelism = m.parallelism ?? 1; }
  return out;
}

/** Coarse velocity key: site + /24 (IPv4) or /48 (IPv6) + action. Used for cost only, never to block. */
export function coarseKey(site: string, ip: string, action: string): string {
  let net = ip;
  const v4 = ip.replace(/^::ffff:/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) net = v4.split(".").slice(0, 3).join(".") + ".0/24";
  else if (ip.includes(":")) net = expandV6(ip).slice(0, 3).join(":") + "::/48";
  return `${site}|${net}|${action}`;
}

function expandV6(ip: string): string[] {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail !== undefined ? Array(Math.max(0, 8 - h.length - t.length)).fill("0") : [];
  return [...h, ...fill, ...t].map((x) => x.toLowerCase().padStart(4, "0"));
}

export function uaClass(userAgent: string | undefined | null): "mobile" | "desktop" {
  return userAgent && /Mobi|Android|iPhone|iPad/i.test(userAgent) ? "mobile" : "desktop";
}
