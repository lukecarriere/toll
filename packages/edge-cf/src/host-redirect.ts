// www.<apex> -> the apex, same path and query. The apex is TOLL_SITE_URL (wrangler.toml).
// Cloudflare puts the custom-domain host on the request URL. Any other host is left alone,
// including the apex itself, so /v1 and the static site on the apex are unchanged.

/** 308 to the apex when `req` is for www.<apex host>. Null when it is not that host. */
export function wwwRedirect(req: Request, site: string | undefined): Response | null {
  if (!site) return null;
  let apex: URL;
  let url: URL;
  try {
    apex = new URL(site);
    url = new URL(req.url);
  } catch {
    return null;
  }
  if (apex.protocol !== "https:") return null;
  if (url.hostname.toLowerCase() !== "www." + apex.hostname.toLowerCase()) return null;
  return new Response(null, {
    status: 308,
    headers: {
      location: "https://" + apex.host + url.pathname + url.search,
      "cache-control": "public, max-age=86400",
    },
  });
}

/**
 * Extensionless HTML pages. A trailing slash is the same page. `/pricing` is included
 * so a pricing page is a file, not a gate. `/demo` is the demo page; `/demo/...` is not.
 */
const STATIC_PAGES = new Set([
  "/",
  "/demo",
  "/docs",
  "/download",
  "/pricing",
  "/mission",
  "/vision",
  "/values",
  "/ecosystem",
  "/privacy",
  "/terms",
  "/support",
]);

/** Trees that are only files: guides, the plugin zip, photos, and fonts. */
const STATIC_TREES = ["/docs/", "/download/", "/img/", "/fonts/"];

/** Site files. Scripts under /v1, /toll, and /demo/ are the worker, not these. */
const STATIC_FILE = /\.(?:css|js|html|ico|png|jpe?g|svg|woff2|txt|xml|webp)$/i;

function pagePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/**
 * True when this path is a static page or file. The asset binding serves it, and the
 * gate does not see it. A gated route such as /search is not in this set.
 */
export function isSiteAsset(pathname: string): boolean {
  const path = pagePath(pathname);
  if (path.startsWith("/v1/") || path.startsWith("/toll/") || path.startsWith("/demo/") || path.startsWith("/.well-known/")) return false;
  if (STATIC_PAGES.has(path)) return true;
  if (STATIC_TREES.some((prefix) => path.startsWith(prefix))) return true;
  return STATIC_FILE.test(path);
}

/**
 * The worker runs first on every request so www.<apex> can redirect, then static
 * pages and files are handed to the asset binding. Everything else, including
 * POST /search, stays here and reaches the gate.
 */
export function workerHandles(pathname: string): boolean {
  return !isSiteAsset(pathname);
}
