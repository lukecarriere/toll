// Publish the public packages, skipping any whose exact version is already on the registry.
// A re-run after a partial failure leaves the published versions in place and continues with the rest.
// Nothing is published unless --publish is passed. The manual workflow is the caller.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export const PUBLIC_PACKAGE_DIRS = [
  "packages/widget",
  "packages/server-node",
  "packages/agent",
  "packages/mcp",
].map((dir) => resolve(root, dir));

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** True when this file is the process entrypoint (not an import from a test). */
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(realpathSync(entry)).href;
}

/** Version document URL. The scope slash is encoded; the leading @ stays. */
export function versionUrl(registry, name, version) {
  const base = registry.replace(/\/$/, "");
  return `${base}/${name.replaceAll("/", "%2f")}/${version}`;
}

/**
 * Whether `name@version` is already on `registry`.
 * 404 means absent. Any other non-200 fails the lookup so a publish is not attempted.
 */
export async function versionOnRegistry(name, version, { registry = DEFAULT_REGISTRY, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(versionUrl(registry, name, version), { headers: { accept: "application/json" } });
  if (res.status === 404) return false;
  if (res.status !== 200) {
    throw new Error(`publish: registry lookup for ${name}@${version} returned ${res.status}`);
  }
  const body = await res.json();
  if (body?.version !== version) {
    throw new Error(`publish: registry lookup for ${name}@${version} returned version ${body?.version ?? "(none)"}`);
  }
  return true;
}

/**
 * For each package directory, skip when that exact version is on the registry.
 * `publish: false` only reports the decision. `run` replaces `npm publish` in tests.
 */
export async function publishMissing(dirs, { registry, fetchImpl, publish = false, run } = {}) {
  const lines = [];
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
    const present = await versionOnRegistry(pkg.name, pkg.version, { registry, fetchImpl });
    if (present) {
      const line = `publish: ${pkg.name}@${pkg.version} is already on the registry; skipping`;
      console.log(line);
      lines.push(line);
      continue;
    }
    if (!publish) {
      const line = `publish: ${pkg.name}@${pkg.version} is not on the registry; not publishing`;
      console.log(line);
      lines.push(line);
      continue;
    }
    const line = `publish: ${pkg.name}@${pkg.version} is not on the registry; publishing`;
    console.log(line);
    lines.push(line);
    if (run) await run(dir, pkg);
    else execFileSync("npm", ["publish", "--provenance"], { cwd: resolve(dir), stdio: "inherit" });
  }
  return lines;
}

function positionalArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--registry") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    out.push(arg);
  }
  return out;
}

async function main() {
  const publish = process.argv.includes("--publish");
  const registryIndex = process.argv.indexOf("--registry");
  const registry = registryIndex >= 0 ? process.argv[registryIndex + 1] : undefined;
  if (registryIndex >= 0 && !registry) throw new Error("publish: --registry needs a URL");
  const positional = positionalArgs(process.argv.slice(2));
  const dirs = positional.length ? positional.map((dir) => resolve(dir)) : PUBLIC_PACKAGE_DIRS;
  await publishMissing(dirs, { publish, registry });
}

if (invokedDirectly()) {
  await main();
}
