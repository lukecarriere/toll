// BOLT 11 reader for a mint-quote invoice. The checksum is checked and the payment hash is
// taken from tag `p`. The amount is the human-readable amount, in msat. The signature is not
// recovered: the mint that returned the invoice is on the allowlist, and the payer proves the
// hash with the preimage. Unknown tags are skipped so a longer invoice still yields the hash.
import { TollError } from "../../protocol/src/errors.ts";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
/** Signature is 65 bytes, 104 groups of 5 bits, and sits after the tagged fields. */
const SIG_GROUPS = 104;
const MAX_INVOICE = 4096;

export interface Bolt11 {
  network: "bc" | "tb" | "tbs" | "bcrt";
  /** Null when the invoice names no amount. */
  amountMsat: number | null;
  paymentHash: string;
}

export function decodeBolt11(invoice: string): Bolt11 {
  if (typeof invoice !== "string" || invoice.length < 10 || invoice.length > MAX_INVOICE || invoice !== invoice.toLowerCase()) throw new TollError("malformed");
  const sep = invoice.lastIndexOf("1");
  if (sep < 4 || sep + 7 > invoice.length) throw new TollError("malformed");
  const hrp = invoice.slice(0, sep);
  const network = networkOf(hrp);
  const amountMsat = amountOf(hrp.slice(2 + network.length));
  const data = wordsOf(invoice.slice(sep + 1));
  if (!checksumOk(hrp, data)) throw new TollError("malformed");
  const words = data.slice(0, -6);
  if (words.length < 7 + SIG_GROUPS) throw new TollError("malformed");
  const tags = words.slice(7, words.length - SIG_GROUPS);
  const paymentHash = hashFrom(tags);
  return { network, amountMsat, paymentHash };
}

/** A checksum-valid invoice for tests and the local quote mint. The signature bytes are zeros. */
export function encodeBolt11(o: { network?: Bolt11["network"]; amountMsat: number; paymentHash: string; timestamp?: number }): string {
  if (!Number.isSafeInteger(o.amountMsat) || o.amountMsat <= 0 || o.amountMsat % 1000 !== 0) throw new TollError("malformed");
  if (!/^[0-9a-f]{64}$/.test(o.paymentHash)) throw new TollError("malformed");
  const network = o.network ?? "bc";
  const hrp = "ln" + network + hrpAmount(o.amountMsat);
  const words: number[] = [];
  pushBits(words, o.timestamp ?? 1496314658, 35);
  pushTag(words, 1, convert(hexBytes(o.paymentHash), 8, 5, true));
  words.push(...convert(new Uint8Array(65), 8, 5, true));
  if (words.length < 7 + SIG_GROUPS) throw new TollError("malformed");
  const checksum = createChecksum(hrp, words);
  return hrp + "1" + [...words, ...checksum].map((w) => CHARSET[w]).join("");
}

function networkOf(hrp: string): Bolt11["network"] {
  if (!hrp.startsWith("ln")) throw new TollError("malformed");
  const rest = hrp.slice(2);
  const nets = ["bcrt", "tbs", "tb", "bc"] as const;
  for (const n of nets) if (rest.startsWith(n)) return n;
  throw new TollError("malformed");
}

/** The amount characters after the network prefix. Empty means no amount. */
function amountOf(raw: string): number | null {
  if (raw === "") return null;
  const m = /^(\d+)([munp])?$/.exec(raw);
  if (!m) throw new TollError("malformed");
  const n = BigInt(m[1]);
  const scale: Record<string, bigint> = { m: 100_000_000n, u: 100_000n, n: 100n };
  let msat: bigint;
  if (!m[2]) msat = n * 100_000_000_000n;
  else if (m[2] === "p") {
    if (n % 10n !== 0n) throw new TollError("malformed");
    msat = n / 10n;
  } else msat = n * scale[m[2]];
  if (msat <= 0n || msat > BigInt(Number.MAX_SAFE_INTEGER)) throw new TollError("malformed");
  return Number(msat);
}

/** Shortest whole-sat amount. 1 sat is 10 nano-bitcoin. */
function hrpAmount(amountMsat: number): string {
  const sats = amountMsat / 1000;
  if (sats % 100_000 === 0) return String(sats / 100_000) + "m";
  if (sats % 100 === 0) return String(sats / 100) + "u";
  return String(sats * 10) + "n";
}

function wordsOf(data: string): number[] {
  const out: number[] = [];
  for (const c of data) {
    const v = CHARSET.indexOf(c);
    if (v < 0) throw new TollError("malformed");
    out.push(v);
  }
  return out;
}

function hashFrom(tags: number[]): string {
  let hash = "";
  let i = 0;
  while (i < tags.length) {
    if (i + 3 > tags.length) throw new TollError("malformed");
    const type = tags[i];
    const len = tags[i + 1] * 32 + tags[i + 2];
    i += 3;
    if (len < 0 || i + len > tags.length) throw new TollError("malformed");
    const field = tags.slice(i, i + len);
    i += len;
    if (type !== 1) continue;
    if (hash !== "") throw new TollError("malformed");
    const bytes = convert(field, 5, 8, false);
    if (bytes.length !== 32) throw new TollError("malformed");
    hash = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (i !== tags.length || hash === "") throw new TollError("malformed");
  return hash;
}

function pushBits(out: number[], value: number, bits: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || bits % 5 !== 0) throw new TollError("malformed");
  for (let shift = bits - 5; shift >= 0; shift -= 5) out.push((value >>> shift) & 31);
}

function pushTag(out: number[], type: number, data: number[]): void {
  if (data.length >= 1024) throw new TollError("malformed");
  out.push(type & 31, (data.length >> 5) & 31, data.length & 31, ...data);
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function convert(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (value < 0 || value >> from) throw new TollError("malformed");
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    throw new TollError("malformed");
  }
  return out;
}

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GENERATORS[i];
  }
  return chk >>> 0;
}

function expand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function checksumOk(hrp: string, data: number[]): boolean {
  return polymod(expand(hrp).concat(data)) === 1;
}

function createChecksum(hrp: string, data: number[]): number[] {
  const mod = polymod(expand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
  const out: number[] = [];
  for (let i = 0; i < 6; i++) out.push((mod >>> (5 * (5 - i))) & 31);
  return out;
}
