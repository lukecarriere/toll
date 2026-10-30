declare module "*/widget/dist/toll.js" { const s: string; export default s; }
declare module "*/widget/dist/toll.worker.js" { const s: string; export default s; }

declare module "cloudflare:workers" {
  interface SqlCursor { toArray(): Record<string, unknown>[]; }
  interface DoSql { exec(query: string, ...bindings: (string | number | null)[]): SqlCursor; }
  interface DoCtx {
    storage: {
      sql: DoSql;
      setAlarm?(scheduledTime: number): Promise<void>;
      deleteAlarm?(): Promise<void>;
    };
  }
  export abstract class DurableObject<E = unknown> {
    ctx: DoCtx;
    env: E;
    constructor(ctx: DoCtx, env: E);
  }
}
