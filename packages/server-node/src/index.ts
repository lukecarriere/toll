import { createToll, type Toll as TollInstance, type TollOptions } from "./toll.ts";
import { type TollConfig, loadConfig, normalizeConfig, classifyPath, DEFAULT_WORK, PAGE_VIEW_WARNING, PAGE_VIEW_CONFIRM } from "./config.ts";
import { tollRouter, protect, guardFetch, extractPass, readBody, parseCookies, PASS_COOKIE, VERSION } from "./http.ts";

export { createToll, loadConfig, normalizeConfig, classifyPath, DEFAULT_WORK, PAGE_VIEW_WARNING, PAGE_VIEW_CONFIRM, tollRouter, protect, guardFetch, extractPass, readBody, parseCookies, PASS_COOKIE, VERSION };
export type { TollInstance, TollOptions, TollConfig };
export { solveWork } from "../../work-adapter/src/index.ts";
export { Metrics } from "./metrics.ts";
export { MemoryStore, WindowCounter, type TollStore } from "./stores.ts";

/**
 * Spec §12 surface:
 *   const toll = Toll.create(config)
 *   toll.issueChallenge({ site, action, path }) -> challenge
 *   toll.verifySolution(challenge, solution)    -> { pass, ... }
 *   toll.verifyPass(pass, { action, path })      -> claims (throws if invalid)
 *   Toll.middleware(toll, { action })            -> (req, res, next)
 */
export const Toll = {
  create: (config: TollConfig, opts?: TollOptions) => createToll(config, opts),
  router: tollRouter,
  middleware: protect,
  fetch: guardFetch,
};
