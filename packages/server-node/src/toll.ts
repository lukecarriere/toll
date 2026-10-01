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
import {
  type FxSource,
  type MemoryLedger,
  type Offer,
  type SettlementEngine,
  type SettlementRail,
  FixedTestRate,
  NoRate,
  StubEngine,
  StubSettler,
  createSettlementRail,
  stubEngineSecret,
  workChallengeUrl,
} from "../../settlement-ln/src/index.ts";
import { type TollConfig, classifyPath, PAGE_VIEW_WARNING } from "./config.ts";
import { Metrics } from "./metrics.ts";
import { PAID_CLASSES, type PriceTable, type PriceStatus } from "./manifest.ts";
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
  /** Paid-request wiring overrides (tests and the demo). Only used when settlement.enabled is true. */
  settlement?: { settler?: StubSettler; engine?: SettlementEngine; fx?: FxSource; ledger?: MemoryLedger };
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
  rail: "work" | "settle";
  claims: PassClaims;
}

export interface PaidRedeemResult extends RedeemResult {
  rail: "settle";
  amount_msat: number;
  fee_msat: number;
  net_msat: number;
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
  const paid = config.settlement.enabled ? createPaidRail() : undefined;
  // Amendment 2 §A: the owner confirmed gating page views. Log the warning at startup and count it.
  const gatedPages = config.routes.filter((r) => r.get === true && r.class !== "read" && r.cost !== 0).map((r) => r.prefix);
  if (config.confirm_page_view_gating && gatedPages.length > 0) metrics.pageViewGateConfirmed({ warning: PAGE_VIEW_WARNING, prefixes: gatedPages });

  /**
   * Paid requests (docs/settlement.md). Phase 2: the local stub backend only. The stub engine's key is
   * derived from the site secret so its seals never collide with challenge or pass signatures.
   */
  function createPaidRail(): { rail: SettlementRail; settler: StubSettler | undefined } {
    const so = opts.settlement ?? {};
    const settler = so.engine ? so.settler : (so.settler ?? new StubSettler());
    const ready: Promise<SettlementEngine> = so.engine ? Promise.resolve(so.engine) : stubEngineSecret(config.secret).then((k) => new StubEngine({ secret: k, settler }));
    const lazy: SettlementEngine = {
      kind: "stub",
      offer: async (o) => (await ready).offer(o),
      verifyPaid: async (o) => (await ready).verifyPaid(o),
      healthy: async () => (await ready).healthy(),
    };
    const fxc = config.settlement.fx;
    const fx = so.fx ?? (fxc.source === "fixed" ? new FixedTestRate(fxc.usd_per_btc!) : new NoRate());
    const rail = createSettlementRail({
      site: config.site_id,
      engine: lazy,
      fx,
      ledger: so.ledger,
      fee_bps: config.settlement.fee_bps,
      offer_ttl_s: config.settlement.offer_ttl_s,
      now,
      firstUse: (key, ttl) => store.firstUse(key, ttl),
      onDegraded: (reason) => metrics.settlementDegraded({ reason }),
      onSettled: (x) => metrics.settled(x.amount_msat),
    });
    return { rail, settler };
  }

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
    return (await issue(input)).challenge;
  }

  /**
   * Challenge plus offers (spec §8.5, settlement.md Q2). Offers go only to agent clients, only when
   * paid requests are on and healthy; otherwise `offers` is []. Never throws for an offer problem.
   */
  async function issueWithOffers(input: IssueInput): Promise<{ challenge: Challenge; offers: Offer[] }> {
    const { challenge, velocity_mult } = await issue(input);
    if (input.client !== "agent" || !paid) return { challenge, offers: [] };
    const offers = await paid.rail.offers(input.action as Exclude<ActionClass, "read">, { velocity: velocity_mult, suspicion: 1 });
    return { challenge, offers };
  }

  /**
   * Offers only, no challenge minted (the 402 to agents carries a `challenge_url` instead, so the
   * work engine runs only if the agent actually asks for it). [] for non-agents or when off/degraded.
   */
  async function offersFor(input: IssueInput): Promise<Offer[]> {
    if (input.client !== "agent" || !paid) return [];
    const { wp } = policyFor(input);
    return paid.rail.offers(input.action as Exclude<ActionClass, "read">, { velocity: wp.mults.velocity, suspicion: 1 });
  }

  /** Where an agent fetches the work challenge for this action (relative to the issuer origin). */
  function challengeUrl(action: ActionClass, path: string): string {
    return workChallengeUrl(config.site_id, action, path);
  }

  /** Work policy for a request (shared by challenges and offers so price and work move together). */
  function policyFor(input: IssueInput) {
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
    return { site, prefix, ua_class, wp };
  }

  async function issue(input: IssueInput): Promise<{ challenge: Challenge; velocity_mult: number }> {
    const { site, prefix, ua_class, wp } = policyFor(input);
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
      escalated: wp.escalated,
      source: input.source ?? "sdk",
    });
    return { challenge, velocity_mult: wp.mults.velocity };
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

  /**
   * Paid redeem (settlement.md §6): the settlement engine checks the proof, the rail books it in the
   * msat ledger, then a short settle pass is minted (Q6 default: one use, 60 s).
   */
  async function redeemPaid(body: unknown, ctx: { ip?: string } = {}): Promise<PaidRedeemResult> {
    if (!paid) throw new TollError("unsupported", "paid redeem is not enabled on this issuer");
    const t0 = performance.now();
    try {
      const r = await paid.rail.redeemPaid(body);
      const s = config.settlement;
      const claims = newPassClaims({ site: config.site_id, cls: r.cls, n: s.pass_uses, ttl_s: s.pass_ttl_s, now: now() });
      await store.setTag("pass:" + claims.jti, "settle", s.pass_ttl_s + 60);
      const pass = await signPass(config.secret, claims);
      // A paid redeem is a redeem: it counts toward velocity, so a paying swarm's price rises too (phase 3).
      velocity.hit(coarseKey(config.site_id, ctx.ip ?? "?", r.cls));
      metrics.redeemOk({ rail: "settle", cls: r.cls, took_ms: null, ua_class: null, client: "agent", verify_ms: Math.round((performance.now() - t0) * 100) / 100 });
      return { pass, exp: claims.exp, cls: claims.cls, rail: "settle", claims, amount_msat: r.amount_msat, fee_msat: r.fee_msat, net_msat: r.net_msat };
    } catch (e) {
      metrics.redeemFail({ reason: e instanceof TollError ? e.code : "error", rail: "settle" });
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
    issueWithOffers,
    offersFor,
    challengeUrl,
    redeemPaid,
    /** Paid-request rail, when enabled (status, owner balance, recent payments). */
    paid: paid?.rail,
    /** Test-only stub backend handle (the demo's test payment endpoint uses it). */
    stubSettler: paid?.settler,
    verifySolution,
    verifyPass,
    findIssued,
    classify: (path: string, method: string) => classifyPath(config.routes, path, method),
    /**
     * Base price of one paid request per class (Amendment 3), from the rail's price(): the same
     * function as the 402 offer. null when this issuer makes no paid offers (settlement off or
     * payouts switched off): the manifest then says "stub" and work only.
     */
    priceTable: (): PriceTable => {
      if (!paid || !paid.rail.isCollecting()) return null;
      return Object.fromEntries(PAID_CLASSES.map((c) => [c, paid.rail.price(c)])) as PriceTable;
    },
    /** "test": paid offers come from the local test backend. "stub": no paid offer here. */
    priceStatus: (): PriceStatus => (paid && paid.rail.isCollecting() ? "test" : "stub"),
    classCovers,
  };
}
