// Mint URL checks and HTTP. Production mints are https and public. The test receive path may
// pass loopbackHttp so a loopback mint can exercise the same code. Redirects are never followed.
import { isIP } from "node:net";
import { TollError } from "../../protocol/src/errors.ts";

const TIMEOUT_MS = 1500;
const MAX_BODY = 1_000_000;

export interface MintGuard {
  /** Allow http only for a loopback host that is on the allowlist. Config never sets this. */
  loopbackHttp?: boolean;
  /** Test double. Default resolves DNS. */
  lookup?: (host: string) => Promise<string[]>;
  fetch?: typeof fetch;
}

function bareHost(hostname: string): string {
  const h = hostname.toLowerCase();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

export function mintKey(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("mint url"); }
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
  const port = u.port === "" || (u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80") ? "" : ":" + u.port;
  const host = bareHost(u.hostname);
  const h = host.includes(":") ? `[${host}]` : host;
  return `${u.protocol}//${h}${port}${path}`;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

/** True for addresses a mint fetch must not contact (loopback, private, link-local, metadata). */
export function blockedAddress(ip: string): boolean {
  const raw = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw);
  const v4 = mapped ? mapped[1] : raw;
  if (v4.includes(".")) {
    const p = v4.split(".").map((x) => Number(x));
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (raw === "::" || raw === "::1") return true;
  if (raw.startsWith("fe80:") || raw.startsWith("fc") || raw.startsWith("fd")) return true;
  if (raw.startsWith("ff")) return true;
  return false;
}

function blockedName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "localhost.localdomain") return true;
  const google = ["metadata", "google"].join(".");
  if (h === google + ".internal" || h === google + ".com") return true;
  if (/^\d+$/.test(h) || h.startsWith("0x")) return true;
  return false;
}

/**
 * Allowlist from a Worker var (a JSON array of mint URLs). Invalid entries are dropped.
 * `allowLoopback` is the test hook: a loopback http mint is kept so the suite can use a stub.
 * Production leaves it false, so only https public mints remain.
 */
export function parseCashuMints(raw: string | undefined, allowLoopback: boolean): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string" || entry.trim() === "") continue;
    try {
      out.push(allowLoopback ? mintKey(entry) : assertProductionMint(entry));
    } catch {
      /* a bad entry does not open the others, and it is not fetched */
    }
  }
  return out;
}

/** Sync check for a configured production mint. No DNS. https only, path kept, private hosts refused. */
export function assertProductionMint(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new Error("must be an https URL"); }
  if (u.username !== "" || u.password !== "") throw new Error("must not include userinfo");
  if (u.search !== "" || u.hash !== "") throw new Error("must not include a query or fragment");
  if (u.protocol !== "https:") throw new Error("must be https");
  const host = bareHost(u.hostname);
  if (blockedName(host) || isLoopbackHost(host) || (isIP(host) !== 0 && blockedAddress(host))) throw new Error("host is not public");
  return mintKey(raw);
}

async function defaultLookup(host: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const rows = await lookup(host, { all: true, verbatim: true });
  return rows.map((a) => a.address);
}

/**
 * Normalize a mint URL and refuse it unless it is on the allowlist.
 * https is required. A private or loopback address is refused even when listed.
 * loopbackHttp allows http to a loopback host that is listed; nothing else.
 */
export async function guardMintUrl(raw: string, allowlist: string[], opts: MintGuard = {}): Promise<string> {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new Error("mint url"); }
  if (u.username !== "" || u.password !== "") throw new Error("mint url must not include userinfo");
  if (u.search !== "" || u.hash !== "") throw new Error("mint url must not include a query or fragment");
  const host = bareHost(u.hostname);
  const loopbackOk = opts.loopbackHttp === true && isLoopbackHost(host) && u.protocol === "http:";
  // CASHU_GUARD public-host: http and private or loopback addresses are refused before DNS.
  if (u.protocol !== "https:" && !loopbackOk) throw new Error("mint url must be https");
  if (!loopbackOk && (blockedName(host) || (isIP(host) !== 0 && blockedAddress(host)) || isLoopbackHost(host))) throw new Error("mint url host is not public");
  const key = mintKey(raw);
  const allowed = new Set(allowlist.map((m) => { try { return mintKey(m); } catch { return ""; } }));
  // CASHU_GUARD allowlist: a mint that is not listed is not fetched.
  if (!allowed.has(key)) throw new Error("mint url is not on the allowlist");
  if (isIP(host) === 0 && !loopbackOk) {
    const look = opts.lookup ?? defaultLookup;
    let addrs: string[];
    try { addrs = await look(host); } catch { throw new Error("mint url host did not resolve"); }
    if (addrs.length === 0 || addrs.some((a) => blockedAddress(a))) throw new Error("mint url host is not public");
  }
  return key;
}

/** GET or POST `path` on an allowlisted mint. `path` is a mint route such as `/v1/swap`. */
export async function mintFetch(base: string, path: string, init: RequestInit, opts: MintGuard, allowlist: string[]): Promise<{ status: number; text: string }> {
  if (!path.startsWith("/v1/") || path.includes("..") || path.includes("\\") || path.includes("?")) throw new Error("mint path");
  const key = await guardMintUrl(base, allowlist, opts);
  const f = opts.fetch ?? fetch;
  let r: Response;
  try {
    // CASHU_GUARD redirect: never follow. A 3xx below is refused before the body is trusted.
    r = await f(key + path, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new TollError("store_unavailable");
  }
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_BODY) throw new TollError("store_unavailable");
  if (r.status >= 300 && r.status < 400) throw new TollError("store_unavailable");
  return { status: r.status, text: new TextDecoder().decode(buf) };
}
