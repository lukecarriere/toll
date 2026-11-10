// scripts/check-open-intelligence.sh --self-check proves each check can FAIL.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("check-open-intelligence.sh --self-check proves each check can FAIL", async () => {
  const child = spawn("bash", ["scripts/check-open-intelligence.sh", "--self-check"], { cwd: ROOT });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr + "\n" + stdout);
  assert.match(stdout, /manifest FAIL as expected/);
  assert.match(stdout, /llms\.txt FAIL as expected/);
  assert.match(stdout, /paid-402 FAIL as expected/);
  assert.match(stdout, /gitleaks FAIL as expected/);
  assert.match(stdout, /self-check: ok/);
  assert.doesNotMatch(stdout + stderr, /xoxb-/);
});
