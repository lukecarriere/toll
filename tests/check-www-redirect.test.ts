// scripts/check-www-redirect.sh --self-check proves a correct 308 can PASS and each failure can FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("check-www-redirect.sh --self-check proves each check can FAIL", async () => {
  const child = spawn("bash", ["scripts/check-www-redirect.sh", "--self-check"], { cwd: ROOT });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr + "\n" + stdout);
  assert.match(stdout, /self-check: baseline PASS/);
  assert.match(stdout, /wrong status FAIL as expected/);
  assert.match(stdout, /dropped query FAIL as expected/);
  assert.match(stdout, /wrong host FAIL as expected/);
  assert.match(stdout, /self-check: ok/);
});

test("header names the shared script as the source of truth", () => {
  const text = readFileSync(join(ROOT, "scripts/check-www-redirect.sh"), "utf8");
  assert.match(text, /Source of truth: \/workspace\/projects\/shared\/scripts\/check-www-redirect\.sh/);
});
