// scripts/node-path.sh finds Node 24 when PATH has Node 22 first, and under ~/.local/node24.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fakeNode(path: string, major: string, extra = "") {
  writeFileSync(
    path,
    `#!/bin/bash
if [[ "$1" == "-p" ]]; then
  echo ${major}
  exit 0
fi
${extra}
echo "fake-node-${major}"
exit 0
`,
  );
  chmodSync(path, 0o755);
}

/** PATH entries that have coreutils but no node/nodejs/node22/node24 binary. */
function pathWithoutNode(): string {
  const dir = mkdtempSync(join(tmpdir(), "bin-no-node-"));
  for (const src of ["/usr/bin", "/bin", "/usr/local/bin"]) {
    let names: string[] = [];
    try {
      names = readdirSync(src);
    } catch {
      continue;
    }
    for (const name of names) {
      if (/^node/.test(name)) continue;
      const dest = join(dir, name);
      try {
        symlinkSync(join(src, name), dest);
      } catch {
        // already present from an earlier src
      }
    }
  }
  return dir;
}

test("node-path.sh --self-check proves PATH walk, ~/.local/node24, override, and a miss", async () => {
  const child = spawn("bash", ["scripts/node-path.sh", "--self-check"], { cwd: ROOT });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr + "\n" + stdout);
  assert.match(stdout, /PATH walk PASS/);
  assert.match(stdout, /~\/\.local\/node24 PASS/);
  assert.match(stdout, /NODE_24 override PASS/);
  assert.match(stdout, /missing major FAIL as expected/);
  assert.match(stdout, /self-check: ok/);
});

test("verify-toll finds Node 24 under ~/.local/node24 when PATH has Node 22 first", () => {
  const home = mkdtempSync(join(tmpdir(), "toll-node24-home-"));
  const pathBin = mkdtempSync(join(tmpdir(), "toll-node22-path-"));
  const out = mkdtempSync(join(tmpdir(), "toll-node24-out-"));
  const safe = pathWithoutNode();
  const used = join(home, "used");
  mkdirSync(join(home, ".local/node24/bin"), { recursive: true });
  mkdirSync(join(home, ".local/node-v22.21.0/bin"), { recursive: true });
  // PATH's node is 22, so find_node 22 uses it. find_node 24 must use ~/.local/node24.
  fakeNode(join(pathBin, "node"), "22", `echo node22 >> ${JSON.stringify(used)}`);
  fakeNode(join(home, ".local/node24/bin/node"), "24", `echo node24 >> ${JSON.stringify(used)}`);
  fakeNode(join(home, ".local/node-v22.21.0/bin/node"), "22", `echo node22-local >> ${JSON.stringify(used)}`);

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${pathBin}:${safe}` };
  delete env.NODE_22;
  delete env.NODE_24;
  env.NVM_DIR = "/nonexistent";
  const result = spawnSync("bash", ["scripts/verify-toll.sh", "--only", "test", "--skip-install", "--out", out], {
    encoding: "utf8",
    cwd: ROOT,
    env,
  });
  const summary = (() => {
    try {
      return readFileSync(join(out, "SUMMARY.md"), "utf8");
    } catch {
      return "";
    }
  })();
  const usedText = (() => {
    try {
      return readFileSync(used, "utf8");
    } catch {
      return "";
    }
  })();
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr + "\n" + summary + "\nused:\n" + usedText);
  assert.match(summary, /\| test \| PASS \|/);
  assert.match(usedText, /node24/);
  assert.match(usedText, /node22/);
  assert.doesNotMatch(usedText, /node22-local/);
  rmSync(home, { recursive: true, force: true });
  rmSync(pathBin, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
  rmSync(safe, { recursive: true, force: true });
});
