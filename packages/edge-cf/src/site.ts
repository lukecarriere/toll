// toll-site worker: static assets plus the work-only demo. The gate and issuer are the shared edge
// handler. The store is one SQLite-backed Durable Object. POST /demo/contact is the origin: it
// answers Accepted and never stores, echoes, emails or logs the text.
import { TollError } from "../../protocol/src/index.ts";
import { createEdgeHandler, type EdgeEnv } from "./handler.ts";
import { DurableObjectStore, storeFailSlot, TollStoreDO, type TollDoStub } from "./do-store.ts";

export { TollStoreDO };

interface Assets { fetch(req: Request): Promise<Response>; }
interface DoNs {
  idFromName(name: string): unknown;
  get(id: unknown): TollDoStub;
}

export interface SiteEnv extends EdgeEnv {
  ASSETS: Assets;
  TOLL_STORE: DoNs;
  /** Whole-process fail-closed switch. Unset in wrangler.toml. */
  STORE_FAIL?: string;
  /**
   * Test-only. Unset in wrangler.toml. When "1", the x-toll-store-fail request header makes this
   * request's store calls fail closed. Pages are served without the store, so they stay up.
   */
  TOLL_TEST_HOOKS?: string;
}

const INSTANCE = "toll";

function stub(env: SiteEnv): TollDoStub {
  return env.TOLL_STORE.get(env.TOLL_STORE.idFromName(INSTANCE));
}

function storeFor(env: SiteEnv): DurableObjectStore {
  return new DurableObjectStore(stub(env));
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const handler = createEdgeHandler<SiteEnv>({
  // A stub from one request cannot be used on the next (Workers I/O isolation).
  freshStore: true,
  store: storeFor,
  preserveFields: false,
  async forward(req, env, url) {
    // In-worker origin. The body is not read, stored, echoed or logged.
    if (req.method.toUpperCase() === "POST" && url.pathname === "/demo/contact") {
      if ((req.headers.get("accept") ?? "").includes("application/json")) return json({ ok: true });
      return new Response(null, { status: 303, headers: { location: "/demo?sent=contact" } });
    }
    return env.ASSETS.fetch(req);
  },
});

function inject(req: Request, env: SiteEnv): boolean {
  if (env.STORE_FAIL === "1") return true;
  return env.TOLL_TEST_HOOKS === "1" && req.headers.get("x-toll-store-fail") === "1";
}

export default {
  async fetch(req: Request, env: SiteEnv): Promise<Response> {
    return storeFailSlot.run(inject(req, env), async () => {
      const url = new URL(req.url);
      const method = req.method.toUpperCase();
      // Counts for the demo page. A store failure here is 503; the page itself is a static asset.
      if (url.pathname === "/demo/stats" && (method === "GET" || method === "HEAD")) {
        try {
          const c = await storeFor(env).counts();
          return new Response(method === "HEAD" ? null : JSON.stringify(c), {
            status: 200,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        } catch (e) {
          const code = e instanceof TollError ? e.code : "store_unavailable";
          return json({ error: code }, 503);
        }
      }
      return handler.fetch(req, env);
    });
  },
};
