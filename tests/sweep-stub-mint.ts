// A local stub mint that answers the mint-quote sweep the worst way and counts every request that
// reaches it. Keys come from a local keyset mint behind it. Test use only; nothing is paid.
import { createServer } from "node:http";
import { startKeysetMint } from "../packages/settlement-ln/src/index.ts";

export type StubAnswer = "unknown" | "refused";

export async function startSweepStubMint(port = 0) {
  const keyset = await startKeysetMint({ quotes: true });
  const origin = new URL(keyset.url).origin;
  const calls: string[] = [];
  let answer: StubAnswer = "unknown";
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://stub");
    const i = u.pathname.indexOf("/v1/");
    const p = i >= 0 ? u.pathname.slice(i) : u.pathname;
    calls.push((req.method ?? "GET") + " " + p);
    for await (const _ of req) { /* drain */ }
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (p.startsWith("/v1/keys")) {
      const r = await fetch(origin + p);
      return send(r.status, await r.json());
    }
    if (p.startsWith("/v1/mint/quote/bolt11/")) return send(200, { quote: decodeURIComponent(p.split("/").pop() ?? ""), state: "PAID", amount: 10, unit: "sat", request: "lnbc1", expiry: null });
    if (p === "/v1/restore") return send(200, { outputs: [], signatures: [] });
    return send(500, answer === "refused" ? { detail: "quote refused", code: 20001 } : {});
  });
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  const addr = server.address();
  const url = "http://127.0.0.1:" + (typeof addr === "object" && addr ? addr.port : port);
  return {
    url,
    calls,
    set: (a: StubAnswer) => { answer = a; },
    close: async () => {
      await new Promise<void>((ok) => server.close(() => ok()));
      await keyset.close();
    },
  };
}
