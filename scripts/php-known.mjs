// Boxes whose PHP has no sodium cannot run Argon2id. Two runners are known to miss only that:
//   tests/php/run-vectors.php  — one counted failure, the hardened vector, and the rest pass
//   tests/php/run-issuer.php   — an uncaught "ext-sodium is required for Argon2id."
// Any other failure is a real fail. When sodium is present both runners must exit 0.
//
// docs/vectors.json is 34 checks (1 engine secret, 4 per work item × 3, 15 invalid work,
// 4 invalid passes, 2 valid passes). The hardened solution is the one check that calls Argon2id,
// so the counted miss is 33 passed, 1 failed. A second failure, or a different count, is not known.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const VECTORS_KNOWN = { passed: 33, failed: 1 };
export const SODIUM_ERROR = "ext-sodium is required for Argon2id.";

const FAIL_LINE = /^FAIL .+$/gm;

function failLines(text) {
  return text.match(FAIL_LINE) ?? [];
}

function summary(text) {
  const m = /PHP .*: (\d+) passed, (\d+) failed/.exec(text);
  if (!m) return null;
  return { passed: Number(m[1]), failed: Number(m[2]) };
}

/**
 * @param {{ stdout: string, stderr?: string, exitCode: number, sodium: boolean }} run
 * @returns {{ status: "PASS" | "FAIL" | "KNOWN", reason: string }}
 */
export function classifyVectorRun(run) {
  const text = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const fails = failLines(text);
  const counts = summary(text);
  if (run.exitCode === 0 && fails.length === 0) return { status: "PASS", reason: "vectors passed" };
  if (run.sodium) return { status: "FAIL", reason: "vectors failed and PHP has sodium" };
  const hardened = fails.length === 1 && /hardened account/i.test(fails[0]) && /argon2id|malformed/i.test(fails[0]);
  if (hardened && counts && counts.passed === VECTORS_KNOWN.passed && counts.failed === VECTORS_KNOWN.failed) {
    return { status: "KNOWN", reason: `PHP has no sodium; run-vectors is ${counts.passed} passed, ${counts.failed} failed on the hardened Argon2id vector` };
  }
  if (fails.length === 0 && text.includes(SODIUM_ERROR) && /^ok   /m.test(text)) {
    return { status: "KNOWN", reason: "PHP has no sodium; run-vectors stopped on Argon2id and reported no other failure" };
  }
  const got = counts ? `${counts.passed} passed, ${counts.failed} failed` : "no summary";
  return { status: "FAIL", reason: `run-vectors is not the known sodium miss (${got}, ${fails.length} FAIL line(s))` };
}

/**
 * @param {{ stdout: string, stderr?: string, exitCode: number, sodium: boolean }} run
 * @returns {{ status: "PASS" | "FAIL" | "KNOWN", reason: string }}
 */
export function classifyIssuerRun(run) {
  const text = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const fails = failLines(text);
  if (run.exitCode === 0 && fails.length === 0) return { status: "PASS", reason: "issuer passed" };
  if (run.sodium) return { status: "FAIL", reason: "issuer failed and PHP has sodium" };
  if (fails.length === 0 && text.includes(SODIUM_ERROR) && /^ok   /m.test(text)) {
    return { status: "KNOWN", reason: "PHP has no sodium; run-issuer errors on Argon2id and reported no other failure" };
  }
  return { status: "FAIL", reason: `run-issuer is not the known sodium error (${fails.length} FAIL line(s))` };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const kind = process.argv[2];
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : "";
  };
  const log = readFileSync(arg("--log"), "utf8");
  const run = { stdout: log, stderr: "", exitCode: Number(arg("--exit")), sodium: arg("--sodium") === "1" };
  const result = kind === "issuer" ? classifyIssuerRun(run) : classifyVectorRun(run);
  console.log(result.status);
  console.log(result.reason);
  process.exit(result.status === "FAIL" ? 1 : 0);
}
