// Shared by the edge handler and the Durable Object. This file does not import the Workers
// runtime, so the local edge bundle can still be loaded in Node.
import { AsyncLocalStorage } from "node:async_hooks";

/** Test-only fault name for the current request. Unset in production. */
export const cashuFaultSlot = new AsyncLocalStorage<string>();

export interface CashuEnv {
  CASHU_MINTS?: string;
  TOLL_TEST_HOOKS?: string;
  /** Test-only. Ignored unless TOLL_TEST_HOOKS is "1". Not set in wrangler.toml. */
  CASHU_FETCH_PROXY?: string;
}

/** URLs the worker was about to fetch from a mint. Cleared by the test endpoint. Test hooks only. */
export const mintFetches: string[] = [];

export function cashuFetch(env: CashuEnv, mints: string[]): typeof fetch {
  return async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (env.TOLL_TEST_HOOKS === "1") mintFetches.push(href);
    let target = href;
    if (env.TOLL_TEST_HOOKS === "1" && env.CASHU_FETCH_PROXY && mints.some((m) => href.startsWith(m))) {
      const u = new URL(href);
      const p = new URL(env.CASHU_FETCH_PROXY);
      const i = u.pathname.indexOf("/v1/");
      const path = i >= 0 ? u.pathname.slice(i) : u.pathname;
      target = p.origin + path + u.search;
    }
    return fetch(target, init);
  };
}
