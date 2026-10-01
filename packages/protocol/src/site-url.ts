// TOLL_SITE_URL: the root URL of Toll's own public site (one setting for every package). It fills
// the manifest's `docs` field (/.well-known/toll.json) and nothing else; the protected site's own
// URLs (`api`, the agents.json pointer) always come from the request or the WordPress home URL.
// Node and the edge read it from the environment (the Worker `env` binding at the edge), WordPress
// from a PHP constant of the same name in wp-config.php (packages/wp-toll-gate, toll_gate_site_url(),
// same rules). Unset or empty: null, and every output is byte-identical to a build without it.
//
// Accepted: `https://` (lowercase) + a host name + optional :port (1-65535) + optional path, after
// trimming ASCII spaces, tabs and line breaks. The host is DNS labels (letters, digits, '-', not at
// either end of a label) whose last label starts with a letter, so IP literals are refused. No
// user info, query or fragment. Trailing slashes are removed: "https://site.example/" -> "https://site.example".
// Invalid: logged once and treated as unset (the manifest keeps serving; a WordPress site never
// fails on a typo in wp-config.php). Use parseSiteUrl() to fail hard instead (e.g. a build step).

export const SITE_URL_ENV = "TOLL_SITE_URL";

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const LAST = "[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
/** Same pattern as TOLL_GATE_SITE_URL_RE in packages/wp-toll-gate/includes/discovery.php. */
export const SITE_URL_PATTERN = `^https://(?:${LABEL}\\.)*${LAST}(?::([0-9]{1,5}))?(/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$`;
const SITE_URL_RE = new RegExp(SITE_URL_PATTERN);

export type SiteUrlResult = { url: string | null; error: null } | { url: null; error: string };

/** Validate a raw TOLL_SITE_URL value. `url` is null when unset or empty; `error` is set when the value is not accepted. */
export function parseSiteUrl(raw: unknown): SiteUrlResult {
  if (raw === undefined || raw === null) return { url: null, error: null };
  if (typeof raw !== "string") return { url: null, error: `${SITE_URL_ENV} must be a string` };
  const v = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (v === "") return { url: null, error: null };
  const m = SITE_URL_RE.exec(v);
  if (!m) return { url: null, error: `${SITE_URL_ENV} must be an absolute https:// URL with a host name (no user info, query or fragment)` };
  if (m[1] !== undefined && (Number(m[1]) < 1 || Number(m[1]) > 65535)) return { url: null, error: `${SITE_URL_ENV} has a port outside 1-65535` };
  return { url: v.replace(/\/+$/, ""), error: null };
}

const warned = new Set<string>();
const defaultWarn = (msg: string) => console.warn(msg);

/**
 * The Toll site root from a raw TOLL_SITE_URL value, or null when unset, empty or invalid. An invalid
 * value is reported once per process per distinct value through `warn` (the value itself is not
 * logged) and treated as unset.
 */
export function siteUrl(raw?: string | null, warn: (msg: string) => void = defaultWarn): string | null {
  const r = parseSiteUrl(raw);
  if (r.error !== null && !warned.has(String(raw))) {
    warned.add(String(raw));
    warn(`[toll] ${r.error}; ignored, so the manifest's docs field stays as if it were unset`);
  }
  return r.url;
}
