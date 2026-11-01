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
  isCoarseNet,
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
  CashuTestEngine,
  CashuReceiveEngine,
  StubEngine,
  StubSettler,
  createSettlementRail,
  offerIdOf,
  type MintGuard,
  type RailOptions,
  QUOTE_KIND,
  REFUSAL_COUNT_TTL_S,
  mintQuoteRechecks,
  type SweepSummary,
  SWEEP_CURSOR_KEY,
  SWEEP_CURSOR_TTL_S,
  emptySweepSummary,
  sweepMintQuotes,
  l402Enabled,
  stubEngineSecret,
  withQuoteOffer,
  workChallengeUrl,
} from "../../settlement-ln/src/index.ts";
import { type TollConfig, classifyPath, PAGE_VIEW_WARNING } from "./config.ts";
import { Metrics } from "./metrics.ts";
import { PAID_CLASSES, type PriceTable, type PriceStatus, type LoadPricing } from "./manifest.ts";
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
  settlement?: { settler?: StubSettler; engine?: SettlementEngine; fx?: FxSource; ledger?: MemoryLedger; mintGuard?: MintGuard };
}

export interface IssueInput {
  site?: string;
  action: ActionClass;
  path?: string;
  client?: "widget" | "agent";
  userAgent?: string | null;
  /**
   * Client address (velocity key). null or omitted: there is none (a listed proxy sent no usable
   * X-Forwarded-For, the edge had no CF-Connecting-IP, or an SDK caller passed no address), so there
   * is no network: multiplier 1, no velocity key and no velocity count. There is no shared key.
   */
  ip?: string | null;
  source?: "challenge_endpoint" | "middleware";
}

/** A client address to key velocity on; null, omitted or empty means none (no network, multiplier 1). */
const hasIp = (ip: string | null | undefined): ip is string => typeof ip === "string" && ip !== "";

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
  /** The store calls behind mint quotes, with their metrics. Paid presentations and the sweep share them. */
  const quoteStore: Required<Pick<RailOptions, "hasMintQuote" | "reserveMintQuote" | "claimOpenMintQuote" | "releaseMintQuote" | "unlockMintQuote" | "finishMintQuote" | "claimMintQuote" | "noteMintQuoteLoss" | "mintQuoteRefusalsLeft" | "mintQuoteRechecks">> = {
    hasMintQuote: (quote) => store.hasMintQuote ? store.hasMintQuote(quote) : Promise.resolve(false),
    reserveMintQuote: (row) => {
      if (!store.reserveMintQuote) return Promise.reject(new TollError("store_unavailable"));
      return store.reserveMintQuote(row);
    },
    claimOpenMintQuote: (quote) => {
      if (!store.claimOpenMintQuote) return Promise.reject(new TollError("store_unavailable"));
      return store.claimOpenMintQuote(quote);
    },
    releaseMintQuote: (quote) => {
      if (!store.releaseMintQuote) return Promise.reject(new TollError("store_unavailable"));
      return store.releaseMintQuote(quote);
    },
    unlockMintQuote: async (quote) => {
      if (!store.unlockMintQuote) throw new TollError("store_unavailable");
      await store.unlockMintQuote(quote);
    },
    finishMintQuote: async (row) => {
      if (!store.finishMintQuote) throw new TollError("store_unavailable");
      const ok = await store.finishMintQuote(row);
      // Only one finish per quote stores proofs, so a recovered loss row seen after it is this finish's reversal.
      const reversed = ok ? store.mintQuoteLossRows?.().find((o) => o.quote === row.quote && o.recovered) : undefined;
      if (reversed) metrics.mintQuoteReversed({ quote: row.quote, amount: reversed.amount });
      return ok;
    },
    claimMintQuote: (row) => {
      if (!store.claimMintQuote) return Promise.reject(new TollError("store_unavailable"));
      return store.claimMintQuote(row);
    },
    noteMintQuoteLoss: async (x) => {
      if (!store.noteMintQuoteLoss) throw new TollError("store_unavailable");
      await store.noteMintQuoteLoss(x);
      metrics.emit("mint_quote_loss", { quote: x.quote, action: x.action, amount: x.amount, reason: x.reason ?? "" });
    },
    mintQuoteRefusalsLeft: (quote, cap) => store.consume("f:mqr:" + quote, cap, REFUSAL_COUNT_TTL_S),
    mintQuoteRechecks: mintQuoteRechecks(store),
  };

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
    const ready: Promise<SettlementEngine> = so.engine ? Promise.resolve(so.engine) : stubEngineSecret(config.secret).then((k) => {
      const cashu = config.settlement.cashu;
      if (cashu && "mints" in cashu) {
        const receive = new CashuReceiveEngine({
          secret: k, mints: cashu.mints, store: cashu.store,
          fetch: so.mintGuard?.fetch, lookup: so.mintGuard?.lookup, loopbackHttp: so.mintGuard?.loopbackHttp,
        });
        // The flag is read here, not from the config file, so a merged tree does not turn the offer on.
        if (!l402Enabled(process.env.L402_ENABLED)) return receive;
        return withQuoteOffer(receive, {
          secret: k, mint: cashu.mints[0], fetchImpl: so.mintGuard?.fetch ?? fetch, mode: "bolt11",
          guard: so.mintGuard, allowlist: cashu.mints,
        });
      }
      if (cashu && "mint" in cashu) return new CashuTestEngine({ secret: k, mint: cashu.mint });
      return new StubEngine({ secret: k, settler });
    });
    const lazy: SettlementEngine = {
      kind: "stub",
      offer: async (o) => (await ready).offer(o),
      mintQuote: async (o) => {
        const engine = await ready;
        if (!engine.mintQuote) throw new Error("unsupported");
        return engine.mintQuote(o);
      },
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
      ...quoteStore,
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

  /**
   * Load multiplier for a visitor network a relaying site sent (`net`, coarseNet form): the same
   * policy as this issuer's own 402 for an address in that network, because coarseKey gives a network
   * and any address in it the same key. A missing or malformed net is the base price (1), never an
   * error, so sites that send no network keep working.
   */
  function netVelocity(action: Exclude<ActionClass, "read">, net: unknown): number {
    if (!isCoarseNet(net)) return 1;
    return policyFor({ action, ip: net, client: "agent" }).wp.mults.velocity;
  }

  /** Offers relayed to a site (/v1/owner/offers), priced for its visitor's network like offersFor(). [] when off or degraded. */
  async function offersForNet(action: Exclude<ActionClass, "read">, net: unknown): Promise<Offer[]> {
    if (!paid) return [];
    return paid.rail.offers(action, { velocity: netVelocity(action, net), suspicion: 1 });
  }

  /**
   * A paid redeem relayed by a site (/v1/owner/redeem): the rail checks and books it; with a valid
   * net it counts toward that network's velocity like a paid redeem here, so a paying swarm's price
   * rises on the site too. The site mints its own pass. The network is held only as a velocity
   * window key in memory.
   */
  async function redeemRelayed(body: unknown, net: unknown) {
    if (!paid) throw new TollError("unsupported", "paid redeem is not enabled on this issuer");
    const r = await paid.rail.redeemPaid(body);
    if (isCoarseNet(net)) velocity.hit(coarseKey(config.site_id, net, r.cls));
    return r;
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
    const key = hasIp(input.ip) ? coarseKey(site, input.ip, input.action) : null;
    const wp = workParams(config.work, input.action, {
      ua_class,
      recent_redeems: key === null ? 0 : velocity.count(key),
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
  async function verifySolution(challenge: unknown, solution: Solution, ctx: { ip?: string | null; client?: string } = {}): Promise<RedeemResult> {
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
      if (hasIp(ctx.ip)) velocity.hit(coarseKey(c.site, ctx.ip, c.bound.action));
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
   * An agent retried with a test-mint token and no pass yet. Bind the current price, then the same
   * paid-redeem path as POST /v1/redeem. The mint call is inside the engine; this does not check
   * the token locally.
   */
  async function redeemPresentedToken(token: string, ctx: { action: ActionClass; ip?: string | null }): Promise<PaidRedeemResult> {
    if (!paid || !config.settlement.cashu?.enabled || !paid.rail.isCollecting()) throw new TollError("unsupported");
    if (ctx.action === "read") throw new TollError("malformed");
    const cls = ctx.action as Exclude<ActionClass, "read">;
    const { wp } = policyFor({ action: cls, ip: ctx.ip, client: "agent" });
    const offer = await paid.rail.bindOffer(cls, { velocity: wp.mults.velocity, suspicion: 1 });
    if (offer.kind !== "cashu") throw new TollError("unsupported");
    return redeemPaid({ offer_id: offer.id, kind: "cashu", token, credential: offer.credential }, { ip: ctx.ip });
  }

  /**
   * A site forwarded an X-Cashu retry. Same check as redeemPresentedToken, but the site mints the
   * pass: this only books the payment and returns the class.
   */
  async function bookPresentedCashu(token: string, action: ActionClass, net: unknown) {
    if (!paid || !config.settlement.cashu?.enabled || !paid.rail.isCollecting()) throw new TollError("unsupported");
    if (action === "read") throw new TollError("malformed");
    const cls = action as Exclude<ActionClass, "read">;
    const { wp } = policyFor({ action: cls, ip: isCoarseNet(net) ? net : null, client: "agent" });
    const offer = await paid.rail.bindOffer(cls, { velocity: wp.mults.velocity, suspicion: 1 });
    if (offer.kind !== "cashu") throw new TollError("unsupported");
    return redeemRelayed({ offer_id: offer.id, kind: "cashu", token, credential: offer.credential }, net);
  }

  /**
   * An agent retried with Authorization. The token binds the quote.
   * The pass is minted only after the quote is paid and the proofs are in this process.
   */
  async function redeemQuoted(o: { macaroon: string; preimage: string; action: ActionClass; ip?: string | null }): Promise<PaidRedeemResult> {
    const cashu = config.settlement.cashu;
    if (!paid || !cashu || !paid.rail.isCollecting()) throw new TollError("unsupported");
    if (o.action === "read") throw new TollError("malformed");
    return redeemPaid({ offer_id: offerIdOf(o.macaroon), kind: QUOTE_KIND, preimage: o.preimage, macaroon: o.macaroon, action: o.action }, { ip: o.ip });
  }

  /**
   * Paid redeem (settlement.md §6): the settlement engine checks the proof, the rail books it in the
   * msat ledger, then a short settle pass is minted (Q6 default: one use, 60 s).
   */
  async function redeemPaid(body: unknown, ctx: { ip?: string | null } = {}): Promise<PaidRedeemResult> {
    if (!paid) throw new TollError("unsupported", "paid redeem is not enabled on this issuer");
    const t0 = performance.now();
    try {
      const r = await paid.rail.redeemPaid(body);
      const s = config.settlement;
      const claims = newPassClaims({ site: config.site_id, cls: r.cls, n: s.pass_uses, ttl_s: s.pass_ttl_s, now: now() });
      await store.setTag("pass:" + claims.jti, "settle", s.pass_ttl_s + 60);
      const pass = await signPass(config.secret, claims);
      // A paid redeem is a redeem: it counts toward velocity, so a paying swarm's price rises too (phase 3).
      if (hasIp(ctx.ip)) velocity.hit(coarseKey(config.site_id, ctx.ip, r.cls));
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
      let tagged: { tag: string | undefined } | undefined;
      if (o.consume === false) {
        remaining = (await store.peek("uses:" + claims.jti)) ?? claims.n;
        if (remaining <= 0) throw new TollError("exhausted");
      } else if (store.consumeTagged) {
        // One store round trip for the use and the rail tag (edge Durable Object).
        const r = await store.consumeTagged("uses:" + claims.jti, claims.n, ttl, "pass:" + claims.jti);
        remaining = r.remaining;
        if (remaining < 0) throw new TollError("exhausted");
        tagged = r;
      } else {
        remaining = await store.consume("uses:" + claims.jti, claims.n, ttl);
        if (remaining < 0) throw new TollError("exhausted");
      }
      if (o.consume !== false) {
        const rail = (tagged ? tagged.tag : await store.getTag("pass:" + claims.jti)) ?? "unknown";
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
    offersForNet,
    redeemRelayed,
    challengeUrl,
    redeemPaid,
    redeemQuoted,
    redeemPresentedToken,
    bookPresentedCashu,
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
    /**
     * The price of one paid request that applies right now for this caller (Amendment 3 base-price
     * note): the same policy and multipliers as offersFor(), so it equals the live 402 offer.
     * Mints nothing and counts nothing. null when this issuer makes no paid offers.
     */
    currentPrice: (input: IssueInput): { amount_msat: number; usd: string | undefined; load_multiplier: number } | null => {
      if (!paid || !paid.rail.isCollecting()) return null;
      const { wp } = policyFor(input);
      return { ...paid.rail.price(input.action as Exclude<ActionClass, "read">, { velocity: wp.mults.velocity, suspicion: 1 }), load_multiplier: wp.mults.velocity };
    },
    /**
     * currentPrice() for a relaying site's visitor network (POST /v1/owner/quote): the amount its
     * relayed 402 offer carries now. Base price with multiplier 1 for a missing or malformed net.
     * Mints nothing and counts nothing. null when this issuer makes no paid offers.
     */
    currentPriceForNet: (action: Exclude<ActionClass, "read">, net: unknown): { amount_msat: number; usd: string | undefined; load_multiplier: number } | null => {
      if (!paid || !paid.rail.isCollecting()) return null;
      const v = netVelocity(action, net);
      return { ...paid.rail.price(action, { velocity: v, suspicion: 1 }), load_multiplier: v };
    },
    /**
     * Load pricing per paid action for this issuer's own 402 (Amendment 3 base-price note): true when
     * the velocity multiplier is applied to offers (adaptive.velocity on, paid offers collecting).
     */
    loadPricing: (): LoadPricing => {
      const on = !!paid && paid.rail.isCollecting() && config.adaptive.velocity;
      return Object.fromEntries(PAID_CLASSES.map((c) => [c, on])) as LoadPricing;
    },
    /** "test": paid offers come from the local test backend. "stub": no paid offer here. */
    priceStatus: (): PriceStatus => (paid && paid.rail.isCollecting() ? "test" : "stub"),
    /**
     * One bounded pass over stored mint quotes no client will present again (docs: mint-quote sweep).
     * Empty when no Cashu mint list is configured or the store cannot list candidates. Not scheduled
     * here: the caller decides when to run it.
     */
    sweepMintQuotes: async (o: { batch: number; budgetMs: number }): Promise<SweepSummary> => {
      const cashu = config.settlement.cashu;
      if (!config.settlement.enabled || !cashu || !("mints" in cashu) || !store.mintQuoteSweepCandidates) return emptySweepSummary();
      const list = store.mintQuoteSweepCandidates.bind(store);
      const so = opts.settlement ?? {};
      const summary = await sweepMintQuotes({
        mint: cashu.mints[0], fetchImpl: so.mintGuard?.fetch ?? fetch, mode: "bolt11", guard: so.mintGuard, allowlist: cashu.mints,
        has: quoteStore.hasMintQuote, reserve: quoteStore.reserveMintQuote, claimOpen: quoteStore.claimOpenMintQuote, release: quoteStore.releaseMintQuote,
        unlock: quoteStore.unlockMintQuote, finish: quoteStore.finishMintQuote, noteLoss: quoteStore.noteMintQuoteLoss,
        refusalsLeft: quoteStore.mintQuoteRefusalsLeft, rechecks: quoteStore.mintQuoteRechecks,
        candidates: list,
        cursor: { get: () => store.getTag(SWEEP_CURSOR_KEY), set: (quote) => store.setTag(SWEEP_CURSOR_KEY, quote, SWEEP_CURSOR_TTL_S) },
        clock: () => performance.now(),
      }, o);
      metrics.emit("mint_quote_sweep", { ...summary });
      return summary;
    },
    /** Empty when the mint is down, so the manifest does not advertise a method the 402 cannot offer. */
    payMethods: async (): Promise<readonly string[] | undefined> => {
      const cashu = config.settlement.cashu;
      if (!paid || !paid.rail.isCollecting() || !cashu) return undefined;
      const st = await paid.rail.status();
      if (!st.healthy) return [];
      if ("mint" in cashu) return ["cashu", QUOTE_KIND];
      return l402Enabled(process.env.L402_ENABLED) ? ["cashu", QUOTE_KIND] : ["cashu"];
    },
    classCovers,
  };
}
