// Repeat-mistake check: the demo pills shipped visible because site.css had no
// [hidden] rule and demo.css set display on .pill. CI fails if the rule is gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HIDDEN_RULE, hiddenRuleMissing, siteCssKeepsHidden, withHiddenRule } from "../scripts/hidden-attr.ts";

const css = readFileSync(new URL("../website/site.css", import.meta.url), "utf8");

test("site.css keeps the HTML hidden attribute hidden", () => {
  assert.equal(hiddenRuleMissing(css), null);
  assert.equal(siteCssKeepsHidden(css), true);
  const stripped = css.replace(HIDDEN_RULE, "");
  assert.equal(siteCssKeepsHidden(stripped), false);
  assert.equal(hiddenRuleMissing(stripped), "website/site.css is missing " + HIDDEN_RULE + " (an author display rule would show hidden elements)");
  assert.equal(siteCssKeepsHidden("[hidden]{display:none}"), false, "without !important a later author display rule wins");
});

test("the hidden rule is the only addition on top of a handoff stylesheet", () => {
  const handoff = css.replace("/* An author display rule must not override the HTML hidden attribute. */\n" + HIDDEN_RULE + "\n", "");
  assert.equal(siteCssKeepsHidden(handoff), false);
  assert.equal(withHiddenRule(handoff), css);
  assert.equal(withHiddenRule(css), css);
});
