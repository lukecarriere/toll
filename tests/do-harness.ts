// The edge Durable Object store run in Node over node:sqlite, for store-level tests that need a
// restart or a hand-edited row. `cloudflare:workers` resolves to a one-class stand-in here only.
import { registerHooks } from "node:module";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const STAND_IN = "data:text/javascript," + encodeURIComponent("export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: STAND_IN, shortCircuit: true };
    return next(specifier, context);
  },
});

const { TollStoreDO } = await import("../packages/edge-cf/src/do-store.ts");
type Ctx = ConstructorParameters<typeof TollStoreDO>[0];

/** One SQLite file standing in for a DO's storage. Each `open()` is a cold start of the object on it. */
export function doStorage() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: (string | number | null)[]) {
      const rows = db.prepare(query).all(...(bindings as SQLInputValue[])) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
  const transactionSync = <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const ctx = { storage: { sql, transactionSync, setAlarm: async () => {}, deleteAlarm: async () => {} }, id: { toString: () => "do-test" } };
  return {
    db,
    open: (env: Record<string, string> = {}) => new TollStoreDO(ctx as unknown as Ctx, env as never),
    columns: (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
  };
}
