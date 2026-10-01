// Builds dist/toll.js (page script) and dist/toll.worker.js (solver) with esbuild.
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
mkdirSync(here + "dist", { recursive: true });
const common = { bundle: true, minify: true, format: "iife", target: ["es2020"], legalComments: "none", loader: { ".css": "text" } };
await build({ ...common, entryPoints: [here + "src/index.ts"], outfile: here + "dist/toll.js" });
await build({ ...common, entryPoints: [here + "src/worker.ts"], outfile: here + "dist/toll.worker.js" });

const BUDGET = 25 * 1024;
let total = 0;
for (const f of ["toll.js", "toll.worker.js"]) {
  const buf = readFileSync(here + "dist/" + f);
  const gz = gzipSync(buf, { level: 9 }).length;
  total += gz;
  console.log(`widget: dist/${f} ${buf.length} B, ${gz} B gzipped`);
}
console.log(`widget: default path total ${total} B gzipped (budget ${BUDGET} B)`);
if (total > BUDGET) {
  console.error("widget: over the 25 KB gzip budget");
  process.exit(1);
}
