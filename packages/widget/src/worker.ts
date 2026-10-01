// toll.worker.js: all grinding happens here, never on the page's main thread.
// Message in:  { id, challenge, inflight, parallel }
// Message out: { id, ok: true, nonces, tries, took_ms } | { id, ok: false, error }

import { solveWork, type WorkParams } from "../../protocol/src/work.ts";

interface SolveMsg { id: number; challenge: WorkParams; inflight?: number; parallel?: boolean }

const scope = self as unknown as { onmessage: ((e: MessageEvent<SolveMsg>) => void) | null; postMessage(m: unknown): void };

scope.onmessage = async (e) => {
  const { id, challenge, inflight, parallel } = e.data;
  const t0 = performance.now();
  try {
    const r = await solveWork(challenge, { inflight: inflight ?? 1, parallel: parallel ?? true });
    scope.postMessage({ id, ok: true, nonces: r.nonces, tries: r.tries, took_ms: Math.round(performance.now() - t0) });
  } catch (err) {
    scope.postMessage({ id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
