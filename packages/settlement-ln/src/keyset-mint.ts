// Loopback mint with a real version-01 keyset. Tokens carry the short id (first 8 bytes).
// POST /v1/swap checks the blind signature and returns new ones. No funds leave the process.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { fromHex, randomBytes, toHex } from "../../protocol/src/bytes.ts";
import { CASHU_UNIT, encodeTokenV4, stripMint, type CashuProof } from "./cashu.ts";
import { deriveKeysetIdV2, proofMatches, pubkeyHex, shortKeysetId, signBlind, signSecret, splitAmount } from "./cashu-crypto.ts";

const DENOMS = [1, 2, 4, 8, 16, 32, 64];

export interface KeysetMint {
  url: string;
  /** Full version-01 keyset id (66 hex chars). */
  keysetId: string;
  swaps: () => number;
  /** Full keyset ids presented on the last swap, so a test can see that short ids were expanded. */
  lastInputIds: () => string[];
  /** How many requests this process accepted, including refusals. */
  requests: () => number;
  /** Drop the spent set so a second swap of the same proofs would succeed without a local record. */
  forgetSpent: () => void;
  setDown: (down: boolean) => void;
  /** Issue a cashuB token for `amount` sats. The keyset id in the token is the short form. */
  token: (amount: number) => string;
  close: () => Promise<void>;
}

export async function startKeysetMint(): Promise<KeysetMint> {
  const secrets = new Map<number, Uint8Array>();
  const pubs: Record<string, string> = {};
  for (const amount of DENOMS) {
    const sk = secp256k1.utils.randomSecretKey();
    secrets.set(amount, sk);
    pubs[String(amount)] = pubkeyHex(sk);
  }
  const keysetId = deriveKeysetIdV2(pubs, CASHU_UNIT, 0, null);
  const short = shortKeysetId(keysetId);
  const spent = new Set<string>();
  let swaps = 0;
  let requests = 0;
  let down = false;
  let url = "";
  let lastIds: string[] = [];

  const server: Server = createServer(async (req, res) => {
    if (down) {
      req.socket.destroy();
      return;
    }
    requests++;
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    try {
      if (req.method === "GET" && path === "/v1/info") return json(res, 200, { name: "toll-keyset-mint", version: "test", nuts: { "4": { disabled: false } } });
      if (req.method === "GET" && path === "/v1/keysets") return json(res, 200, { keysets: [keysetRow(keysetId)] });
      if (req.method === "GET" && (path === "/v1/keys" || path === "/v1/keys/" + keysetId)) return json(res, 200, { keysets: [{ ...keysetRow(keysetId), keys: pubs }] });
      if (req.method === "POST" && path === "/v1/swap") {
        swaps++;
        const body = await readJson(req);
        const inputs = Array.isArray(body?.inputs) ? body.inputs : null;
        const outputs = Array.isArray(body?.outputs) ? body.outputs : null;
        if (!inputs || !outputs || inputs.length === 0 || inputs.length > 32 || outputs.length === 0 || outputs.length > 64) return json(res, 400, { detail: "bad request", code: 11000 });
        let inSum = 0;
        let bad = false;
        let already = false;
        const ids: string[] = [];
        for (const input of inputs) {
          const amount = input?.amount;
          const id = typeof input?.id === "string" ? input.id.toLowerCase() : "";
          const secret = typeof input?.secret === "string" ? input.secret : "";
          const C = typeof input?.C === "string" ? input.C.toLowerCase() : "";
          ids.push(id);
          const sk = secrets.get(amount);
          if (!sk || id !== keysetId || !secret || !proofMatches(sk, secret, C)) bad = true;
          else if (spent.has(secret)) already = true;
          else inSum += amount;
        }
        lastIds = ids;
        if (bad) return json(res, 400, { detail: "unknown proof", code: 11002 });
        if (already) return json(res, 400, { detail: "already spent", code: 11001 });
        let outSum = 0;
        const signatures: { id: string; amount: number; C_: string }[] = [];
        for (const output of outputs) {
          const amount = output?.amount;
          const id = typeof output?.id === "string" ? output.id.toLowerCase() : "";
          const B_ = typeof output?.B_ === "string" ? output.B_ : "";
          const sk = secrets.get(amount);
          if (!sk || id !== keysetId || !B_) return json(res, 400, { detail: "bad output", code: 11000 });
          outSum += amount;
          signatures.push({ id: keysetId, amount, C_: signBlind(sk, B_) });
        }
        if (inSum !== outSum) return json(res, 400, { detail: "amount", code: 11000 });
        for (const input of inputs) spent.add(input.secret);
        return json(res, 200, { signatures });
      }
      return json(res, 404, { detail: "unknown", code: 404 });
    } catch {
      if (!res.headersSent) json(res, 400, { detail: "bad request", code: 11000 });
    }
  });

  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  url = stripMint("http://127.0.0.1:" + (server.address() as AddressInfo).port);

  function issue(amount: number): string {
    const parts = splitAmount(amount, DENOMS);
    if (!parts) throw new Error("amount");
    const proofs: CashuProof[] = parts.map((a) => {
      const secret = toHex(randomBytes(32));
      const sk = secrets.get(a)!;
      const C = fromHex(signSecret(sk, secret));
      return { amount: a, secret, id: short, C };
    });
    return encodeTokenV4({ mint: url, unit: CASHU_UNIT, proofs });
  }

  return {
    url,
    keysetId,
    swaps: () => swaps,
    lastInputIds: () => lastIds.slice(),
    requests: () => requests,
    forgetSpent: () => { spent.clear(); },
    setDown: (v) => { down = v; },
    token: issue,
    close: () => new Promise<void>((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}

function keysetRow(id: string) {
  return { id, unit: CASHU_UNIT, active: true, input_fee_ppk: 0, final_expiry: null };
}

function json(res: ServerResponse, status: number, body: unknown) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(raw) });
  res.end(raw);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error("too big");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
