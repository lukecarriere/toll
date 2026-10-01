// Minimal MCP stdio client for tests: spawns packages/mcp/src/server.ts and speaks JSON-RPC lines.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export class McpClient {
  proc: ChildProcess;
  stderr: string[] = [];
  private buf = "";
  private next = 1;
  private waiting = new Map<number, (m: any) => void>();
  constructor(env: Record<string, string> = {}) {
    this.proc = spawn(process.execPath, [fileURLToPath(new URL("../packages/mcp/src/server.ts", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    this.proc.stdout!.on("data", (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        this.waiting.get(m.id)?.(m);
        this.waiting.delete(m.id);
      }
    });
    let eb = "";
    this.proc.stderr!.on("data", (d) => {
      eb += d;
      let i;
      while ((i = eb.indexOf("\n")) >= 0) { this.stderr.push(eb.slice(0, i)); eb = eb.slice(i + 1); }
    });
  }
  request(method: string, params?: unknown): Promise<any> {
    const id = this.next++;
    return new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error("mcp timeout: " + method)), 20000);
      this.waiting.set(id, (m) => { clearTimeout(t); ok(m); });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async init() {
    const r = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return r;
  }
  /** tools/call -> structuredContent (throws on isError). */
  async call(name: string, args: Record<string, unknown>): Promise<any> {
    const r = await this.request("tools/call", { name, arguments: args });
    if (r.error) throw new Error(JSON.stringify(r.error));
    if (r.result.isError) throw new Error(r.result.content[0].text);
    return r.result.structuredContent;
  }
  /** Today's counters from the last stderr counters line. */
  counters(): Record<string, number> {
    const last = [...this.stderr].reverse().find((l) => l.includes('"event":"counters"'));
    return last ? JSON.parse(last) : {};
  }
  close() { this.proc.kill(); }
}
