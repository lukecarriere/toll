// Work policy, spec §9.3 and §9.5. Turns an action class plus context into challenge parameters.
//
// expected_iterations = unit_iterations * class_mult * device_mult * velocity_mult * suspicion_mult
// The sub-puzzle span is chosen so the expected total work matches; the worst case is about 2x that.
// The worst case is capped at max_iterations (the owner's "longest check" turned into work).

import { type ActionClass, CLASS_MULT } from "./classes.ts";

export interface WorkPolicy {
  /** PBKDF2 iterations per KDF call (the challenge `cost`). */
  cost: number;
  /** Sub-puzzles per challenge (`n`). */
  n: number;
  /** Target prefix length in bits. */
  bits: number;
  /** Expected KDF iterations for a 1x action class on a desktop with no velocity. */
  unit_iterations: number;
  /** Hard cap on worst-case iterations for any single challenge. */
  max_iterations: number;
  device_mult: { mobile: number; desktop: number };
  /** Velocity steps: [count threshold within window, multiplier], ascending. */
  velocity_steps: [number, number][];
  velocity_window_s: number;
}

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
  cost: number;
  n: number;
  bits: number;
  span: number;
  expected_iterations: number;
  max_iterations: number;
  mults: { class: number; device: number; velocity: number; suspicion: number };
}

export function workParams(policy: WorkPolicy, action: ActionClass, ctx: PolicyContext): WorkParamsOut {
  const cls = CLASS_MULT[action];
  if (cls === 0) throw new Error("read is free");
  const device = policy.device_mult[ctx.ua_class];
  const velocity = ctx.velocity_enabled ? velocityMult(policy, ctx.recent_redeems) : 1;
  const suspicion = Math.min(8, Math.max(1, ctx.suspicion_mult ?? 1));
  const expected = policy.unit_iterations * cls * device * velocity * suspicion;
  // Mean tries per sub-puzzle = (span + 1) / 2.
  let span = Math.max(1, Math.round((2 * expected) / (policy.n * policy.cost) - 1));
  const capSpan = Math.max(1, Math.floor(policy.max_iterations / (policy.n * policy.cost)));
  span = Math.min(span, capSpan);
  return {
    cost: policy.cost,
    n: policy.n,
    bits: policy.bits,
    span,
    expected_iterations: Math.round((policy.n * policy.cost * (span + 1)) / 2),
    max_iterations: policy.n * policy.cost * span,
    mults: { class: cls, device, velocity, suspicion },
  };
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
