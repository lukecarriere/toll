// Pins for the verification scripts: known PHP misses, release matching, redaction, and --help.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore plain JS module
import { classifyIssuerRun, classifyVectorRun, SODIUM_ERROR, VECTORS_KNOWN } from "../scripts/php-known.mjs";
// @ts-ignore plain JS module
import { commitInMessage, judgeRelease, previousVersionId } from "../scripts/release-match.mjs";
// @ts-ignore plain JS module
import { redact } from "../scripts/live-checks.mjs";

const hardened = "FAIL solution accepted: hardened account (Argon2id t=2 m=8192 p=1, counter 3) (malformed)";

test("run-vectors: the single hardened miss is KNOWN only without sodium", () => {
  const stdout = `ok   engine secrets\n${hardened}\n\nPHP 8.3.6: ${VECTORS_KNOWN.passed} passed, ${VECTORS_KNOWN.failed} failed\n`;
  const known = classifyVectorRun({ stdout, exitCode: 1, sodium: false });
  assert.equal(known.status, "KNOWN");
  assert.match(known.reason, /hardened Argon2id/);
  assert.equal(classifyVectorRun({ stdout, exitCode: 1, sodium: true }).status, "FAIL");
  const extra = stdout.replace(hardened, hardened + "\nFAIL solution accepted: standard write (bad)");
  assert.equal(classifyVectorRun({ stdout: extra, exitCode: 1, sodium: false }).status, "FAIL");
  const drifted = stdout.replace(`${VECTORS_KNOWN.passed} passed`, `${VECTORS_KNOWN.passed - 1} passed`);
  assert.equal(classifyVectorRun({ stdout: drifted, exitCode: 1, sodium: false }).status, "FAIL");
});

test("run-vectors: an uncaught sodium error with no other FAIL line is KNOWN", () => {
  const stdout = `ok   engine secrets\nPHP Fatal error: Uncaught RuntimeException: ${SODIUM_ERROR}\n`;
  assert.equal(classifyVectorRun({ stdout, exitCode: 255, sodium: false }).status, "KNOWN");
  assert.equal(classifyVectorRun({ stdout: "PHP Fatal error: Uncaught Error: class missing\n", exitCode: 255, sodium: false }).status, "FAIL");
});

test("run-issuer: the sodium fatal is KNOWN, and a real FAIL line is not", () => {
  const stdout = `ok   policy: hardened write\nPHP Fatal error: Uncaught RuntimeException: ${SODIUM_ERROR}\n`;
  assert.equal(classifyIssuerRun({ stdout, exitCode: 255, sodium: false }).status, "KNOWN");
  assert.equal(classifyIssuerRun({ stdout, exitCode: 255, sodium: true }).status, "FAIL");
  assert.equal(classifyIssuerRun({ stdout: stdout + "FAIL mint: envelope shape\n", exitCode: 255, sodium: false }).status, "FAIL");
  assert.equal(classifyIssuerRun({ stdout: "ok   policy\n\nPHP 8.3.6 issuer: 20 passed, 0 failed\n", exitCode: 0, sodium: false }).status, "PASS");
});

test("release match: the live version and the deploy message have to name the commit", () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const deployment = {
    annotations: { "workers/message": `deploy ${commit}` },
    versions: [{ version_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", percentage: 100 }],
  };
  const versions = [
    { id: "11111111-1111-1111-1111-111111111111", metadata: { created_on: "2026-10-01T00:00:00Z" } },
    { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", metadata: { created_on: "2026-10-02T00:00:00Z" }, annotations: { "workers/message": commit } },
  ];
  const pass = judgeRelease({ commit, version: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", deployment, versions });
  assert.equal(pass.status, "PASS");
  assert.equal(pass.previous, "11111111-1111-1111-1111-111111111111");
  const wrong = judgeRelease({ commit, version: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", deployment, versions });
  assert.equal(wrong.status, "FAIL");
  const unnamed = judgeRelease({
    commit,
    version: versions[1].id,
    deployment: { ...deployment, annotations: {} },
    versions: [{ ...versions[1], annotations: {} }],
  });
  assert.equal(unnamed.status, "FAIL");
  assert.match(unnamed.reason, /message/);
  assert.equal(commitInMessage(commit, commit.slice(0, 7)), true);
  assert.equal(commitInMessage(commit, "nope"), false);
  assert.equal(previousVersionId(versions, versions[0].id), null);
});

test("redact removes payment strings and secret fields", () => {
  const token = "cashuA" + "a".repeat(40);
  const request = "creqA" + "b".repeat(40);
  const out = redact({ token, nested: { request, secret: "s".repeat(20), amount: 10 }, note: "Toll " + "c".repeat(24) });
  assert.equal(out.includes("aaaa"), false);
  assert.equal(out.includes("bbbb"), false);
  assert.equal(out.includes("ssss"), false);
  assert.equal(out.includes("cccc"), false);
  assert.match(out, /redacted/);
  assert.match(out, /"amount":10/);
});

test("verification commands print help and do not run a check", () => {
  for (const script of ["scripts/verify-toll.sh", "scripts/live-checks.sh", "scripts/release-check.sh"]) {
    const result = spawnSync("bash", [script, "--help"], { encoding: "utf8" });
    assert.equal(result.status, 0, script + "\n" + result.stderr);
    assert.match(result.stdout, /Usage|usage/);
  }
});

test("base proof skips a commit compared with itself", () => {
  const out = mkdtempSync(join(tmpdir(), "toll-base-skip-"));
  const result = spawnSync(process.execPath, ["scripts/base-proof.mjs", "--base", "HEAD", "--head", "HEAD", "--out", out], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^SKIP/);
});
