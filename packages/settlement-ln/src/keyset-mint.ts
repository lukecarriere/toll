// Loopback mint with a real version-01 keyset. Tokens carry the short id (first 8 bytes).
// POST /v1/swap checks the blind signature and returns new ones. No funds leave the process.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { fromHex, randomBytes, toHex } from "../../protocol/src/bytes.ts";
import { CASHU_UNIT, encodeTokenV4, stripMint, type CashuProof } from "./cashu.ts";
import { deriveKeysetIdV2, proofMatches, pubkeyHex, secretY, shortKeysetId, signBlind, signSecret, splitAmount } from "./cashu-crypto.ts";

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
  /**
   * Fault the next responses for `path` (`/v1/swap`, `/v1/keysets`, `/v1/keys`, `/v1/restore`,
   * `/v1/checkstate`, `/v1/info`). `null` clears it. Modes: network, 500, empty, malformed,
   * bad-reply (swap spends, body has no C_), uppercase (swap spends, C_ is uppercase),
   * drop-after (swap spends, then the socket closes), pending, unspent, spent, unknown
   * (checkstate), zero (restore returns an empty signature list), plain-422 (swap answers
   * 422 text and does not spend). A signed reply set with
   * `setSignedReply` replaces the 200 after the mint signs.
   */
  setFault: (path: string | null, mode: string | null) => void;
  /**
   * After a swap is signed, answer with this status and body instead of the signatures.
   * `null` restores the normal signed reply. Cleared by `setFault(null, null)`.
   */
  setSignedReply: (reply: { status: number; body: string; type: string } | null) => void;
  /** Signature the mint kept for a blinded output, if the swap was accepted. */
  signatureFor: (B_: string) => string | undefined;
  /** Sum of output amounts this mint has signed. */
  signedSats: () => number;
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
  const signed = new Map<string, { id: string; amount: number; C_: string }>();
  let swaps = 0;
  let requests = 0;
  let down = false;
  let url = "";
  let lastIds: string[] = [];
  const faults = new Map<string, string>();
  let uppercaseSigs = false;
  let signedReply: { status: number; body: string; type: string } | null = null;

  function faultFor(path: string): string | null {
    if (faults.has(path)) return faults.get(path) ?? null;
    for (const [prefix, mode] of faults) {
      if (path.startsWith(prefix + "/")) return mode;
    }
    return null;
  }

  const server: Server = createServer(async (req, res) => {
    if (down) {
      req.socket.destroy();
      return;
    }
    requests++;
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const fault = faultFor(path);
    if (fault === "network") { req.socket.destroy(); return; }
    if (fault === "500") return json(res, 500, { detail: "down", code: 0 });
    if (fault === "empty") { res.writeHead(200); res.end(); return; }
    if (fault === "malformed") return json(res, 200, { wat: 1 });
    try {
      if (req.method === "GET" && path === "/v1/info") return json(res, 200, { name: "toll-keyset-mint", version: "test", nuts: { "4": { disabled: false } } });
      if (req.method === "GET" && path === "/v1/keysets") return json(res, 200, { keysets: [keysetRow(keysetId)] });
      if (req.method === "GET" && (path === "/v1/keys" || path === "/v1/keys/" + keysetId)) return json(res, 200, { keysets: [{ ...keysetRow(keysetId), keys: pubs }] });
      if (req.method === "POST" && path === "/v1/swap") {
        if (fault === "refuse") return json(res, 400, { detail: "refused", code: 11002 });
        if (fault === "plain-422") {
          await readJson(req);
          const raw = "Failed to deserialize";
          res.writeHead(422, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(raw) });
          res.end(raw);
          return;
        }
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
        for (let i = 0; i < outputs.length; i++) signed.set(String(outputs[i].B_), signatures[i]);
        if (signedReply) {
          const raw = signedReply.body;
          res.writeHead(signedReply.status, { "content-type": signedReply.type, "content-length": Buffer.byteLength(raw) });
          res.end(raw);
          return;
        }
        if (fault === "drop-after") { req.socket.destroy(); return; }
        if (fault === "sign-then-400") return json(res, 400, { detail: "refused", code: 11000 });
        if (fault === "http-500-json") return json(res, 500, { detail: "down", code: 11000 });
        if (fault === "http-500-text") { res.writeHead(500, { "content-type": "text/plain" }); res.end("down"); return; }
        if (fault === "http-502") return json(res, 502, { detail: "gateway", code: 11000 });
        if (fault === "http-503") return json(res, 503, { detail: "unavailable", code: 11000 });
        if (fault === "http-429") return json(res, 429, { detail: "slow", code: 11000 });
        if (fault === "http-400-text") { res.writeHead(400, { "content-type": "text/plain" }); res.end("nope"); return; }
        if (fault === "bad-reply") return json(res, 200, { signatures: signatures.map((s) => ({ amount: s.amount, id: s.id })) });
        if (fault === "uppercase") {
          uppercaseSigs = true;
          return json(res, 200, { signatures: signatures.map((s) => ({ ...s, C_: s.C_.toUpperCase() })) });
        }
        return json(res, 200, { signatures });
      }
      if (req.method === "POST" && path === "/v1/restore") {
        const body = await readJson(req);
        const outputs = Array.isArray(body?.outputs) ? body.outputs : [];
        const found: { output: { amount?: number; id?: string; B_?: string }; sig: { id: string; amount: number; C_: string } }[] = [];
        for (const output of outputs as { amount?: number; id?: string; B_?: string }[]) {
          const saved = typeof output?.B_ === "string" ? signed.get(output.B_) : undefined;
          if (!saved) continue;
          found.push({ output, sig: { id: saved.id, amount: saved.amount, C_: uppercaseSigs ? saved.C_.toUpperCase() : saved.C_ } });
        }
        if (fault === "nosig") return json(res, 200, { signatures: outputs.map((output: { amount?: number; id?: string }) => ({ id: output?.id ?? "", amount: output?.amount ?? 0, C_: null })) });
        if (fault === "partial") {
          const signatures = outputs.map((output: { amount?: number; id?: string; B_?: string }, i: number) => {
            const saved = typeof output?.B_ === "string" ? signed.get(output.B_) : undefined;
            const c = saved && i === 0 ? (uppercaseSigs ? saved.C_.toUpperCase() : saved.C_) : null;
            return saved && c ? { id: saved.id, amount: saved.amount, C_: c } : { id: output?.id ?? "", amount: output?.amount ?? 0, C_: null };
          });
          return json(res, 200, { signatures });
        }
        if (fault === "zero") return json(res, 200, { outputs: [], signatures: [] });
        return json(res, 200, { outputs: found.map((f) => f.output), signatures: found.map((f) => f.sig) });
      }
      if (req.method === "POST" && path === "/v1/checkstate") {
        const body = await readJson(req);
        const Ys = Array.isArray(body?.Ys) ? body.Ys : [];
        const known = new Map<string, string>();
        for (const secret of spent) known.set(secretY(secret), "SPENT");
        if (fault === "unknown") return json(res, 200, {});
        const forced = fault === "pending" ? "PENDING" : fault === "unspent" ? "UNSPENT" : fault === "spent" ? "SPENT" : null;
        const states = Ys.map((Y: unknown) => ({ Y, state: forced ?? known.get(String(Y)) ?? "UNSPENT" }));
        return json(res, 200, { states });
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
    setFault: (path, mode) => {
      if (path === null) { faults.clear(); signedReply = null; return; }
      if (mode === null) { faults.delete(path); return; }
      faults.set(path, mode);
    },
    setSignedReply: (reply) => { signedReply = reply; },
    signatureFor: (B_) => signed.get(B_)?.C_,
    signedSats: () => [...signed.values()].reduce((n, s) => n + s.amount, 0),
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
