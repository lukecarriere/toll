// Local edge worker (spec §11): issuer and gate in front of ORIGIN, KV when bound, memory otherwise.
// The site worker (src/site.ts) uses the same handler with the Durable Object store.
import { MemoryStore } from "../../server-node/src/stores.ts";
import { createEdgeHandler, type EdgeEnv } from "./handler.ts";
import { KVStore } from "./kv-store.ts";

export type { EdgeEnv };

export default createEdgeHandler({
  store(env: EdgeEnv) {
    return env.TOLL_KV ? new KVStore(env.TOLL_KV) : new MemoryStore(() => Math.floor(Date.now() / 1000));
  },
});
