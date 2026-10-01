// Toll reference demo (spec §15): issuer + widget + a tiny site on one origin.
//   npm run demo   ->   http://localhost:8787
import express from "express";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createToll, loadConfig, protect, tollRouter, type TollConfig, Metrics, MemoryStore } from "../packages/server-node/src/index.ts";
import { formsPage, hammerPage, type Comment } from "./pages.ts";
import { COPY } from "./strings.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

export function createDemo(o: { config?: TollConfig; metrics?: Metrics; store?: MemoryStore; host?: string } = {}) {
  const config = o.config ?? loadConfig(here + "toll.yaml");
  const toll = createToll(config, { metrics: o.metrics, store: o.store });
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

  app.get("/", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : null;
    const results = q ? [...corpus, ...comments.map((c) => c.text)].filter((t) => t.toLowerCase().includes(q.toLowerCase())) : undefined;
    res.type("html").send(formsPage({ host: host(), comments, sent: typeof req.query.sent === "string" ? req.query.sent : null, q, results }));
  });
  app.get("/hammer", (_req, res) => res.type("html").send(hammerPage({ host: host() })));

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
  app.get("/demo/stats", (_req, res) => {
    const s = toll.metrics.snapshot();
    res.set("cache-control", "no-store").json({ accepted: s.pass_accept, rejected: s.pass_reject, mean_solve_ms: s.avg_took_ms, mode: "work-only" });
  });
  return { app, toll, messages: () => messages };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.TOLL_SECRET) {
    process.env.TOLL_SECRET = randomBytes(32).toString("hex");
    console.error("[demo] TOLL_SECRET not set; using a random secret for this run.");
  }
  const port = Number(process.env.PORT ?? 8787);
  const bind = process.env.HOST ?? "127.0.0.1";
  const { app, toll } = createDemo();
  app.listen(port, bind, () => console.error(`[demo] Toll demo on http://localhost:${port}  (issuer + widget, work-only)`));
  const t = setInterval(() => toll.metrics.flush(), 60_000);
  t.unref();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { toll.metrics.flush(); process.exit(0); });
}
