// The guard fails on the commits that shipped the mistake, and it is quiet on this tree.
// cashuA: #20 bbeb17c and #21 5ef8dbd are on main.
// Conservation: #22's pre-squash commits are on cursor/edge-cashu-receive-8ea2. CI fetches that
// branch (ci.yml) because a squash merge does not keep them on main.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { conservationHits, tokenHits, treeHits } from "../scripts/cashu-guards.ts";

const git = (spec: string) => execFileSync("git", ["show", spec], { encoding: "utf8" });

test("this tree has no cashuB-only gate and abort() stays on an empty restore", () => {
  assert.deepEqual(treeHits(), []);
});

test("bbeb17c required cashuB on the redeem body and refused a cashuA header", () => {
  const rail = git("bbeb17c:packages/settlement-ln/src/rail.ts");
  const http = git("bbeb17c:packages/server-node/src/http.ts");
  const codec = git("bbeb17c:packages/settlement-ln/src/cashu.ts");
  assert.ok(tokenHits("packages/settlement-ln/src/rail.ts", rail).some((h) => h.rule === "cashuB-only gate"));
  assert.ok(tokenHits("packages/server-node/src/http.ts", http).some((h) => h.rule === "cashuA is not a payment"));
  assert.ok(tokenHits("packages/settlement-ln/src/cashu.ts", codec).some((h) => h.rule === "cashuA is not a payment"));
  assert.match(rail, /!body\.token\.startsWith\("cashuB"\)/);
  assert.match(http, /presented\.kind === "a"/);
  assert.match(codec, /startsWith\("cashuA"\)\) return \{ kind: "a" \}/);
});

test("5ef8dbd refused cashuA again, in Node, PHP, and the payer", () => {
  const http = git("5ef8dbd:packages/server-node/src/http.ts");
  const php = git("5ef8dbd:packages/server-php/src/Settlement.php");
  const gate = git("5ef8dbd:packages/wp-toll-gate/includes/gate.php");
  const payer = git("5ef8dbd:packages/agent/src/cashu-payer.ts");
  assert.ok(tokenHits("packages/server-node/src/http.ts", http).length > 0);
  assert.ok(tokenHits("packages/server-php/src/Settlement.php", php).some((h) => h.rule === "cashuA is not a payment"));
  assert.ok(tokenHits("packages/wp-toll-gate/includes/gate.php", gate).some((h) => h.rule === "cashuA is not a payment"));
  assert.ok(tokenHits("packages/agent/src/cashu-payer.ts", payer).some((h) => h.rule === "cashuB-only gate"));
  assert.match(php, /str_starts_with\(\$t, 'cashuA'\)\) return \['kind' => 'a'\]/);
  assert.match(gate, /\$p\['kind'\] === 'a'\) return \[400, \['error' => 'malformed'\]/);
});

test("b73440c aborted and lost outputs the mint still held", () => {
  const src = git("b73440c:packages/settlement-ln/src/cashu-receive.ts");
  const hits = conservationHits(src);
  assert.ok(hits.some((h) => h.rule.startsWith("more than one abort")));
  assert.ok(hits.some((h) => h.rule.startsWith("lose()")));
});

test("f626e44 aborted on a mint refusal instead of an empty restore", () => {
  const src = git("f626e44:packages/settlement-ln/src/cashu-receive.ts");
  const hits = conservationHits(src);
  assert.ok(hits.some((h) => h.rule.includes("empty restore")));
  assert.match(src, /if \(outcome\.kind === "refused" && state === "unspent"\)/);
});

test("the current receive file gates the one abort() on an empty restore", () => {
  const src = readFileSync("packages/settlement-ln/src/cashu-receive.ts", "utf8");
  assert.deepEqual(conservationHits(src), []);
});
