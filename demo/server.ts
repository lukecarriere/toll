// Toll reference demo (spec §15): issuer + widget + a tiny site on one origin.
//   npm run demo   ->   http://localhost:8787
import express from "express";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createToll, loadConfig, protect, tollRouter, type TollConfig, type TollOptions, Metrics, MemoryStore } from "../packages/server-node/src/index.ts";
import { formsPage, hammerPage, type Comment, type PaidView } from "./pages.ts";
import { COPY } from "./strings.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

export function createDemo(o: { config?: TollConfig; metrics?: Metrics; store?: MemoryStore; host?: string; pickCounter?: (counter_max: number) => number; settlement?: TollOptions["settlement"] } = {}) {
  const config = o.config ?? loadConfig(here + "toll.yaml");
  const toll = createToll(config, { metrics: o.metrics, store: o.store, pickCounter: o.pickCounter, settlement: o.settlement });
  const app = express();
  app.disable("x-powered-by");
  const comments: Comment[] = [
    { name: "Jordan M.", text: "Great write-up, thanks for sharing the checklist.", at: Date.now() - 120_000 },
    { name: "Priya S.", text: "Same question as above about Saturday.", at: Date.now() },
  ];
  const corpus = ["Saturday workshop: forms and spam", "Workshop checklist", "Contact the organisers", "Comment guidelines"];
  let messages = 0;

  app.use((req, res, next) => {
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("x-content-type-options", "nosniff");
    next();
  });
  app.use(tollRouter(toll));
  app.use("/assets", express.static(here + "public", { maxAge: 0 }));

  const host = () => o.host ?? new URL(config.issuer_public_url).host;
  const wantsJson = (req: express.Request) => String(req.headers.accept ?? "").includes("application/json");

  /** Owner-facing view of paid requests: USD strings only, null amounts when the rate is unavailable. */
  async function paidView(): Promise<PaidView | null> {
    if (!toll.paid) return null;
    const st = await toll.paid.status();
    const b = toll.paid.balance();
    // Owner switched paid requests off -> "work-only" (not "paused", which means the backend failed).
    const mode = !st.collecting ? COPY.modeWorkOnly : st.healthy ? COPY.modePaymentsOn : COPY.modePaymentsPaused;
    return {
      mode,
      requests: b.paid_requests,
      collected: b.usd?.collected ?? null,
      available: b.usd?.available ?? null,
      agentAccepted: toll.metrics.byTag["settle|write"]?.pass_accept ?? 0,
      feeBps: toll.paid.fee_bps,
      collecting: st.collecting,
      replayRejected: toll.paid.replayRejected(),
    };
  }

  app.get("/", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : null;
    const results = q ? [...corpus, ...comments.map((c) => c.text)].filter((t) => t.toLowerCase().includes(q.toLowerCase())) : undefined;
    res.type("html").send(formsPage({ host: host(), comments, sent: typeof req.query.sent === "string" ? req.query.sent : null, q, results, paid: await paidView() }));
  });
  app.get("/hammer", async (_req, res) => res.type("html").send(hammerPage({ host: host(), paid: await paidView() })));

  const noJs = { noJsMessage: COPY.noJs };
  app.post("/contact", protect(toll, { action: "write", ...noJs }), (req, res) => {
    messages++; // message bodies are not stored or logged
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect(303, "/?sent=contact#contact");
  });
  app.post("/comments", protect(toll, { action: "write", ...noJs }), (req, res) => {
    const text = String((req as any).body?.comment ?? "").trim().slice(0, 500);
    if (text) comments.push({ name: "You", text, at: Date.now() });
    if (comments.length > 50) comments.splice(2, comments.length - 50);
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect(303, "/#comments");
  });
  app.post("/search", protect(toll, { action: "search", ...noJs }), (req, res) => {
    const q = String((req as any).body?.q ?? "").slice(0, 100);
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect(303, "/?q=" + encodeURIComponent(q) + "#search");
  });
  app.get("/demo/stats", async (_req, res) => {
    const s = toll.metrics.snapshot();
    const pv = await paidView();
    // `paid.ledger` (integer msat) is for the agent script's summary; the page shows only the USD strings.
    const passes = { work: 0, settle: 0 };
    for (const [k, v] of Object.entries(s.by_tag)) {
      const rail = k.split("|")[0];
      if (rail === "work" || rail === "settle") passes[rail] += v.pass_accept;
    }
    const paid = pv && toll.paid ? { ...pv, offer_shown: s.offer_shown, paid: s.paid, work_after_402: s.work_after_402, challenges_minted: s.challenges_minted, pass_absent: s.pass_absent, settled_msat: s.settled_msat, passes, ledger: toll.paid.balance().msat, fee_bps: toll.paid.fee_bps } : null;
    res.set("cache-control", "no-store").json({ accepted: s.pass_accept, rejected: s.turned_away, mean_solve_ms: s.avg_took_ms, mode: pv ? pv.mode : COPY.modeWorkOnly, paid });
  });

  // TEST ONLY: the local test backend's payer, standing in for the client's payment app in the demo
  // and the agent script. Mounted only with the stub backend; it never moves real money.
  // Demo-only working toggle for the owner block's "Collect usage payouts" (PM confirmed). JSON only,
  // so a cross-site form cannot flip it. Off: no offers, agents get the work challenge (403).
  if (toll.paid) {
    const rail = toll.paid;
    app.post("/demo/payouts", express.json({ limit: "1kb" }), (req, res) => {
      if (typeof req.body?.collect !== "boolean") return res.status(400).json({ error: "malformed" });
      rail.setCollecting(req.body.collect);
      res.set("cache-control", "no-store").json({ collect: rail.isCollecting() });
    });
  }

  const settler = toll.stubSettler;
  if (settler) {
    app.post("/demo/stub-pay", express.json({ limit: "4kb" }), (req, res) => {
      try {
        res.set("cache-control", "no-store").json({ preimage: settler.pay(String(req.body?.invoice ?? "")) });
      } catch {
        res.status(400).json({ error: "unknown_invoice" });
      }
    });
  }
  return { app, toll, messages: () => messages };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.TOLL_SECRET) {
    process.env.TOLL_SECRET = randomBytes(32).toString("hex");
    console.error("[demo] TOLL_SECRET not set; using a random secret for this run.");
  }
  const port = Number(process.env.PORT ?? 8787);
  const bind = process.env.HOST ?? "127.0.0.1";
  const config = loadConfig(here + "toll.yaml");
  // TOLL_WORK_MODE=hardened switches the demo to the memory-hard mode (docs/policy.md).
  if (process.env.TOLL_WORK_MODE === "hardened" || process.env.TOLL_WORK_MODE === "standard") config.work.mode = process.env.TOLL_WORK_MODE;
  const { app, toll } = createDemo({ config });
  const mode = config.settlement.enabled ? `paid requests on the local test backend, fixed test rate ${config.settlement.fx.source === "fixed" ? config.settlement.fx.usd_per_btc : "none"}` : "work-only";
  app.listen(port, bind, () => console.error(`[demo] Toll demo on http://localhost:${port}  (issuer + widget, ${mode}, ${config.work.mode} mode)`));
  const t = setInterval(() => toll.metrics.flush(), 60_000);
  t.unref();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { toll.metrics.flush(); process.exit(0); });
}
