import { test } from "node:test";
import assert from "node:assert/strict";
import { killed, tapCounts } from "../scripts/mutate-mint-quote.mjs";

const TAP_FAIL = "TAP version 13\nnot ok 1 - a guard test\n1..1\n# tests 1\n# suites 0\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n";
const TAP_PASS = "TAP version 13\nok 1 - a guard test\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n";
// What Node 23+ prints to a pipe with no --test-reporter: the spec reporter, no "# fail" line.
const SPEC_FAIL = "✖ a guard test (12.3ms)\nℹ tests 1\nℹ suites 0\nℹ pass 0\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\n";

test("mutant parser: a TAP failure with a non-zero exit is a kill", () => {
  assert.deepEqual(tapCounts(TAP_FAIL), { tests: 1, fail: 1 });
  assert.equal(killed(1, TAP_FAIL), true);
});

test("mutant parser: a passing run or a crash without TAP is not a kill", () => {
  assert.equal(killed(0, TAP_PASS), false);
  assert.equal(killed(1, "SyntaxError: Unexpected token\n"), false);
  assert.equal(tapCounts(SPEC_FAIL), null, "spec output is never read as TAP");
  assert.equal(killed(1, SPEC_FAIL), false);
});
