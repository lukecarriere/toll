// The Toll server SDK (spec §12): issueChallenge, verifySolution, verifyPass, middleware.

import {
  type ActionClass,
  type Challenge,
  type PassClaims,
  TollError,
  checkChallenge,
  classCovers,
  coarseKey,
  isActionClass,
  mintChallenge,
  newPassClaims,
  signPass,
  uaClass,
  verifyPassToken,
  workParams,
} from "../../protocol/src/index.ts";
import { createWorkAdapter, type WorkAdapter } from "../../work-adapter/src/index.ts";
import { type TollConfig, classifyPath } from "./config.ts";
import { Metrics } from "./metrics.ts";
import { MemoryStore, type TollStore, WindowCounter } from "./stores.ts";

export interface TollOptions {
  store?: TollStore;
  metrics?: Metrics;
  /** Unix seconds. Injectable for tests. */
  now?: () => number;
  /**
   * Test and benchmark hook: choose the hidden counter in [0, counter_max) instead of uniformly at
   * random (for example near the top, so a slow-path UI test is not left to chance). Never set in production.
   */
  pickCounter?: (counter_max: number) => number;
}

export interface IssueInput {
  site?: string;
  action: ActionClass;
  path?: string;
  client?: "widget" | "agent";
  userAgent?: string | null;
  ip?: string;
  source?: "challenge_endpoint" | "middleware";
}

export interface Solution {
  /** The engine's solution, opaque to Toll (docs/adapters.md). */
  work: unknown;
  took_ms?: unknown;
  ua_class?: unknown;
}

export interface RedeemResult {
  pass: string;
  exp: number;
  cls: ActionClass;
  rail: "work";
  claims: PassClaims;
}

export type Toll = ReturnType<typeof createToll>;

export function createToll(config: TollConfig, opts: TollOptions = {}) {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const store: TollStore = opts.store ?? new MemoryStore(() => now());
  const metrics = opts.metrics ?? new Metrics();
  const challengeRate = new WindowCounter(60, () => now());
  const velocity = new WindowCounter(config.work.velocity_window_s, () => now());
  const issued = new Map<string, { c: Challenge; until: number }>();
  const engine: WorkAdapter = createWorkAdapter(config.secret);

  function rememberIssued(c: Challenge) {
    const t = now();
    issued.set(c.id, { c, until: c.exp + 60 });
    if (issued.size > 10_000) for (const [k, v] of issued) if (v.until <= t) issued.delete(k);
  }

  /** Per-IP rate limit for minting challenges (spec §16). Returns false when over the limit. */
  function allowChallenge(ip: string | undefined): boolean {
    return challengeRate.hit("ip|" + (ip ?? "?")) <= config.rate_limit.challenge_per_min;
  }

  async function issueChallenge(input: IssueInput): Promise<Challenge> {
    const site = input.site ?? config.site_id;
    if (site !== config.site_id) throw new TollError("wrong_site");
    if (!isActionClass(input.action) || input.action === "read") throw new TollError("malformed", "action must be search, write, account or admin");
    const prefix = input.path ? classifyPath(config.routes, input.path, "POST").prefix : "/";
    const ua_class = uaClass(input.userAgent);
    const key = coarseKey(site, input.ip ?? "?", input.action);
    const wp = workParams(config.work, input.action, {
      ua_class,
      recent_redeems: velocity.count(key),
      velocity_enabled: config.adaptive.velocity,
    });
    const challenge = await mintChallenge({
      secret: config.secret,
      site,
      action: input.action,
      path_prefix: prefix,
      alg: wp.alg,
      ttl_s: config.defaults.challenge_ttl_s,
      now: now(),
      makeWork: async (tid, exp) => (await engine.issue({ tid, exp, spec: { alg: wp.alg, cost: wp.cost, memory_kib: wp.memory_kib, parallelism: wp.parallelism, counter_max: wp.counter_max }, counter: opts.pickCounter ? Math.min(wp.counter_max - 1, Math.max(0, Math.floor(opts.pickCounter(wp.counter_max)))) : undefined })) as unknown as Record<string, unknown>,
    });
    rememberIssued(challenge);
    metrics.challengeMinted({
      cls: input.action,
      client: input.client ?? "widget",
      ua_class,
      mode: wp.mode,
      alg: wp.alg,
      counter_max: wp.counter_max,
      expected_tries: wp.expected_tries,
      velocity_mult: wp.mults.velocity,
      source: input.source ?? "sdk",
    });
    return challenge;
  }

  /**
   * Verify a work solution and mint a pass. Order: shape, signature, time, site (cheap) ->
   * single-use claim on the challenge id (replay) -> engine verify (one HMAC via the engine's key
   * signature). The id is consumed before the engine check, so each challenge is verified once.
   */
  async function verifySolution(challenge: unknown, solution: Solution, ctx: { ip?: string; client?: string } = {}): Promise<RedeemResult> {
    let cls: string | undefined;
    try {
      const c = await checkChallenge(config.secret, challenge, { now: now(), site: config.site_id });
      cls = c.bound.action;
      const fresh = await store.firstUse("chal:" + c.id, c.exp - now() + 60);
      if (!fresh) throw new TollError("replay");
      const v = await engine.verify(c.work, solution?.work, { tid: c.id, alg: c.alg });
      const verify_ms = v.verify_ms;
      if (!v.ok) throw new TollError(v.code === "expired" ? "expired" : v.code === "malformed" ? "malformed" : "bad_solution");
      const claims = newPassClaims({ site: c.site, cls: c.bound.action, n: config.defaults.pass_uses, ttl_s: config.defaults.pass_ttl_s, now: now() });
      await store.setTag("pass:" + claims.jti, "work", config.defaults.pass_ttl_s + 60);
      const pass = await signPass(config.secret, claims);
      velocity.hit(coarseKey(c.site, ctx.ip ?? "?", c.bound.action));
      const took = Number.isFinite(solution?.took_ms) ? Math.max(0, Math.round(Number(solution.took_ms))) : null;
      const ua = solution?.ua_class === "mobile" || solution?.ua_class === "desktop" ? solution.ua_class : null;
      metrics.redeemOk({ rail: "work", cls: c.bound.action, took_ms: took, ua_class: ua, client: ctx.client ?? "widget", verify_ms });
      return { pass, exp: claims.exp, cls: claims.cls, rail: "work", claims };
    } catch (e) {
      const reason = e instanceof TollError ? e.code : "error";
      metrics.redeemFail({ reason, cls, rail: "work" });
      throw e;
    }
  }

  /** Look up a challenge this process issued (for redeem bodies that carry only challenge_id). */
  function findIssued(id: unknown): Challenge | undefined {
    if (typeof id !== "string") return undefined;
    const e = issued.get(id);
    return e && e.until > now() ? e.c : undefined;
  }

  /**
   * Check a pass for an action. With consume=true (the default for protected writes), one of the
   * pass's `n` uses is spent; a pass with no uses left is rejected.
   */
  async function verifyPass(token: unknown, o: { action?: ActionClass; path?: string; method?: string; consume?: boolean } = {}): Promise<PassClaims & { remaining: number }> {
    const action = o.action ?? classifyPath(config.routes, o.path ?? "/", o.method ?? "POST").cls;
    let claims: PassClaims;
    try {
      claims = await verifyPassToken(config.secret, token, { now: now(), site: config.site_id, action });
      const ttl = claims.exp - now() + 60;
      let remaining: number;
      if (o.consume === false) {
        remaining = (await store.peek("uses:" + claims.jti)) ?? claims.n;
        if (remaining <= 0) throw new TollError("exhausted");
      } else {
        remaining = await store.consume("uses:" + claims.jti, claims.n, ttl);
        if (remaining < 0) throw new TollError("exhausted");
      }
      if (o.consume !== false) {
        const rail = (await store.getTag("pass:" + claims.jti)) ?? "unknown";
        metrics.passAccept({ rail, cls: claims.cls, action, remaining });
      }
      return { ...claims, remaining };
    } catch (e) {
      if (o.consume !== false) metrics.passReject({ reason: e instanceof TollError ? e.code : "error", action });
      throw e;
    }
  }

  return {
    config,
    metrics,
    store,
    now,
    allowChallenge,
    issueChallenge,
    verifySolution,
    verifyPass,
    findIssued,
    classify: (path: string, method: string) => classifyPath(config.routes, path, method),
    classCovers,
  };
}
