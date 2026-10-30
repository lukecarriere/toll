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
 * Paths the worker already handled before it ran first for every request.
 * Anything else is a static asset: forwarded to ASSETS, not gated.
 */
export function workerHandles(pathname: string): boolean {
  return pathname.startsWith("/v1/")
    || pathname.startsWith("/toll/v1/")
    || pathname.startsWith("/demo/")
    || pathname === "/.well-known/toll.json"
    || pathname === "/.well-known/agents.json";
}
