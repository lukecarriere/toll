// §19.6 over HTTP: with velocity on (phase 3 default), work per challenge never drops during a burst.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveWork } from "../packages/protocol/src/index.ts";
import { startDemo } from "./helpers.ts";

test("19.6 adaptive work cost is non-decreasing under a burst of redeems from one client", async () => {
  const S = await startDemo({ adaptive: { velocity: true }, work: { unit_iterations: 4_000, cost: 100 } });
  try {
    const spans: number[] = [];
    for (let i = 0; i < 45; i++) {
      const { challenge } = await (await fetch(`${S.url}/v1/challenge?action=write`)).json();
      spans.push(challenge.counter_end - challenge.counter_start);
      const sol = await solveWork(challenge);
      const r = await fetch(`${S.url}/v1/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id: challenge.id, challenge, solution: { nonces: sol.nonces } }) });
      assert.equal(r.status, 200);
    }
    for (let i = 1; i < spans.length; i++) assert.ok(spans[i] >= spans[i - 1], `span dropped at ${i}: ${spans[i - 1]} -> ${spans[i]}`);
    assert.ok(spans[spans.length - 1] >= 3 * spans[0], `burst raised work: ${spans[0]} -> ${spans[spans.length - 1]}`);
    const mults = S.events.filter((e) => e.event === "challenge_minted").map((e) => e.velocity_mult);
    assert.deepEqual([mults[0], mults[mults.length - 1]], [1, 4]);
  } finally {
    await S.close();
  }
});
