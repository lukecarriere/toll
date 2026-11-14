// scripts/check-live-pages.sh --self-check proves default pages can PASS and each check can FAIL.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("check-live-pages.sh --self-check proves each check can FAIL", async () => {
  const child = spawn("bash", ["scripts/check-live-pages.sh", "--self-check"], { cwd: ROOT });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr + "\n" + stdout);
  assert.match(stdout, /self-check: baseline PASS/);
  assert.match(stdout, /sitemap\.xml FAIL as expected/);
  assert.match(stdout, /page 200 FAIL as expected/);
  assert.match(stdout, /phrase FAIL as expected/);
  assert.match(stdout, /token not printed/);
  assert.match(stdout, /self-check: ok/);
  assert.doesNotMatch(stdout + stderr, /cashuA0123456789abcdefsecret/);
});
