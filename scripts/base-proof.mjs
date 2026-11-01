// Run the head's new tests against the base commit. Each changed test file must fail there.
// A file that passes on the base is not a proof. A run that never started (missing browsers
// or an uninstalled package) is not a proof either. Product code stays at the base commit;
// only files under tests/ are copied from the head.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "git failed").slice(0, 500));
  return result.stdout.trim();
}

function changed(root, base, head) {
  const out = git(root, ["diff", "--name-only", "--diff-filter=ACMR", base, head, "--", "tests"]);
  return out.split("\n").filter((line) => line.startsWith("tests/"));
}

function classify(status, text) {
  if (status === 0) return "passed";
  if (/Executable doesn't exist|Please run the following command to download new browsers/.test(text)) return "inconclusive";
  if (/Cannot find package '(?:playwright|typescript|express)'/.test(text)) return "inconclusive";
  if (text.includes("node_modules") && /ERR_MODULE_NOT_FOUND|Cannot find module/.test(text)) return "inconclusive";
  return "failed";
}

function report(status, reason) {
  console.log(status);
  console.log(reason);
  process.exit(status === "FAIL" ? 1 : 0);
}

const root = arg("--root") || process.cwd();
const base = arg("--base");
const head = arg("--head");
const headTree = arg("--head-tree") || root;
const outDir = arg("--out");
const nodeBin = arg("--node") || process.execPath;
const phpBin = arg("--php") || "php";

if (!base || !head || !outDir) {
  report("FAIL", "usage: base-proof.mjs --base <sha> --head <sha> --out <dir> [--root repo] [--head-tree dir] [--node bin]");
}

const baseSha = git(root, ["rev-parse", "--verify", `${base}^{commit}`]);
const headSha = git(root, ["rev-parse", "--verify", `${head}^{commit}`]);
mkdirSync(outDir, { recursive: true });

if (baseSha === headSha) report("SKIP", "base and head are the same commit");

const files = changed(root, baseSha, headSha);
const tests = files.filter((file) => file.endsWith(".test.ts") || (file.startsWith("tests/php/") && file.endsWith(".php")));
if (tests.length === 0) {
  report("SKIP", files.length === 0 ? "no files under tests/ changed" : "no test file changed");
}

const parent = mkdtempSync(join(tmpdir(), "toll-base-"));
const tree = join(parent, "wt");
let removed = false;
function cleanup() {
  if (removed) return;
  removed = true;
  spawnSync("git", ["-C", root, "worktree", "remove", "--force", tree], { encoding: "utf8" });
  rmSync(parent, { recursive: true, force: true });
}

try {
  git(root, ["worktree", "add", "--detach", tree, baseSha]);
  const modules = join(headTree, "node_modules");
  if (!existsSync(modules)) throw new Error("head tree has no node_modules");
  symlinkSync(modules, join(tree, "node_modules"), "dir");
  const vendor = join(headTree, "packages/server-php/vendor");
  if (existsSync(vendor)) symlinkSync(vendor, join(tree, "packages/server-php/vendor"), "dir");
  for (const file of files) {
    const to = join(tree, file);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(headTree, file), to);
  }

  const rows = [];
  for (const file of tests) {
    const logPath = join(outDir, file.replaceAll("/", "__") + ".log");
    const started = file.endsWith(".php")
      ? spawnSync(phpBin, [file], { cwd: tree, encoding: "utf8", timeout: 20 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 })
      : spawnSync(nodeBin, ["--test", "--test-concurrency=1", "--test-reporter=tap", file], { cwd: tree, encoding: "utf8", timeout: 20 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
    const text = `${started.stdout ?? ""}\n${started.stderr ?? ""}`;
    writeFileSync(logPath, text);
    const status = started.status === null ? 1 : started.status;
    rows.push({ file, kind: classify(status, text) });
  }

  const passed = rows.filter((row) => row.kind === "passed");
  const inconclusive = rows.filter((row) => row.kind === "inconclusive");
  cleanup();
  if (passed.length === 0 && inconclusive.length === 0) {
    report("PASS", rows.map((row) => `${row.file} failed on ${baseSha.slice(0, 12)}`).join("; "));
  }
  const bits = [];
  if (passed.length) bits.push("passed on the base: " + passed.map((row) => row.file).join(", "));
  if (inconclusive.length) bits.push("did not run: " + inconclusive.map((row) => row.file).join(", "));
  report("FAIL", bits.join("; "));
} catch (error) {
  cleanup();
  report("FAIL", error instanceof Error ? error.message : String(error));
}
