// PHP's built-in server closes the socket. Reading only .status or .ok leaves the body unread,
// undici pauses, and Parser.finish throws assert(!this.paused). That broke agent-pay (f935537)
// and the WordPress counter test (e6fb4a6). Read the body with arrayBuffer, json, or text, or drain().
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore plain JS scanner
import { unreadFetches } from "../scripts/fetch-body-lint.mjs";

const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8" });

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "dist") continue;
    try {
      if (readdirSync(p).length >= 0 && !name.includes(".")) { out.push(...sources(p)); continue; }
    } catch { /* file */ }
    if (/\.(ts|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

test("working tree: tests and the agent client read every status-checked fetch body", () => {
  const files = [...sources("tests"), ...sources("packages/agent/src")];
  const hits = files.flatMap((f) => unreadFetches(readFileSync(f, "utf8")).map((h: { line: number; text: string }) => `${f}:${h.line} ${h.text}`));
  assert.deepEqual(hits, [], "read the body with arrayBuffer, json, or text, or drain()");
});

test("f935537 parent: agent-pay left three fetch bodies unread", () => {
  const src = git(["show", "f935537^:packages/agent/src/agent-pay.ts"]);
  const hits = unreadFetches(src);
  assert.equal(hits.length, 3, "the parent of f935537 must fail this check. Read the body with arrayBuffer, json, or text, or drain().");
});

test("e6fb4a6 parent: the WordPress counter test left two fetch bodies unread", () => {
  const src = git(["show", "e6fb4a6^:tests/wp-counters.test.ts"]);
  const hits = unreadFetches(src);
  assert.equal(hits.length, 2, "the parent of e6fb4a6 must fail this check");
});
