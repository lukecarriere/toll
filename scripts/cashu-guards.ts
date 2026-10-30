// Repeat mistakes, locked in the source rather than in a test that can be rewritten to match.
//
// cashuA was refused as not a payment in #20 (bbeb17c) and again in #21 (5ef8dbd): a gate
// required the cashuB prefix, or a cashuA string was dropped. decodeTokenV4 and testMintPayer
// are the two checks that are cashuB on purpose. decodeTokenV4 reads only a V4 string.
// testMintPayer reads the local POST /test/mint response, which issues cashuB.
//
// abort() deleted blinded outputs while the mint still held the signatures. Verifier FAILs on
// #22: b73440c, 1e169dd, fcba824, 75e1f21, f626e44. abort() is allowed once, and only when
// restore came back empty and every input is UNSPENT. lose() is not a way to balance the books.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface GuardHit {
  file: string;
  line: number;
  rule: string;
}

const ROOT = new URL("..", import.meta.url).pathname;

/** Inbound gates that may require the cashuB prefix. Not payment acceptance. */
const V4_ONLY: Readonly<Record<string, ReadonlySet<string>>> = {
  "packages/settlement-ln/src/cashu.ts": new Set(["decodeTokenV4"]),
  "packages/agent/src/index.ts": new Set(["testMintPayer"]),
};

const FN = /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
const CASHU_B = /(?:[\w$.]+\.)?startsWith\(\s*["']cashuB["']\s*\)|str_starts_with\(\s*\$\w+\s*,\s*["']cashuB["']\s*\)/;
const ABORT_IF = /^if\s*\(\s*empty\s*&&\s*!unclear\s*&&\s*state\s*===\s*"unspent"\s*\)\s*\{?$/;

function enclosingFunction(text: string, upto: number): string {
  const head = text.slice(0, upto);
  let name = "";
  for (const m of head.matchAll(FN)) name = m[1] ?? "";
  return name;
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#");
}

/** A cashuA string dropped, or refused as malformed, instead of paid. */
export function refusesCashuA(line: string): boolean {
  if (isComment(line)) return false;
  const kindA = /['"]kind['"]\s*\]\s*===\s*['"]a['"]/.test(line) || /(?<![\w$])kind\s*===\s*['"]a['"]/.test(line);
  if (kindA && /malformed/.test(line)) return true;
  if (/str_starts_with\(\s*\$\w+\s*,\s*['"]cashuA['"]/.test(line) && !line.includes("cashuB") && !line.includes("token")) return true;
  // `if (t.startsWith("cashuA")) return { kind: "a" }` drops the string. A line that also
  // names cashuB, or that returns the token, is the shared decoder.
  if (/(?:[\w$.]+\.)?startsWith\(\s*["']cashuA["']\s*\)/.test(line) && !line.includes("cashuB") && !line.includes("token")) return true;
  return false;
}

/** Lines that accept only cashuB, or that refuse cashuA. `file` is the repo-relative path. */
export function tokenHits(file: string, text: string): GuardHit[] {
  const hits: GuardHit[] = [];
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!isComment(line) && CASHU_B.test(line) && !line.includes("cashuA")) {
      const fn = enclosingFunction(text, offset);
      if (!V4_ONLY[file]?.has(fn)) hits.push({ file, line: i + 1, rule: "cashuB-only gate" });
    }
    if (refusesCashuA(line)) hits.push({ file, line: i + 1, rule: "cashuA is not a payment" });
    offset += line.length + 1;
  }
  return hits;
}

/**
 * abort() once, gated on an empty restore and an unspent check. lose() is a hit.
 * The text is the whole cashu-receive.ts source.
 */
export function conservationHits(text: string, file = "packages/settlement-ln/src/cashu-receive.ts"): GuardHit[] {
  const lines = text.split("\n");
  const hits: GuardHit[] = [];
  const aborts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isComment(line)) continue;
    if (line.includes(".lose(")) hits.push({ file, line: i + 1, rule: "lose() drops outputs the mint may hold" });
    if (line.includes(".abort(")) aborts.push(i);
  }
  if (aborts.length > 1) {
    for (const i of aborts) hits.push({ file, line: i + 1, rule: "more than one abort()" });
  }
  for (const i of aborts) {
    let j = i - 1;
    while (j >= 0 && ((lines[j] ?? "").trim() === "" || isComment(lines[j] ?? ""))) j--;
    const cond = (lines[j] ?? "").trim();
    if (!ABORT_IF.test(cond)) hits.push({ file, line: i + 1, rule: "abort() is not gated on an empty restore and an unspent check" });
  }
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "vendor" || name === "dist") continue;
    const abs = join(dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(abs, out);
    else if (name.endsWith(".ts") || name.endsWith(".php")) out.push(abs);
  }
  return out;
}

/** Hits in packages/. Empty on main. */
export function treeHits(root = ROOT): GuardHit[] {
  const hits: GuardHit[] = [];
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  for (const abs of walk(join(base, "packages"))) {
    const file = abs.slice(base.length + 1);
    const text = readFileSync(abs, "utf8");
    hits.push(...tokenHits(file, text));
    if (file === "packages/settlement-ln/src/cashu-receive.ts") hits.push(...conservationHits(text, file));
  }
  return hits;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const hits = treeHits();
  if (hits.length > 0) {
    for (const h of hits) console.error(`${h.file}:${h.line}: ${h.rule}`);
    console.error(`cashu-guards: ${hits.length} hit(s)`);
    process.exit(1);
  }
  console.log("cashu-guards: 0 hits");
}
