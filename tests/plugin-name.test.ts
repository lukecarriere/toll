// Plugin Check treats WordPress in the Plugin Name header as a trademark.
// Agents put "Toll for WordPress" in docs/copy.md (47cb86d) and in the header (ffb9c3d).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
// @ts-ignore plain JS checker
import { pluginNameProblems } from "../scripts/plugin-name.mjs";

const git = (spec: string) => execFileSync("git", ["show", spec], { encoding: "utf8" });
const php = readFileSync("packages/wp-toll-gate/toll-gate.php", "utf8");
const copy = readFileSync("docs/copy.md", "utf8");

test("current header and display name are Toll Gate", () => {
  assert.deepEqual(pluginNameProblems(php, copy), []);
});

test("ffb9c3d header fails: Plugin Name was Toll for WordPress", () => {
  const old = git("ffb9c3d:packages/wp-toll-gate/toll-gate.php");
  const problems = pluginNameProblems(old, copy);
  assert.ok(problems.some((p: string) => p.includes("WordPress") && p.includes("Plugin Name")), problems.join("\n"));
});

test("47cb86d copy fails: display name was Toll for WordPress", () => {
  const old = git("47cb86d:docs/copy.md");
  const problems = pluginNameProblems(php, old);
  assert.ok(problems.some((p: string) => p.includes("WordPress") && p.includes("display name")), problems.join("\n"));
});
