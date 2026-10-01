import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { normalizeConfig, Metrics, MemoryStore, type TollConfig } from "../packages/server-node/src/index.ts";
import { createDemo } from "../demo/server.ts";

export const TEST_SECRET = "test-secret-for-automated-tests-only-0123456789";

export function testConfig(over: Record<string, any> = {}): TollConfig {
  return normalizeConfig({
    site_id: "site_test",
    secret: TEST_SECRET,
    issuer_public_url: "http://localhost:8787",
    rate_limit: { challenge_per_min: 1000 },
    routes: [
      { prefix: "/contact", class: "write" },
      { prefix: "/comments", class: "write" },
      { prefix: "/search", class: "search" },
    ],
    ...over,
  });
}

export interface Running {
  url: string;
  lines: string[];
  events: any[];
  store: MemoryStore;
  demo: ReturnType<typeof createDemo>;
  close: () => Promise<void>;
}

/** Start the demo app (issuer + widget + site) on a random localhost port, capturing log lines. */
export async function startDemo(over: Record<string, any> = {}): Promise<Running> {
  const lines: string[] = [];
  const metrics = new Metrics((l) => lines.push(l));
  const store = new MemoryStore();
  const config = testConfig(over);
  const demo = createDemo({ config, metrics, store });
  const server: Server = await new Promise((ok) => {
    const s = demo.app.listen(0, "127.0.0.1", () => ok(s));
  });
  const port = (server.address() as AddressInfo).port;
  config.allowed_origins.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
  return {
    url: `http://localhost:${port}`,
    lines,
    get events() { return lines.map((l) => JSON.parse(l)); },
    store,
    demo,
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}
