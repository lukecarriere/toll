// Spec §16: GET /v1/challenge is rate-limited per IP (default 60/min).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startDemo } from "./helpers.ts";

test("challenge endpoint returns 429 after 60 requests per minute from one IP", async () => {
  const S = await startDemo({ rate_limit: { challenge_per_min: 60 } });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 62; i++) codes.push((await fetch(`${S.url}/v1/challenge?action=search`)).status);
    assert.equal(codes.filter((c) => c === 200).length, 60);
    assert.deepEqual(codes.slice(60), [429, 429]);
    // Over the limit, a no-pass POST is still rejected, just without a fresh challenge.
    const r = await fetch(`${S.url}/contact`, { method: "POST", headers: { accept: "application/json" } });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: "toll_required" });
  } finally {
    await S.close();
  }
});
