// The PHP issuer (WordPress plugin) and the Node issuer agree: same work policy numbers, and a
// PHP-minted challenge and pass verify on the Node side (tests/php/run-issuer.php --json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { checkChallenge, verifyPassToken } from "../packages/protocol/src/index.ts";
import { workParams } from "../packages/protocol/src/policy.ts";
import { DEFAULT_WORK } from "../packages/server-node/src/config.ts";
import { createWorkAdapter, solveWork } from "../packages/work-adapter/src/index.ts";

const fx = JSON.parse(execFileSync("php", ["tests/php/run-issuer.php", "--json"], { encoding: "utf8" }));

test("PHP Policy.workParams == Node workParams (adaptive off) for every class, device and mode", () => {
  for (const [k, php] of Object.entries<any>(fx.policy)) {
    const [action, ua_class, mode] = k.split("|");
    const node = workParams({ ...DEFAULT_WORK, mode: mode as any }, action as any, { ua_class: ua_class as any, recent_redeems: 0, velocity_enabled: false });
    for (const f of ["mode", "alg", "cost", "counter_max", "expected_tries", "memory_kib", "parallelism"] as const) assert.equal(php[f], (node as any)[f], `${k} ${f}`);
  }
});

const phpVerify = (input: unknown) => JSON.parse(execFileSync("php", ["tests/php/run-issuer.php", "--verify"], { input: JSON.stringify(input), encoding: "utf8" }));

test("a PHP-minted challenge passes the Node envelope check, and the browser solver's answer verifies on PHP", async () => {
  const c = await checkChallenge(fx.secret, fx.challenge, { now: fx.now, site: fx.site });
  const sol = await solveWork(c.work); // the same engine solver the widget's workers run
  assert.ok(sol);
  const work = { counter: sol!.counter, derivedKey: sol!.derivedKey };
  assert.deepEqual(phpVerify({ challenge: c, solution: { work }, now: fx.now }), { ok: true, code: null });
  assert.deepEqual(phpVerify({ challenge: c, solution: { work: { ...work, derivedKey: "00".repeat(32) } }, now: fx.now }), { ok: false, code: "bad_solution" });
  // Known vendor-library difference (docs/adapters.md): the PHP library signs the derived key as
  // hex text, the JS library as bytes, so the Node fast path cannot check a PHP-minted key
  // signature. Each issuer verifies its own challenges; this pins the behaviour so a library update
  // that changes it is noticed.
  const v = await createWorkAdapter(fx.secret).verify(c.work, work, { tid: c.id, alg: c.alg });
  assert.equal(v.ok, false);
});

test("a PHP pass verifies on Node with the same claims (900 s, 20 uses)", async () => {
  const claims = await verifyPassToken(fx.secret, fx.pass, { now: fx.now, site: fx.site, action: "write" });
  assert.deepEqual(claims, fx.claims);
  assert.equal(claims.exp - claims.iat, 900);
  assert.equal(claims.n, 20);
});
