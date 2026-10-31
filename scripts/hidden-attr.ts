// .pill { display: inline-block } in website/demo.css painted the demo result pills on
// load. The HTML hidden attribute only sets display:none in the user-agent stylesheet,
// and an author display rule wins. This rule is in site.css so every page keeps it.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const HIDDEN_RULE = "[hidden]{display:none !important}";

const NOTE = "/* An author display rule must not override the HTML hidden attribute. */\n";
const ANCHOR = "*{box-sizing:border-box}\n";

export function siteCssKeepsHidden(css: string): boolean {
  return css.includes(HIDDEN_RULE);
}

/**
 * The inner-pages handoff plus the hidden rule. A file that already has the rule
 * is returned unchanged, so the shipped stylesheet compares equal to this.
 */
export function withHiddenRule(handoff: string): string {
  if (handoff.includes(HIDDEN_RULE)) return handoff;
  if (!handoff.includes(ANCHOR)) throw new Error("site.css has no box-sizing rule to anchor the hidden rule");
  return handoff.replace(ANCHOR, ANCHOR + NOTE + HIDDEN_RULE + "\n");
}

export function hiddenRuleMissing(css: string): string | null {
  if (siteCssKeepsHidden(css)) return null;
  return "website/site.css is missing " + HIDDEN_RULE + " (an author display rule would show hidden elements)";
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const css = readFileSync(new URL("../website/site.css", import.meta.url), "utf8");
  const problem = hiddenRuleMissing(css);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log("hidden-attr: ok");
}
