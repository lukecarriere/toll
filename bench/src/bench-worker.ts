// Benchmark worker. Same solver as the widget worker, plus a raw KDF timing mode.
import { solveWork, webCryptoKdf, type WorkParams } from "../../packages/protocol/src/work.ts";

type Msg =
  | { kind: "solve"; id: number; challenge: WorkParams; inflight: number; parallel: boolean }
  | { kind: "kdf"; id: number; cost: number; calls: number; inflight: number };

const scope = self as unknown as { onmessage: ((e: MessageEvent<Msg>) => void) | null; postMessage(m: unknown): void };

scope.onmessage = async (e) => {
  const m = e.data;
  if (m.kind === "solve") {
    const t0 = performance.now();
    const r = await solveWork(m.challenge, { inflight: m.inflight, parallel: m.parallel });
    scope.postMessage({ id: m.id, nonces: r.nonces, tries: r.tries, took_ms: performance.now() - t0 });
  } else {
    const pw = new TextEncoder().encode("0000000000000000");
    const salt = new Uint8Array(32);
    const t0 = performance.now();
    let done = 0;
    while (done < m.calls) {
      const k = Math.min(m.inflight, m.calls - done);
      await Promise.all(Array.from({ length: k }, (_, j) => { pw[15] = 48 + ((done + j) % 10); return webCryptoKdf(pw, salt, m.cost); }));
      done += k;
    }
    const ms = performance.now() - t0;
    scope.postMessage({ id: m.id, ms, iterations: m.calls * m.cost, ips: (m.calls * m.cost) / (ms / 1000) });
  }
};
