// Minimal CBOR (RFC 8949) for Cashu payment requests and V4 tokens.
// Safe integers, byte strings, text, arrays, maps with text keys, and booleans.
// Tags are skipped on decode. Floats and indefinite lengths are rejected.
import { concat, fromUtf8, utf8 } from "../../protocol/src/bytes.ts";

export type Cbor = null | boolean | number | string | Uint8Array | Cbor[] | { [k: string]: Cbor };

export function cborEncode(value: Cbor): Uint8Array {
  const parts: Uint8Array[] = [];
  write(value, parts);
  return concat(...parts);
}

function write(value: Cbor, out: Uint8Array[]): void {
  if (value === null) return void out.push(Uint8Array.of(0xf6));
  if (typeof value === "boolean") return void out.push(Uint8Array.of(value ? 0xf5 : 0xf4));
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("cbor: unsupported number");
    out.push(head(0, value));
    return;
  }
  if (typeof value === "string") {
    const b = utf8(value);
    out.push(head(3, b.length));
    out.push(b);
    return;
  }
  if (value instanceof Uint8Array) {
    out.push(head(2, value.length));
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    out.push(head(4, value.length));
    for (const v of value) write(v, out);
    return;
  }
  const keys = Object.keys(value).sort();
  out.push(head(5, keys.length));
  for (const k of keys) {
    write(k, out);
    write(value[k], out);
  }
}

function head(major: number, n: number): Uint8Array {
  const m = major << 5;
  if (n < 24) return Uint8Array.of(m | n);
  if (n < 256) return Uint8Array.of(m | 24, n);
  if (n < 65536) return Uint8Array.of(m | 25, n >> 8, n & 0xff);
  if (n < 2 ** 32) {
    const b = new Uint8Array(5);
    b[0] = m | 26;
    new DataView(b.buffer).setUint32(1, n);
    return b;
  }
  const b = new Uint8Array(9);
  b[0] = m | 27;
  const view = new DataView(b.buffer);
  view.setUint32(1, Math.floor(n / 2 ** 32));
  view.setUint32(5, n >>> 0);
  return b;
}

export function cborDecode(bytes: Uint8Array): Cbor {
  const [v, off] = read(bytes, 0);
  if (off !== bytes.length) throw new Error("cbor: trailing bytes");
  return v;
}

function read(b: Uint8Array, o: number): [Cbor, number] {
  if (o >= b.length) throw new Error("cbor: truncated");
  const ib = b[o++];
  const major = ib >> 5;
  const ai = ib & 31;
  if (major === 7) {
    if (ai === 20) return [false, o];
    if (ai === 21) return [true, o];
    if (ai === 22) return [null, o];
    throw new Error("cbor: unsupported simple");
  }
  if (major === 6) {
    const [, o2] = readLen(b, o, ai);
    return read(b, o2);
  }
  const [len, o2] = readLen(b, o, ai);
  if (major === 0) return [len, o2];
  if (major === 1) return [-1 - len, o2];
  if (major === 2 || major === 3) {
    if (o2 + len > b.length) throw new Error("cbor: truncated");
    const slice = b.subarray(o2, o2 + len);
    return [major === 2 ? new Uint8Array(slice) : fromUtf8(slice), o2 + len];
  }
  if (major === 4) {
    const arr: Cbor[] = [];
    let p = o2;
    for (let i = 0; i < len; i++) {
      const [v, np] = read(b, p);
      arr.push(v);
      p = np;
    }
    return [arr, p];
  }
  if (major === 5) {
    const obj: { [k: string]: Cbor } = {};
    let p = o2;
    for (let i = 0; i < len; i++) {
      const [k, p1] = read(b, p);
      if (typeof k !== "string") throw new Error("cbor: map key is not text");
      const [v, p2] = read(b, p1);
      obj[k] = v;
      p = p2;
    }
    return [obj, p];
  }
  throw new Error("cbor: unsupported type");
}

function readLen(b: Uint8Array, o: number, ai: number): [number, number] {
  if (ai < 24) return [ai, o];
  const width = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : ai === 27 ? 8 : 0;
  if (!width || o + width > b.length) throw new Error("cbor: truncated");
  let n = 0;
  for (let i = 0; i < width; i++) n = n * 256 + b[o + i];
  if (!Number.isSafeInteger(n)) throw new Error("cbor: integer too big");
  return [n, o + width];
}
