// The discovery documents (/.well-known/toll.json and /.well-known/agents.json) exactly as each
// emitter sends them, from the source tree at `root`: the Node issuer (through the demo app, the real
// HTTP router, both with paid offers and work only), the edge Worker (the bundle wrangler serves,
// work only) and the WordPress plugin (tests/php/run-discovery.php, paid and work only).
// tests/site-url.test.ts compares them with tests/fixtures/discovery-23108ec.json.
//
// Regenerate the golden file from a 23108ec tree (it must be 23108ec's code, not this branch's):
//   git -C <repo> archive 23108ec | tar -x -C /tmp/toll-23108ec
//   ln -s <repo>/node_modules /tmp/toll-23108ec/node_modules   (same for packages/server-php/vendor,
//     packages/widget/node_modules and packages/work-adapter/node_modules)
//   (cd /tmp/toll-23108ec && node scripts/gen-strings.mjs && node packages/widget/build.mjs)
//   node tests/discovery-docs.ts /tmp/toll-23108ec tests/fixtures/discovery-23108ec.json
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SECRET = "test-secret-for-automated-tests-only-0123456789";
export const NODE_HOST = "site.test";
export const EDGE_ORIGIN = "https://edge-site.test";
const PATHS = ["toll.json", "agents.json"] as const;
type Docs = Record<string, string>;

function baseConfig(paid: boolean) {
  return {
    site_id: "site_test",
    secret: SECRET,
    issuer_public_url: "http://localhost:8787",
    rate_limit: { challenge_per_min: 1000 },
    routes: [{ prefix: "/contact", class: "write" }, { prefix: "/comments", class: "write" }, { prefix: "/search", class: "search" }],
    ...(paid ? { settlement: { enabled: true, backend: "stub", fee_bps: 1000, fx: { source: "fixed", usd_per_btc: 100000 } } } : {}),
  };
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, path, headers: { host: NODE_HOST } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", fail);
    r.end();
  });
}

/** Node issuer through the demo app at `root`. `env` is what normalizeConfig reads (TOLL_SITE_URL). `extra` merges into the config. */
export async function nodeDocs(root: string, env: Record<string, string | undefined>, extra: Record<string, unknown> = {}): Promise<Docs> {
  const { normalizeConfig, Metrics, MemoryStore } = await import(pathToFileURL(root + "/packages/server-node/src/index.ts").href);
  const { createDemo } = await import(pathToFileURL(root + "/demo/server.ts").href);
  const out: Docs = {};
  for (const variant of ["paid", "work"] as const) {
    const config = normalizeConfig({ ...baseConfig(variant === "paid"), ...extra }, env);
    const demo = createDemo({ config, metrics: new Metrics(() => {}), store: new MemoryStore() });
    const server: Server = await new Promise((ok) => { const s = demo.app.listen(0, "127.0.0.1", () => ok(s)); });
    try {
      for (const p of PATHS) {
        const r = await get((server.address() as AddressInfo).port, "/.well-known/" + p);
        if (r.status !== 200) throw new Error(`node ${variant} ${p}: HTTP ${r.status}`);
        out[`node ${variant} ${p}`] = r.body;
      }
    } finally {
      server.closeAllConnections?.();
      await new Promise((ok) => server.close(() => ok(null)));
    }
  }
  return out;
}

/** The edge Worker bundle built from `root` (packages/edge-cf/build.mjs, as wrangler serves it), called in process. */
export async function edgeDocs(root: string, vars: Record<string, string | undefined>, warn?: (m: string) => void): Promise<Docs> {
  execFileSync(process.execPath, [root + "/packages/edge-cf/build.mjs"], { stdio: ["ignore", "ignore", "inherit"] });
  const worker = (await import(pathToFileURL(root + "/packages/edge-cf/dist/worker.js").href + "?t=" + Date.now() + Math.random())).default;
  const env = { SITE_ID: "site_edge", SITE_SECRET: "edge-test-secret-do-not-use-000001", ORIGIN: "http://127.0.0.1:9", ...vars };
  const out: Docs = {};
  const log = console.log;
  const cwarn = console.warn;
  console.log = () => {}; // the Worker's discovery counter line
  if (warn) console.warn = warn;
  try {
    for (const p of PATHS) {
      const r: Response = await worker.fetch(new Request(EDGE_ORIGIN + "/.well-known/" + p), env);
      if (r.status !== 200) throw new Error(`edge ${p}: HTTP ${r.status}`);
      out[`edge work ${p}`] = await r.text();
    }
  } finally {
    console.log = log;
    console.warn = cwarn;
  }
  return out;
}

/** The WordPress plugin at `root`. `constant` is the TOLL_SITE_URL constant (undefined: not defined). Returns the bodies and each request's stderr. */
export function phpDocs(root: string, constant?: unknown): { docs: Docs; stderr: Docs } {
  const docs: Docs = {};
  const stderr: Docs = {};
  for (const variant of ["paid", "work"] as const) {
    for (const p of PATHS) {
      const args = [HERE + "php/run-discovery.php", "serve", root + "/packages/wp-toll-gate", root + "/packages/server-php/vendor/autoload.php", variant, p];
      if (constant !== undefined) args.push(JSON.stringify(constant));
      const r = spawnSync("php", args, { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`php ${variant} ${p}: exit ${r.status}\n${r.stderr}`);
      docs[`wp ${variant} ${p}`] = r.stdout;
      stderr[`wp ${variant} ${p}`] = r.stderr;
    }
  }
  return { docs, stderr };
}

/** Every document from every emitter with TOLL_SITE_URL unset. */
export async function allDocsUnset(root: string): Promise<Docs> {
  return { ...(await nodeDocs(root, {})), ...(await edgeDocs(root, {})), ...phpDocs(root).docs };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, outFile] = process.argv.slice(2);
  if (!root || !outFile) throw new Error("usage: node tests/discovery-docs.ts <23108ec tree> <out.json>");
  const commit = execFileSync("git", ["-C", HERE, "rev-parse", "23108ec"], { encoding: "utf8" }).trim();
  const docs = await allDocsUnset(root);
  writeFileSync(outFile, JSON.stringify({ commit, how: "node tests/discovery-docs.ts <23108ec tree> <out> (see the header of tests/discovery-docs.ts)", docs }, null, 2) + "\n");
  console.log(`wrote ${Object.keys(docs).length} documents from ${root}`);
  process.exit(0);
}
