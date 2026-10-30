// Local fake mint for tests and the agent payer. No keys, no blind signatures, no funds.
// It records proofs it issued and spends them on POST /v1/swap. That call is what verification
// requires: a token this process never issued, or one it already spent, is refused here.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fromHex, randomBytes, toHex } from "../../protocol/src/bytes.ts";
import { sha256 } from "../../protocol/src/hmac.ts";
import { CASHU_UNIT, encodeTokenV4, stripMint, type CashuProof } from "./cashu.ts";
import { invoiceFor } from "./mint-quote.ts";

interface Row { amount: number; id: string; C: string; spent: boolean }

interface QuoteRow {
  id: string;
  amount: number;
  preimage: string;
  request: string;
  state: "UNPAID" | "PAID" | "ISSUED";
  proofs: { amount: number; secret: string; id: string; C: string }[] | null;
}

export interface TestMint {
  url: string;
  /** How many POST /v1/swap calls were attempted, including refusals. */
  swaps: () => number;
  /** Sats minted into the caller's store after a paid quote. A replay does not add more. */
  issuedSats: () => number;
  /** Drop connections so callers see an outage, not an error body. */
  setDown: (down: boolean) => void;
  close: () => Promise<void>;
}

export async function startTestMint(): Promise<TestMint> {
  const rows = new Map<string, Row>();
  const quotes = new Map<string, QuoteRow>();
  let swaps = 0;
  let issuedSats = 0;
  let down = false;
  let url = "";

  const server: Server = createServer(async (req, res) => {
    if (down) {
      req.socket.destroy();
      return;
    }
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    try {
      if (req.method === "GET" && path === "/v1/info") return json(res, 200, { name: "toll-test-mint", version: "test" });
      if (req.method === "POST" && path === "/v1/mint/quote/bolt11") {
        const body = await readJson(req);
        const amount = body?.amount;
        if (body?.unit !== CASHU_UNIT || !Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000) return json(res, 400, { detail: "bad amount", code: 11000 });
        const preimage = toHex(randomBytes(32));
        const id = toHex(randomBytes(16));
        const request = invoiceFor(amount, toHex(await sha256(fromHex(preimage))));
        quotes.set(id, { id, amount, preimage, request, state: "UNPAID", proofs: null });
        return json(res, 200, { quote: id, request, state: "UNPAID", expiry: Math.floor(Date.now() / 1000) + 600 });
      }
      const quoted = /^\/v1\/mint\/quote\/bolt11\/([0-9a-f]+)$/.exec(path);
      if (req.method === "GET" && quoted) {
        const q = quotes.get(quoted[1]);
        if (!q) return json(res, 404, { detail: "unknown", code: 404 });
        return json(res, 200, { quote: q.id, request: q.request, state: q.state, expiry: Math.floor(Date.now() / 1000) + 600 });
      }
      if (req.method === "POST" && path === "/test/pay") {
        const body = await readJson(req);
        const q = [...quotes.values()].find((row) => row.request === body?.request);
        if (!q) return json(res, 400, { detail: "unknown", code: 11000 });
        if (q.state === "UNPAID") q.state = "PAID";
        return json(res, 200, { preimage: q.preimage });
      }
      if (req.method === "POST" && path === "/v1/mint/bolt11") {
        const body = await readJson(req);
        const q = quotes.get(typeof body?.quote === "string" ? body.quote : "");
        if (!q || q.state === "UNPAID") return json(res, 400, { detail: "unpaid", code: 11000 });
        if (!q.proofs) {
          const proof = issue(q.amount, rows);
          q.proofs = [{ amount: proof.amount, secret: proof.secret, id: toHex(proof.id), C: toHex(proof.C) }];
          q.state = "ISSUED";
          issuedSats += q.amount;
        }
        return json(res, 200, { proofs: q.proofs });
      }
      if (req.method === "POST" && path === "/test/mint") {
        const body = await readJson(req);
        const amount = body?.amount;
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000) return json(res, 400, { detail: "bad amount", code: 11000 });
        const proof = issue(amount, rows);
        return json(res, 200, { token: encodeTokenV4({ mint: url, unit: CASHU_UNIT, proofs: [proof] }) });
      }
      if (req.method === "POST" && path === "/v1/swap") {
        swaps++;
        const body = await readJson(req);
        const inputs = Array.isArray(body?.inputs) ? body.inputs : null;
        if (!inputs || inputs.length === 0 || inputs.length > 32) return json(res, 400, { detail: "unknown proof", code: 11002 });
        let bad = false;
        let spent = false;
        for (const input of inputs) {
          const secret = typeof input?.secret === "string" ? input.secret : "";
          const row = rows.get(secret);
          const amount = input?.amount;
          const id = typeof input?.id === "string" ? input.id.toLowerCase() : "";
          const C = typeof input?.C === "string" ? input.C.toLowerCase() : "";
          if (!row || row.amount !== amount || row.id !== id || row.C !== C) bad = true;
          else if (row.spent) spent = true;
        }
        if (bad) return json(res, 400, { detail: "unknown proof", code: 11002 });
        if (spent) return json(res, 400, { detail: "already spent", code: 11001 });
        for (const input of inputs) {
          const row = rows.get(input.secret);
          if (row) row.spent = true;
        }
        return json(res, 200, { signatures: [] });
      }
      return json(res, 404, { detail: "unknown", code: 404 });
    } catch {
      if (!res.headersSent) json(res, 400, { detail: "bad request", code: 11000 });
    }
  });

  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  url = stripMint("http://127.0.0.1:" + (server.address() as AddressInfo).port);
  return {
    url,
    swaps: () => swaps,
    issuedSats: () => issuedSats,
    setDown: (v: boolean) => { down = v; },
    close: () => new Promise<void>((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}

function issue(amount: number, rows: Map<string, Row>): CashuProof {
  const secret = toHex(randomBytes(32));
  const id = randomBytes(8);
  const C = randomBytes(33);
  C[0] = 0x02;
  rows.set(secret, { amount, id: toHex(id), C: toHex(C), spent: false });
  return { amount, secret, id, C };
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(raw) });
  res.end(raw);
}

async function readJson(req: import("node:http").IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 65536) throw new Error("too big");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
