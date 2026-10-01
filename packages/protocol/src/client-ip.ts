// The client address behind trusted reverse proxies (TOLL_TRUSTED_PROXIES), shared by the Node issuer
// and the edge Worker. Same rules as the WordPress plugin's toll_gate_client_ip() and
// toll_gate_parse_proxies() (packages/wp-toll-gate/includes/network.php); docs/net-vectors.json pins
// both sides to the same output (ip_bytes and client_ip vectors, run natively in JS and in PHP).
//
//   - No trusted proxies, or the socket address (remoteAddr) is not one of them: remoteAddr, and
//     X-Forwarded-For is never read.
//   - remoteAddr is a listed proxy: X-Forwarded-For is read right to left, skipping only listed
//     proxies; the first entry that is not a listed proxy is the client. If that entry is not a plain
//     IPv4 or IPv6 address ("unknown", empty, a port, brackets, a zone id, junk), or there is no such
//     entry (header missing, empty, only commas or spaces, only listed proxies, or longer than 4096
//     bytes), the result is null: there is no client address. Never remoteAddr, never an entry further left.
//   - "::ffff:a.b.c.d" counts as a.b.c.d everywhere (remoteAddr, every entry, the proxy list).
// What null means is up to the caller (Node: no network for load pricing, and the rate limit keys on
// the socket address; docs/adapters.md).

/** One trusted range: packed address (4 or 16 bytes) and prefix length in bits. */
export interface ProxyRange { bytes: Uint8Array; bits: number }

export const TRUSTED_PROXIES_ENV = "TOLL_TRUSTED_PROXIES";
/** X-Forwarded-For longer than this (bytes) from a listed proxy gives no client address. */
export const MAX_XFF_BYTES = 4096;

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const V4_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
const MAPPED_RE = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/** PHP trim()'s default characters: space, tab, LF, CR, NUL, vertical tab. */
const phpTrim = (s: string) => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");

function v4Bytes(s: string): Uint8Array | null {
  if (!V4_RE.test(s)) return null;
  return Uint8Array.from(s.split(".").map(Number));
}

function v6Bytes(s: string): Uint8Array | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(s) || !s.includes(":")) return null;
  let tail4: Uint8Array | null = null;
  let text = s;
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".")) {
    tail4 = v4Bytes(s.slice(lastColon + 1));
    if (!tail4) return null;
    text = s.slice(0, lastColon + 1) + "0:0"; // two placeholder groups for the dotted quad
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (![...head, ...tail].every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return null;
  const n = head.length + tail.length;
  if (halves.length === 2 ? n > 7 : n !== 8) return null;
  const all = [...head, ...Array(8 - n).fill("0"), ...tail];
  const out = new Uint8Array(16);
  all.forEach((g, i) => { const v = parseInt(g, 16); out[2 * i] = v >> 8; out[2 * i + 1] = v & 0xff; });
  if (tail4) out.set(tail4, 12);
  return out;
}

/**
 * Packed address (4 or 16 bytes) for a plain IPv4 or IPv6 address after trimming; "::ffff:a.b.c.d"
 * counts as IPv4. null otherwise (ports, brackets, zone ids, leading zeros in IPv4, junk). Same as
 * PHP toll_gate_ip_bin() (filter_var FILTER_VALIDATE_IP + inet_pton).
 */
export function ipBytes(ip: unknown): Uint8Array | null {
  if (typeof ip !== "string") return null;
  let s = phpTrim(ip);
  const m = MAPPED_RE.exec(s);
  if (m) s = m[1];
  return v4Bytes(s) ?? v6Bytes(s);
}

/**
 * Parse a comma-separated list of addresses and CIDR ranges (IPv4 and IPv6). Bad entries are dropped
 * and counted in `invalid` (so a caller can log that some were ignored without logging them).
 */
export function parseTrustedProxies(raw: unknown): { ranges: ProxyRange[]; invalid: number } {
  const ranges: ProxyRange[] = [];
  let invalid = 0;
  if (typeof raw !== "string") return { ranges, invalid };
  for (const e0 of raw.split(",")) {
    const e = phpTrim(e0);
    if (e === "") continue;
    const slash = e.indexOf("/");
    const bytes = ipBytes(slash < 0 ? e : e.slice(0, slash));
    if (!bytes) { invalid++; continue; }
    const max = bytes.length * 8;
    let bits = max;
    if (slash >= 0) {
      const p = e.slice(slash + 1);
      if (!/^\d{1,3}$/.test(p) || Number(p) > max) { invalid++; continue; }
      bits = Number(p);
    }
    ranges.push({ bytes, bits });
  }
  return { ranges, invalid };
}

/** Whether an address falls in one of the ranges (IPv4 ranges never match IPv6 addresses and back). */
export function ipInRanges(ip: unknown, ranges: readonly ProxyRange[]): boolean {
  const b = ipBytes(ip);
  if (!b) return false;
  for (const { bytes, bits } of ranges) {
    if (bytes.length !== b.length) continue;
    const whole = bits >> 3;
    let ok = true;
    for (let i = 0; i < whole && ok; i++) ok = bytes[i] === b[i];
    if (!ok) continue;
    const rest = bits & 7;
    if (rest === 0) return true;
    const mask = (0xff << (8 - rest)) & 0xff;
    if ((bytes[whole] & mask) === (b[whole] & mask)) return true;
  }
  return false;
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/**
 * The client address for a request (rules in the header of this file). `xff` null or undefined means
 * no X-Forwarded-For header ("" is an empty one); `trusted` is a parsed list or the raw
 * comma-separated value. Returns remoteAddr (trimmed; "" when missing) when it is not a listed proxy.
 */
export function clientIp(o: { remoteAddr?: string | null; xff?: string | null; trusted: readonly ProxyRange[] | string }): string | null {
  const ranges = typeof o.trusted === "string" ? parseTrustedProxies(o.trusted).ranges : o.trusted;
  const remote = typeof o.remoteAddr === "string" ? phpTrim(o.remoteAddr) : "";
  if (ranges.length === 0 || !ipInRanges(remote, ranges)) return remote;
  const xff = o.xff;
  if (typeof xff !== "string" || utf8Length(xff) > MAX_XFF_BYTES) return null;
  const hops = xff.split(",");
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = phpTrim(hops[i]);
    if (ipInRanges(hop, ranges)) continue;
    return ipBytes(hop) ? hop : null;
  }
  return null;
}

const warnedProxies = new Set<string>();

/**
 * The trusted proxies from a raw TOLL_TRUSTED_PROXIES value ([] when unset or empty). Entries that
 * are not an address or CIDR range are ignored and reported once per process per distinct value
 * through `warn`, with their count only (never the value).
 */
export function trustedProxies(raw: string | null | undefined, warn: (msg: string) => void = (m) => console.warn(m)): ProxyRange[] {
  const { ranges, invalid } = parseTrustedProxies(raw ?? "");
  if (invalid > 0 && !warnedProxies.has(String(raw))) {
    warnedProxies.add(String(raw));
    warn(`[toll] ${TRUSTED_PROXIES_ENV}: ${invalid} ${invalid === 1 ? "entry is" : "entries are"} not an IPv4/IPv6 address or CIDR range and ${invalid === 1 ? "is" : "are"} ignored`);
  }
  return ranges;
}
