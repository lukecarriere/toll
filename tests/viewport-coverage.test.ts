// The phone-width check has to list every page the build emits.
// 6f65ddd^ had no viewport test while /demo already overflowed.
// 5cd9c85 added mission and legal pages and left them out of PATHS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
// @ts-ignore plain JS build script
import { PAGES, DOC_PAGES, LEGAL_PAGES, pagePath } from "../website/build.mjs";

const required = [
  "/",
  "/demo",
  ...PAGES.map((p: { file: string }) => pagePath(p.file)),
  ...DOC_PAGES.map((p: { file: string }) => pagePath(p.file)),
  ...LEGAL_PAGES.map((p: { file: string }) => pagePath(p.file)),
];

function uncovered(src: string) {
  const covered = new Set<string>();
  if (src.includes('"/demo"')) covered.add("/demo");
  if (src.includes('"/"')) covered.add("/");
  if (/(?<![A-Za-z_])PAGES\.map/.test(src)) for (const p of PAGES) covered.add(pagePath(p.file));
  if (/(?<![A-Za-z_])DOC_PAGES\.map/.test(src)) for (const p of DOC_PAGES) covered.add(pagePath(p.file));
  if (/(?<![A-Za-z_])LEGAL_PAGES\.map/.test(src)) for (const p of LEGAL_PAGES) covered.add(pagePath(p.file));
  for (const m of src.matchAll(/"(\/[^"]*)"/g)) covered.add(m[1]);
  return required.filter((p) => !covered.has(p));
}

test("current viewport test covers every built public page", () => {
  const src = readFileSync("tests/viewport.test.ts", "utf8");
  assert.deepEqual(uncovered(src), []);
});

test("6f65ddd parent: no viewport test while the demo page existed", () => {
  assert.throws(() => execFileSync("git", ["cat-file", "-e", "6f65ddd^:tests/viewport.test.ts"], { stdio: "pipe" }));
  execFileSync("git", ["cat-file", "-e", "6f65ddd^:website/demo.html"], { stdio: "pipe" });
  assert.ok(uncovered("").includes("/demo"));
});

test("5cd9c85: viewport PATHS omitted mission and legal pages that the build emitted", () => {
  const src = execFileSync("git", ["show", "5cd9c85:tests/viewport.test.ts"], { encoding: "utf8" });
  const build = execFileSync("git", ["show", "5cd9c85:website/build.mjs"], { encoding: "utf8" });
  assert.match(build, /file: "mission"/);
  assert.match(build, /file: "privacy"/);
  const gaps = uncovered(src);
  assert.ok(gaps.includes("/mission"), gaps.join(","));
  assert.ok(gaps.includes("/privacy"), gaps.join(","));
  assert.ok(gaps.includes("/terms") && gaps.includes("/support"));
});
