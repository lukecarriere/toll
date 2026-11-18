// Pay-address host checks. A host from a pay address or its callback URL is parsed, not
// pattern-matched: an IP literal becomes bytes, an IPv6 form that carries an IPv4 address is
// unwrapped, and the IPv4 address is checked too. Names are normalised before the reserved-name
// list. Plain TypeScript with no imports, so it runs the same in Node and in a Worker.

/** Dotted-quad IPv4 (the form URL parsing produces) to four bytes, or null. */
export function parseIPv4(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i];
    if (!/^[0-9]{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

/** IPv6 literal (brackets optional; `::`, an IPv4 tail and hex groups) to sixteen bytes, or null. */
export function parseIPv6(input: string): Uint8Array | null {
  let s = input;
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s === "" || s.includes("%") || !/^[0-9a-f:.]+$/i.test(s)) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const words: number[] = [];
    const items = part.split(":");
    for (let i = 0; i < items.length; i++) {
      const g = items[i];
      if (g.includes(".")) {
        if (i !== items.length - 1) return null;
        const v4 = parseIPv4(g);
        if (!v4) return null;
        words.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
        words.push(parseInt(g, 16));
      }
    }
    return words;
  };
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !tail) return null;
  // A dotted tail is only valid at the very end of the address.
  if (halves.length === 2 && halves[0].includes(".")) return null;
  let words: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    words = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    words = head;
  }
  const out = new Uint8Array(16);
  words.forEach((w, i) => { out[2 * i] = w >> 8; out[2 * i + 1] = w & 0xff; });
  return out;
}

function inV4(b: Uint8Array, net: [number, number, number, number], bits: number): boolean {
  for (let i = 0; i < 4; i++) {
    const take = Math.max(0, Math.min(8, bits - 8 * i));
    if (take === 0) return true;
    const mask = (0xff << (8 - take)) & 0xff;
    if ((b[i] & mask) !== (net[i] & mask)) return false;
  }
  return true;
}

// Not reachable as a public pay host: this network, private, shared (carrier NAT), loopback,
// link-local, protocol assignments, documentation, benchmarking, multicast, reserved, broadcast.
const V4_REFUSED: Array<[[number, number, number, number], number]> = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

/** True when a four-byte IPv4 address is not a public unicast address. */
export function refusedIPv4(b: Uint8Array): boolean {
  return V4_REFUSED.some(([net, bits]) => inV4(b, net, bits));
}

function zero(b: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (b[i] !== 0) return false;
  return true;
}

/**
 * The IPv4 address carried inside an IPv6 address, or null: IPv4-mapped (::ffff:0:0/96),
 * IPv4-translated (::ffff:0:0:0/96), IPv4-compatible (::/96), NAT64 (64:ff9b::/96) and 6to4 (2002::/16).
 */
export function embeddedIPv4(b: Uint8Array): Uint8Array | null {
  if (zero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return b.slice(12, 16);
  if (zero(b, 0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return b.slice(12, 16);
  if (zero(b, 0, 12)) return b.slice(12, 16);
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(b, 4, 12)) return b.slice(12, 16);
  if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6);
  return null;
}

/** True when a sixteen-byte IPv6 address is not a public unicast address, embedded IPv4 included. */
export function refusedIPv6(b: Uint8Array): boolean {
  if (zero(b, 0, 16)) return true; // ::
  if (zero(b, 0, 15) && b[15] === 1) return true; // ::1
  const v4 = embeddedIPv4(b);
  if (v4 && refusedIPv4(v4)) return true;
  if (v4) return false;
  if (b[0] === 0x00) return true; // rest of ::/8 is reserved, 64:ff9b:1::/48 and the rest of 64:ff9b::/32 too
  if (b[0] === 0x01 && b[1] === 0x00 && zero(b, 2, 8)) return true; // 100::/64 discard-only
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 old site-local
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // 2001::/32 Teredo, carries a hidden IPv4
  return false;
}

/** Lowercase, collapse repeated dots, drop leading and trailing dots, strip IPv6 brackets. */
export function normalizeHost(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) return h.slice(1, -1);
  h = h.replace(/\.{2,}/g, ".").replace(/^\.+|\.+$/g, "");
  return h;
}

const RESERVED_NAMES = ["localhost", "localhost.localdomain", "local", "internal"];
const RESERVED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain"];

/**
 * True when `hostname` (a URL hostname or a pay-address domain) may be contacted: a public
 * IP literal, or a dotted name that is not a reserved local name.
 */
export function publicPayHost(hostname: string): boolean {
  const h = normalizeHost(hostname);
  if (!h) return false;
  if (h.includes(":")) {
    const b = parseIPv6(h);
    return b !== null && !refusedIPv6(b);
  }
  const v4 = parseIPv4(h);
  if (v4) return !refusedIPv4(v4);
  // Anything numeric-looking that is not a plain dotted quad (127.1, 0x7f.1, 2130706433) is refused.
  const last = h.slice(h.lastIndexOf(".") + 1);
  if (/^[0-9.]+$/.test(h) || /^(0x[0-9a-f]*|[0-9]+)$/.test(last)) return false;
  if (!/^[a-z0-9_.-]+$/.test(h)) return false;
  if (RESERVED_NAMES.includes(h) || RESERVED_SUFFIXES.some((s) => h.endsWith(s))) return false;
  return h.includes(".");
}
