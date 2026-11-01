// Boxes whose PHP has no sodium cannot run Argon2id. Two runners are known to miss only that:
//   tests/php/run-vectors.php  — FAIL lines are the Argon2id vector, and the summary adds up
//   tests/php/run-issuer.php   — an uncaught "ext-sodium is required for Argon2id."
// Any other failure is a real fail. When sodium is present both runners must exit 0.
//
// The counted total is whatever this PHP run printed. Do not require 32 or 33. run-vectors.php
// calls check() for the engine secret and then assigns $pass = 0 and $fail = 0, so one ok line
// is not in the summary. passed + failed + skipped may be one less than the ok, FAIL, and SKIP lines.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SODIUM_ERROR = "ext-sodium is required for Argon2id.";

const FAIL_LINE = /^FAIL .+$/gm;
const OK_LINE = /^ok   .+$/gm;
const SKIP_LINE = /^SKIP .+$/gm;

function failLines(text) {
  return text.match(FAIL_LINE) ?? [];
}

function lineCount(text, pattern) {
  return text.match(pattern)?.length ?? 0;
}

function summary(text) {
  const m = /PHP .*: (\d+) passed, (\d+) failed(?:, (\d+) skipped)?/.exec(text);
  if (!m) return null;
  return { passed: Number(m[1]), failed: Number(m[2]), skipped: m[3] ? Number(m[3]) : 0 };
}

function isSodiumVector(line) {
  return /argon2id|sodium/i.test(line);
}

const ENGINE_SECRET_OK = /^ok   engine secrets derive from the Toll secret$/m;

/** The summary's passed, failed, and skipped match the lines, allowing the one uncounted engine-secret ok. */
export function countsAddUp(text, counts, fails) {
  const oks = lineCount(text, OK_LINE);
  const skips = lineCount(text, SKIP_LINE);
  if (fails.length !== counts.failed || skips !== counts.skipped) return false;
  if (oks === counts.passed) return true;
  return oks === counts.passed + 1 && counts.skipped === 0 && ENGINE_SECRET_OK.test(text);
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
  const sodiumVectors = fails.length > 0 && fails.every(isSodiumVector);
  if (sodiumVectors && counts && counts.failed > 0 && countsAddUp(text, counts, fails)) {
    const skipped = counts.skipped ? `, ${counts.skipped} skipped` : "";
    return {
      status: "KNOWN",
      reason: `PHP has no sodium; every FAIL line is an Argon2id vector (${counts.passed} passed, ${counts.failed} failed${skipped})`,
    };
  }
  if (fails.length === 0 && text.includes(SODIUM_ERROR) && /^ok   /m.test(text)) {
    return { status: "KNOWN", reason: "PHP has no sodium; run-vectors stopped on Argon2id and reported no other failure" };
  }
  const got = counts ? `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped` : "no summary";
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
