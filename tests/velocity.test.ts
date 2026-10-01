// §19.6 over HTTP: with velocity on (phase 3 default), work per challenge never drops during a burst.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveWork } from "../packages/work-adapter/src/index.ts";
import { startDemo } from "./helpers.ts";

test("19.6 adaptive work cost is non-decreasing under a burst of redeems from one client", async () => {
  const S = await startDemo({ adaptive: { velocity: true }, work: { standard: { cost: 100, unit_tries: 2 } } });
  try {
    for (let i = 0; i < 45; i++) {
      const { challenge } = await (await fetch(`${S.url}/v1/challenge?action=write`)).json();
      const sol = (await solveWork(challenge.work))!;
      const r = await fetch(`${S.url}/v1/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id: challenge.id, challenge, solution: { work: { counter: sol.counter, derivedKey: sol.derivedKey } } }) });
      assert.equal(r.status, 200);
    }
    // The work size is issuer-side only (the counter range is never sent), so read it from the mint log.
    const minted = S.events.filter((e) => e.event === "challenge_minted");
    const sizes = minted.map((e) => e.counter_max);
    for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i] >= sizes[i - 1], `work dropped at ${i}: ${sizes[i - 1]} -> ${sizes[i]}`);
    assert.ok(sizes[sizes.length - 1] >= 3 * sizes[0], `burst raised work: ${sizes[0]} -> ${sizes[sizes.length - 1]}`);
    const mults = minted.map((e) => e.velocity_mult);
    assert.deepEqual([mults[0], mults[mults.length - 1]], [1, 4]);
  } finally {
    await S.close();
  }
});
