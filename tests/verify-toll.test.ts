// Pins for the verification scripts: known PHP misses, release matching, redaction, and --help.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore plain JS module
import { classifyIssuerRun, classifyVectorRun, countsAddUp, SODIUM_ERROR } from "../scripts/php-known.mjs";
// @ts-ignore plain JS module
import { commitInMessage, judgeRelease, previousVersionId } from "../scripts/release-match.mjs";
// @ts-ignore plain JS module
import { redact } from "../scripts/live-checks.mjs";

const hardened = "FAIL solution accepted: hardened account (Argon2id t=2 m=8192 p=1, counter 3) (malformed)";

function vectorLog(passed: number, failLine: string, extraOk = 0): string {
  const oks = Array.from({ length: passed + extraOk }, (_, i) => `ok   check ${i}`).join("\n");
  return `${oks}\n${failLine}\n\nPHP 8.3.6: ${passed} passed, 1 failed\n`;
}

test("run-vectors: 32/1 and 33/1 Argon2id misses are KNOWN, and another FAIL is not", () => {
  for (const passed of [32, 33]) {
    const stdout = vectorLog(passed, hardened);
    const known = classifyVectorRun({ stdout, exitCode: 1, sodium: false });
    assert.equal(known.status, "KNOWN", stdout);
    assert.match(known.reason, new RegExp(`${passed} passed, 1 failed`));
    assert.equal(classifyVectorRun({ stdout, exitCode: 1, sodium: true }).status, "FAIL");
  }
  // The engine-secret check is printed before run-vectors.php resets its counters.
  const early = `ok   engine secrets derive from the Toll secret\n${vectorLog(32, hardened)}`;
  assert.equal(classifyVectorRun({ stdout: early, exitCode: 1, sodium: false }).status, "KNOWN");
  const other = vectorLog(32, "FAIL solution accepted: standard write (bad)");
  assert.equal(classifyVectorRun({ stdout: other, exitCode: 1, sodium: false }).status, "FAIL");
  const both = vectorLog(31, hardened + "\nFAIL solution accepted: standard write (bad)");
  assert.equal(classifyVectorRun({ stdout: both.replace("31 passed, 1 failed", "31 passed, 2 failed"), exitCode: 1, sodium: false }).status, "FAIL");
  const drifted = vectorLog(32, hardened).replace("32 passed", "31 passed");
  assert.equal(classifyVectorRun({ stdout: drifted, exitCode: 1, sodium: false }).status, "FAIL");
  assert.equal(countsAddUp(early, { passed: 32, failed: 1, skipped: 0 }, [hardened]), true);
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

function fakeBin(dir: string, name: string, body: string) {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function summaryOf(out: string) {
  return readFileSync(join(out, "SUMMARY.md"), "utf8");
}

test("verify-toll php: 32/1 with no sodium is KNOWN, a non-Argon2 FAIL stays FAIL, and SUMMARY.md is written", () => {
  const fake = mkdtempSync(join(tmpdir(), "toll-php-bin-"));
  const knownOut = mkdtempSync(join(tmpdir(), "toll-php-known-"));
  const failOut = mkdtempSync(join(tmpdir(), "toll-php-fail-"));
  const oks = ["ok   engine secrets derive from the Toll secret", ...Array.from({ length: 32 }, (_, i) => `ok   check ${i}`)].join("\n");
  const knownLog = `${oks}\nFAIL solution accepted: hardened account (Argon2id t=2 m=8192 p=1, counter 3) (malformed)\n\nPHP 8.3.6: 32 passed, 1 failed\n`;
  const otherOks = Array.from({ length: 31 }, (_, i) => `ok   check ${i}`).join("\n");
  const otherLog = `${otherOks}\nFAIL solution accepted: standard write (bad)\n\nPHP 8.3.6: 31 passed, 1 failed\n`;
  writeFileSync(join(fake, "known.log"), knownLog);
  writeFileSync(join(fake, "other.log"), otherLog);
  fakeBin(fake, "php", `#!/bin/bash
if [[ "$1" == "-r" ]]; then exit 1; fi
base="$(basename "$1")"
case "$base" in
  run-vectors.php)
    cat "$FAIL_LOG"
    exit 1
    ;;
  run-issuer.php)
    printf 'ok   policy\\nPHP Fatal error: Uncaught RuntimeException: ext-sodium is required for Argon2id.\\n'
    exit 255
    ;;
  *)
    printf '\\nPHP 8.3.6: 1 passed, 0 failed\\n'
    exit 0
    ;;
esac
`);
  const home = mkdtempSync(join(tmpdir(), "toll-php-home-"));
  const known = spawnSync("bash", ["scripts/verify-toll.sh", "--only", "php", "--out", knownOut], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${fake}:${process.env.PATH}`, FAIL_LOG: join(fake, "known.log") },
  });
  assert.equal(known.status, 0, known.stdout + known.stderr);
  assert.match(summaryOf(knownOut), /overall: PASS/);
  assert.match(summaryOf(knownOut), /\| php \| KNOWN \|/);
  const failed = spawnSync("bash", ["scripts/verify-toll.sh", "--only", "php", "--out", failOut], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${fake}:${process.env.PATH}`, FAIL_LOG: join(fake, "other.log") },
  });
  assert.notEqual(failed.status, 0);
  assert.match(summaryOf(failOut), /overall: FAIL/);
  assert.match(summaryOf(failOut), /\| php \| FAIL \|/);
  rmSync(fake, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(knownOut, { recursive: true, force: true });
  rmSync(failOut, { recursive: true, force: true });
});

test("verify-toll php: a php in HOME/.local/bin does not hide a non-Argon2 FAIL on PATH", () => {
  const home = mkdtempSync(join(tmpdir(), "toll-shadow-home-"));
  const pathBin = mkdtempSync(join(tmpdir(), "toll-shadow-path-"));
  const out = mkdtempSync(join(tmpdir(), "toll-shadow-out-"));
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  const knownLog = join(home, "known.log");
  const otherLog = join(home, "other.log");
  const oks = ["ok   engine secrets derive from the Toll secret", ...Array.from({ length: 32 }, (_, i) => `ok   check ${i}`)].join("\n");
  writeFileSync(knownLog, `${oks}\nFAIL solution accepted: hardened account (Argon2id t=2 m=8192 p=1, counter 3) (malformed)\n\nPHP 8.3.6: 32 passed, 1 failed\n`);
  const otherOks = Array.from({ length: 31 }, (_, i) => `ok   check ${i}`).join("\n");
  writeFileSync(otherLog, `${otherOks}\nFAIL solution accepted: standard write (bad)\n\nPHP 8.3.6: 31 passed, 1 failed\n`);
  const phpBody = (log: string) => `#!/bin/bash
if [[ "$1" == "-r" ]]; then exit 1; fi
base="$(basename "$1")"
case "$base" in
  run-vectors.php) cat ${JSON.stringify(log)}; exit 1 ;;
  run-issuer.php)
    printf 'ok   policy\\nPHP Fatal error: Uncaught RuntimeException: ext-sodium is required for Argon2id.\\n'
    exit 255 ;;
  *) printf '\\nPHP 8.3.6: 1 passed, 0 failed\\n'; exit 0 ;;
esac
`;
  fakeBin(join(home, ".local/bin"), "php", phpBody(knownLog));
  fakeBin(pathBin, "php", phpBody(otherLog));
  const result = spawnSync("bash", ["scripts/verify-toll.sh", "--only", "php", "--out", out], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${pathBin}:${process.env.PATH}` },
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  const summary = summaryOf(out);
  assert.match(summary, /overall: FAIL/);
  assert.match(summary, /run-vectors=FAIL/);
  rmSync(home, { recursive: true, force: true });
  rmSync(pathBin, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

test("verify-toll finds the highest Node 22 under nvm when PATH has another major", () => {
  const home = mkdtempSync(join(tmpdir(), "toll-nvm-home-"));
  const pathBin = mkdtempSync(join(tmpdir(), "toll-nvm-path-"));
  const out = mkdtempSync(join(tmpdir(), "toll-nvm-out-"));
  const used = join(home, "used");
  for (const [version, code] of [["v22.9.0", 1], ["v22.23.4", 0]] as const) {
    const dir = join(home, ".nvm/versions/node", version, "bin");
    mkdirSync(dir, { recursive: true });
    fakeBin(dir, "node", `#!/bin/bash
echo ${version} >> ${JSON.stringify(used)}
exit ${code}
`);
  }
  fakeBin(pathBin, "node", `#!/bin/bash
if [[ "$1" == "-p" ]]; then echo 24; exit 0; fi
echo path-node >> ${JSON.stringify(used)}
exit 1
`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${pathBin}:/usr/bin:/bin` };
  delete env.NODE_22;
  delete env.NODE_24;
  delete env.NVM_DIR;
  const result = spawnSync("bash", ["scripts/verify-toll.sh", "--only", "mutants", "--out", out], {
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(summaryOf(out), /\| mutants \| PASS \|/);
  const hits = readFileSync(used, "utf8");
  assert.match(hits, /v22\.23\.4/);
  assert.doesNotMatch(hits, /v22\.9\.0/);
  assert.doesNotMatch(hits, /path-node/);
  rmSync(home, { recursive: true, force: true });
  rmSync(pathBin, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

test("verify-toll lint: one fetch-body failure fails the step", () => {
  const fake = mkdtempSync(join(tmpdir(), "toll-node-bin-"));
  const out = mkdtempSync(join(tmpdir(), "toll-lint-fail-"));
  fakeBin(fake, "node", `#!/bin/bash
if [[ "$*" == *fetch-body-lint.mjs* ]]; then
  echo "simulated fetch-body violation" >&2
  exit 1
fi
exec ${JSON.stringify(process.execPath)} "$@"
`);
  const result = spawnSync("bash", ["scripts/verify-toll.sh", "--only", "lint", "--out", out], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fake}:${process.env.PATH}` },
  });
  assert.notEqual(result.status, 0);
  const summary = summaryOf(out);
  assert.match(summary, /overall: FAIL/);
  assert.match(summary, /\| lint \| FAIL \|/);
  assert.match(summary, /fetch=1/);
  rmSync(fake, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

test("verify-toll install: npm ci failure is FAIL, and a --with-deps failure can fall back", () => {
  const fake = mkdtempSync(join(tmpdir(), "toll-install-bin-"));
  const failOut = mkdtempSync(join(tmpdir(), "toll-install-fail-"));
  const fallOut = mkdtempSync(join(tmpdir(), "toll-install-fall-"));
  const bothOut = mkdtempSync(join(tmpdir(), "toll-install-both-"));
  fakeBin(fake, "node", `#!/bin/bash
exec ${JSON.stringify(process.execPath)} "$@"
`);
  fakeBin(fake, "npm", `#!/bin/bash
if [[ "$1" == "ci" && "$NPM_CI_FAIL" == 1 ]]; then
  echo "simulated npm ci failure" >&2
  exit 1
fi
exit 0
`);
  fakeBin(fake, "composer", "#!/bin/bash\nexit 0\n");
  fakeBin(fake, "npx", `#!/bin/bash
if [[ "$*" == *--with-deps* ]]; then
  echo "apt mirror 500" >&2
  exit 1
fi
if [[ "$PW_FAIL" == 1 ]]; then
  echo "browser install failed" >&2
  exit 1
fi
echo "installed chromium"
exit 0
`);
  fakeBin(fake, "php", "#!/bin/bash\necho 'PHP 8.3.6'\nexit 0\n");
  const env = { ...process.env, PATH: `${fake}:${process.env.PATH}` };
  const ciFail = spawnSync("bash", ["scripts/verify-toll.sh", "--only", "install", "--out", failOut], {
    encoding: "utf8",
    env: { ...env, NPM_CI_FAIL: "1" },
  });
  assert.notEqual(ciFail.status, 0);
  assert.match(summaryOf(failOut), /\| install \| FAIL \|/);
  assert.match(summaryOf(failOut), /npm=1/);
  const fallback = spawnSync("bash", ["scripts/verify-toll.sh", "--only", "install", "--out", fallOut], {
    encoding: "utf8",
    env,
  });
  assert.equal(fallback.status, 0, fallback.stdout + fallback.stderr);
  assert.match(summaryOf(fallOut), /\| install \| PASS \|/);
  assert.match(readFileSync(join(fallOut, "install.log"), "utf8"), /without system packages/);
  const both = spawnSync("bash", ["scripts/verify-toll.sh", "--only", "install", "--out", bothOut], {
    encoding: "utf8",
    env: { ...env, PW_FAIL: "1" },
  });
  assert.notEqual(both.status, 0);
  assert.match(summaryOf(bothOut), /\| install \| FAIL \|/);
  assert.match(summaryOf(bothOut), /playwright=1/);
  rmSync(fake, { recursive: true, force: true });
  rmSync(failOut, { recursive: true, force: true });
  rmSync(fallOut, { recursive: true, force: true });
  rmSync(bothOut, { recursive: true, force: true });
});

test("base proof skips a commit compared with itself", () => {
  const out = mkdtempSync(join(tmpdir(), "toll-base-skip-"));
  const result = spawnSync(process.execPath, ["scripts/base-proof.mjs", "--base", "HEAD", "--head", "HEAD", "--out", out], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^SKIP/);
});
