// The manual publish skips a package when that exact version is already on the registry,
// and it does not publish unless --publish is passed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  PUBLIC_PACKAGE_DIRS,
  publishMissing,
  versionUrl,
} from "../scripts/publish-missing.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/publish.yml"), "utf8");

test("publish workflow is manual, passes the npm token on the job, and publishes through the skip script", () => {
  assert.match(WORKFLOW, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(WORKFLOW, /pull_request:/);
  assert.doesNotMatch(WORKFLOW, /^\s*push:/m);
  assert.match(WORKFLOW, / {2}publish:\n {4}runs-on: ubuntu-latest\n {4}env:\n {6}NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}\n/);
  assert.doesNotMatch(WORKFLOW, /npm publish/);
  for (const dir of ["packages/widget", "packages/server-node", "packages/agent", "packages/mcp"]) {
    assert.match(WORKFLOW, new RegExp(`node scripts/publish-missing\\.mjs --publish ${dir}`));
  }
});

test("the four public package directories are the @lessspam packages", () => {
  const names = PUBLIC_PACKAGE_DIRS.map((dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name);
  assert.deepEqual(names, ["@lessspam/widget", "@lessspam/server", "@lessspam/agent", "@lessspam/mcp"]);
});

function packageDir(name: string, version: string) {
  const dir = mkdtempSync(join(tmpdir(), "publish-missing-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
  return dir;
}

/** Local stand-in for the registry. Keys are request paths. */
async function registryServer(routes: Record<string, { status: number; body?: unknown }>) {
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    const route = routes[path] ?? { status: 500, body: { error: "unexpected " + path } };
    res.writeHead(route.status, { "content-type": "application/json" });
    res.end(route.body === undefined ? "" : JSON.stringify(route.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    registry: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

test("an exact version already on the registry is skipped and npm publish is not run", async () => {
  const dir = packageDir("@lessspam/widget", "0.1.0");
  const registry = await registryServer({
    [new URL(versionUrl("http://registry.test", "@lessspam/widget", "0.1.0")).pathname]: {
      status: 200,
      body: { version: "0.1.0" },
    },
  });
  const published: string[] = [];
  try {
    const lines = await publishMissing([dir], {
      registry: registry.registry,
      publish: true,
      run: (pkgDir) => { published.push(pkgDir); },
    });
    assert.deepEqual(lines, ["publish: @lessspam/widget@0.1.0 is already on the registry; skipping"]);
    assert.deepEqual(published, []);
  } finally {
    await registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing version is reported and left unpublished unless --publish is passed", async () => {
  const dir = packageDir("@lessspam/server", "0.1.0");
  const path = new URL(versionUrl("http://registry.test", "@lessspam/server", "0.1.0")).pathname;
  const registry = await registryServer({ [path]: { status: 404, body: { error: "Not found" } } });
  const published: string[] = [];
  try {
    const lines = await publishMissing([dir], {
      registry: registry.registry,
      publish: false,
      run: (pkgDir) => { published.push(pkgDir); },
    });
    assert.deepEqual(lines, ["publish: @lessspam/server@0.1.0 is not on the registry; not publishing"]);
    assert.deepEqual(published, []);
  } finally {
    await registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing version with --publish runs npm publish --provenance for that package only", async () => {
  const present = packageDir("@lessspam/widget", "0.1.0");
  const missing = packageDir("@lessspam/server", "0.1.0");
  const routes: Record<string, { status: number; body?: unknown }> = {
    [new URL(versionUrl("http://registry.test", "@lessspam/widget", "0.1.0")).pathname]: { status: 200, body: { version: "0.1.0" } },
    [new URL(versionUrl("http://registry.test", "@lessspam/server", "0.1.0")).pathname]: { status: 404, body: { error: "Not found" } },
  };
  const registry = await registryServer(routes);
  const published: Array<{ dir: string; args: string[] }> = [];
  try {
    const lines = await publishMissing([present, missing], {
      registry: registry.registry,
      publish: true,
      run: (dir) => { published.push({ dir, args: ["publish", "--provenance"] }); },
    });
    assert.deepEqual(lines, [
      "publish: @lessspam/widget@0.1.0 is already on the registry; skipping",
      "publish: @lessspam/server@0.1.0 is not on the registry; publishing",
    ]);
    assert.deepEqual(published.map((call) => call.dir), [missing]);
  } finally {
    await registry.close();
    rmSync(present, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
  }
});

test("a registry error stops the run before npm publish", async () => {
  const dir = packageDir("@lessspam/agent", "0.1.0");
  const path = new URL(versionUrl("http://registry.test", "@lessspam/agent", "0.1.0")).pathname;
  const registry = await registryServer({ [path]: { status: 500, body: { error: "unavailable" } } });
  const published: string[] = [];
  try {
    await assert.rejects(
      () => publishMissing([dir], {
        registry: registry.registry,
        publish: true,
        run: (pkgDir) => { published.push(pkgDir); },
      }),
      /returned 500/,
    );
    assert.deepEqual(published, []);
  } finally {
    await registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a version document for a different version does not count as published", async () => {
  const dir = packageDir("@lessspam/mcp", "0.1.0");
  const path = new URL(versionUrl("http://registry.test", "@lessspam/mcp", "0.1.0")).pathname;
  const registry = await registryServer({ [path]: { status: 200, body: { version: "0.0.1" } } });
  const published: string[] = [];
  try {
    await assert.rejects(
      () => publishMissing([dir], {
        registry: registry.registry,
        publish: true,
        run: (pkgDir) => { published.push(pkgDir); },
      }),
      /returned version 0\.0\.1/,
    );
    assert.deepEqual(published, []);
  } finally {
    await registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** `npm` on PATH records its arguments and working directory, then fails. It does not publish. */
function fakeNpm() {
  const bin = mkdtempSync(join(tmpdir(), "publish-missing-npm-"));
  const marker = join(bin, "called.txt");
  writeFileSync(join(bin, "npm"), `#!/bin/sh\npwd > ${JSON.stringify(marker)}\nprintf '%s\\n' "$@" >> ${JSON.stringify(marker)}\nexit 99\n`);
  chmodSync(join(bin, "npm"), 0o755);
  return { bin, marker };
}

function runCli(args: string[], pathBin: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, "scripts/publish-missing.mjs"), ...args], {
      env: { ...process.env, PATH: `${pathBin}:${process.env.PATH ?? ""}` },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("cli --publish does not invoke npm when that exact version is already on the registry", async () => {
  const dir = packageDir("@lessspam/widget", "0.1.0");
  const path = new URL(versionUrl("http://registry.test", "@lessspam/widget", "0.1.0")).pathname;
  const registry = await registryServer({ [path]: { status: 200, body: { version: "0.1.0" } } });
  const npm = fakeNpm();
  try {
    const result = await runCli(["--publish", "--registry", registry.registry, dir], npm.bin);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /publish: @lessspam\/widget@0\.1\.0 is already on the registry; skipping/);
    assert.equal(existsSync(npm.marker), false);
  } finally {
    await registry.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(npm.bin, { recursive: true, force: true });
  }
});

test("cli --publish invokes npm publish --provenance only for a version the registry does not have", async () => {
  const present = packageDir("@lessspam/widget", "0.1.0");
  const missing = packageDir("@lessspam/server", "0.1.0");
  const routes: Record<string, { status: number; body?: unknown }> = {
    [new URL(versionUrl("http://registry.test", "@lessspam/widget", "0.1.0")).pathname]: { status: 200, body: { version: "0.1.0" } },
    [new URL(versionUrl("http://registry.test", "@lessspam/server", "0.1.0")).pathname]: { status: 404, body: { error: "Not found" } },
  };
  const registry = await registryServer(routes);
  const npm = fakeNpm();
  try {
    const result = await runCli(["--publish", "--registry", registry.registry, present, missing], npm.bin);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /publish: @lessspam\/widget@0\.1\.0 is already on the registry; skipping/);
    assert.match(result.stdout, /publish: @lessspam\/server@0\.1\.0 is not on the registry; publishing/);
    const [cwd, ...args] = readFileSync(npm.marker, "utf8").trim().split("\n");
    assert.equal(cwd, missing);
    assert.deepEqual(args, ["publish", "--provenance"]);
  } finally {
    await registry.close();
    rmSync(present, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
    rmSync(npm.bin, { recursive: true, force: true });
  }
});
