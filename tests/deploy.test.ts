// scripts/deploy.sh: refuses a missing SHA, a dirty tree, an unpinned HEAD, and a non-main commit
// before running anything; --dry-run never calls a real `wrangler deploy`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "deploy.sh");
const LIVE = "11111111-2222-3333-4444-555555555555";

function sh(cwd: string, ...args: string[]) {
  const r = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `${args.join(" ")}\n${r.stderr}`);
  return r.stdout.trim();
}

function exe(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** A throwaway repo holding deploy.sh, with fake npm/npx/composer that only log their calls. */
function sandbox(opts: { failTest?: boolean } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "toll-deploy-repo-"));
  const bin = mkdtempSync(join(tmpdir(), "toll-deploy-bin-"));
  const calls = join(bin, "calls.log");
  mkdirSync(join(repo, "scripts"));
  mkdirSync(join(repo, "packages", "server-php"), { recursive: true });
  copyFileSync(SCRIPT, join(repo, "scripts", "deploy.sh"));
  exe(join(repo, "scripts", "live-checks.sh"), `#!/bin/bash\necho "live-checks $*" >>"$CALLS"\n`);
  exe(join(repo, "scripts", "verify-toll.sh"), `#!/bin/bash\necho "verify-toll $*" >>"$CALLS"\n${opts.failTest ? "echo 'test FAIL'; exit 1\n" : ""}`);
  writeFileSync(join(repo, "wrangler.toml"), 'name = "toll-site"\n');
  writeFileSync(join(repo, "packages", "server-php", "composer.json"), "{}\n");
  writeFileSync(join(repo, ".gitignore"), "/.verify-toll/\n");
  exe(join(bin, "npm"), `#!/bin/bash\necho "npm $*" >>"$CALLS"\n`);
  exe(join(bin, "composer"), `#!/bin/bash\necho "composer $*" >>"$CALLS"\n`);
  exe(join(bin, "npx"), `#!/bin/bash
echo "npx $*" >>"$CALLS"
if [[ "$1 $2 $3" == "wrangler deployments status" ]]; then
  echo '{"versions":[{"version_id":"${LIVE}","percentage":100}]}'
fi
`);
  sh(repo, "git", "init", "-q", "-b", "main");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  const sha = sh(repo, "git", "rev-parse", "HEAD");
  sh(repo, "git", "update-ref", "refs/remotes/origin/main", sha);
  const run = (...args: string[]) =>
    spawnSync("bash", [join(repo, "scripts", "deploy.sh"), ...args, "--out", join(repo, ".verify-toll", "t")], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls },
    });
  const log = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
  return { repo, sha, run, log };
}

test("deploy.sh refuses when --sha is missing, before installing anything", () => {
  const s = sandbox();
  const r = s.run("--dry-run");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /REFUSED: --sha/);
  assert.equal(s.log(), "");
});

test("deploy.sh refuses a dirty tree, before installing anything", () => {
  const s = sandbox();
  writeFileSync(join(s.repo, "wrangler.toml"), 'name = "edited"\n');
  const r = s.run("--sha", s.sha, "--dry-run");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /REFUSED: the worktree is dirty/);
  assert.equal(s.log(), "");
});

test("deploy.sh refuses a HEAD that is not the pinned SHA, and a non-main commit without --allow-branch", () => {
  const s = sandbox();
  sh(s.repo, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "next");
  const pinnedOld = s.run("--sha", s.sha, "--dry-run");
  assert.notEqual(pinnedOld.status, 0);
  assert.match(pinnedOld.stderr, /REFUSED: HEAD is/);
  const head = sh(s.repo, "git", "rev-parse", "HEAD");
  const offMain = s.run("--sha", head, "--dry-run");
  assert.notEqual(offMain.status, 0);
  assert.match(offMain.stderr, /REFUSED: .* is not origin\/main/);
  assert.equal(s.log(), "");
  const allowed = s.run("--sha", head, "--dry-run", "--allow-branch");
  assert.equal(allowed.status, 0, allowed.stderr);
});

test("deploy.sh --dry-run runs install, build, the verify-toll gate, wrangler deploy --dry-run and free live checks only", () => {
  const s = sandbox();
  const r = s.run("--sha", s.sha, "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  const calls = s.log();
  for (const want of ["npm ci", "npm run build", "composer install", "verify-toll --ref", "--only typecheck,lint,test,php", "npx wrangler deployments status", "npx wrangler deploy --dry-run", "live-checks --base"]) {
    assert.ok(calls.includes(want), `missing ${want}\n${calls}`);
  }
  const deploys = calls.split("\n").filter((l) => /^npx wrangler deploy( |$)/.test(l));
  assert.ok(deploys.every((l) => l.includes("--dry-run")), calls);
  assert.match(r.stdout, new RegExp(`rollback target \\(live now\\): ${LIVE}`));
  assert.match(r.stdout, new RegExp(`npx wrangler rollback ${LIVE} --name toll-site`));
});

test("deploy.sh exits non-zero on a failing step and prints the rollback command", () => {
  const s = sandbox({ failTest: true });
  const r = s.run("--sha", s.sha, "--dry-run");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /FAILED at step: verify/);
  assert.match(r.stderr, /Rollback \(not run\): npx wrangler rollback/);
  assert.equal(s.log().includes("wrangler deploy"), false);
});
