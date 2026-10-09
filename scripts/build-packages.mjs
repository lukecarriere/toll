// Builds the four public packages (@lessspam/widget, server, agent, mcp).
// esbuild bundles protocol, work-adapter and settlement into each Node entry
// (ESM, platform node, package deps external). tsc emits .d.ts only.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsc = join(root, "node_modules/typescript/bin/tsc");
const pkg = (name) => join(root, "packages", name);

const bundle = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  legalComments: "none",
  minifyWhitespace: true,
  logLevel: "warning",
};

function emitTypes(dir) {
  execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.build.json")], { cwd: dir, stdio: "inherit" });
}

const widgetDist = join(pkg("widget"), "dist");
rmSync(join(widgetDist, "index.js"), { force: true });
rmSync(join(widgetDist, "types"), { recursive: true, force: true });
await build({ ...bundle, entryPoints: [join(pkg("widget"), "src/files.ts")], outfile: join(widgetDist, "index.js") });
emitTypes(pkg("widget"));
console.log("packages: @lessspam/widget dist/index.js");

for (const dir of [pkg("server-node"), pkg("agent"), pkg("mcp")]) {
  rmSync(join(dir, "dist"), { recursive: true, force: true });
}

await build({ ...bundle, entryPoints: [join(pkg("server-node"), "src/index.ts")], outfile: join(pkg("server-node"), "dist/index.js") });
emitTypes(pkg("server-node"));
const shipped = join(pkg("server-node"), "dist/widget");
mkdirSync(shipped, { recursive: true });
for (const f of ["toll.js", "toll.worker.js", "toll.worker-argon2id.js", "LICENSES.txt"]) {
  copyFileSync(join(widgetDist, f), join(shipped, f));
}
console.log("packages: @lessspam/server dist/index.js + dist/widget");

await build({ ...bundle, entryPoints: [join(pkg("agent"), "src/index.ts")], outfile: join(pkg("agent"), "dist/index.js") });
await build({ ...bundle, entryPoints: [join(pkg("agent"), "src/agent-pay.ts")], outfile: join(pkg("agent"), "dist/agent-pay.js") });
emitTypes(pkg("agent"));
console.log("packages: @lessspam/agent dist/index.js dist/agent-pay.js");

await build({ ...bundle, entryPoints: [join(pkg("mcp"), "src/server.ts")], outfile: join(pkg("mcp"), "dist/index.js") });
emitTypes(pkg("mcp"));
console.log("packages: @lessspam/mcp dist/index.js");
