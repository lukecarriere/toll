// agent-pay reads every response body to the end (packages/agent/src/agent-pay.ts). PHP's built-in
// server, which runs the local WordPress sites, sends "Connection: close" and closes the socket after
// each response. An unread body there leaves Node's fetch (undici) paused on that socket: either the
// socket stays open, or undici throws "assert(!this.paused)" from Parser.finish when the close arrives
// (tests/wp-counters.test.ts "agent-pay 20" failed that way). This server answers the same way and
// keeps track of its connections; once agentPay returns, the client must have closed every one.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { agentPay } from "../packages/agent/src/agent-pay.ts";

test("agent-pay reads every body: a server that closes after each response is left with no half-read connection", async () => {
  const body = Buffer.alloc(300_000, "x"); // more than fetch buffers, so an unread body stops the parser part-way
  const open = new Set<net.Socket>();
  const seen: string[] = [];
  const srv = net.createServer((s) => {
    open.add(s);
    s.on("close", () => open.delete(s));
    s.on("error", () => {});
    s.once("data", (d) => {
      const line = d.toString("latin1").split("\r\n")[0];
      seen.push(line);
      const status = line.startsWith("POST /form ") ? "200 OK" : "404 Not Found"; // the write, or GET /demo/stats
      s.write(`HTTP/1.1 ${status}\r\nContent-Type: text/html; charset=UTF-8\r\nConnection: close\r\n\r\n`);
      s.end(body);
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const r = await agentPay({ base, path: "/form", writes: 3 });
    assert.equal(r.accepted, 3);
    assert.deepEqual(seen.map((l) => l.split(" ").slice(0, 2).join(" ")), ["GET /demo/stats", "POST /form", "POST /form", "POST /form", "GET /demo/stats"]);
    for (let i = 0; i < 50 && open.size > 0; i++) await new Promise((ok) => setTimeout(ok, 20));
    assert.equal(open.size, 0, `${open.size} of ${seen.length} responses were left unread`);
  } finally {
    for (const s of open) s.destroy();
    await new Promise((ok) => srv.close(ok));
  }
});
