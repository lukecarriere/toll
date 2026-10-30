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
  assert.ok(hits.some((h) => h.rule.includes("not gated")));
  assert.ok(hits.some((h) => h.rule.startsWith("lose()")));
});

test("a cashuB check that is not startsWith, and a cashuA refusal that is not one line, are still gates", () => {
  const tsCases = [
    `if (body.token.slice(0, 6) !== "cashuB") throw new Error("malformed");`,
    `if (/^cashuB/.test(header)) return header; throw new Error("malformed");`,
    `if (header.indexOf("cashuB") !== 0) return null;`,
    `if (presented.kind === "a")\n  return { error: "malformed" };`,
    `if (token.startsWith("cashuA")) return null;`,
    `if (s.startsWith("cashuB") && !s.startsWith("cashuA")) return s;`,
  ];
  for (const src of tsCases) assert.ok(tokenHits("fixture.ts", src).length > 0, src);
  assert.ok(tokenHits("fixture.php", `if (substr($payment, 0, 6) === 'cashuB') return $payment;`).length > 0);
  assert.ok(tokenHits("fixture.php", `if (str_starts_with($token, 'cashuA')) return null;`).some((h) => h.rule.includes("cashuA")));
});

test("abort.bind and an abort() outside cashu-receive.ts are still unguarded", () => {
  const src = `function pay() {\n  const drop = store.abort.bind(store);\n  if (bad) drop(id);\n}\n`;
  assert.ok(conservationHits(src, "packages/other.ts").some((h) => h.rule.includes("not gated")));
});

test("extra parentheses or a broken if still count as the empty-restore guard", () => {
  const wrapped = `function f() { if ((empty && !unclear && state === "unspent")) { store.abort(id); } }`;
  const broken = `function f() {\n  if (\n    empty &&\n    !unclear &&\n    state === "unspent"\n  ) { store.abort(id); }\n}`;
  assert.deepEqual(conservationHits(wrapped), []);
  assert.deepEqual(conservationHits(broken), []);
});

test("a sweeper may abort after tryRestore is none and tryCheck is unspent", () => {
  const src = `async function recoverSaved() {\n  for (const pending of rows) {\n    const restored = await this.tryRestore(pending);\n    if (restored.kind !== "none") continue;\n    if ((await this.tryCheck(pending)) === "unspent") await store.abort(pending.id);\n  }\n}\n`;
  assert.deepEqual(conservationHits(src), []);
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
