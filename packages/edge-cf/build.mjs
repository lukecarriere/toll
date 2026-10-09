// Bundles the edge worker and the site worker (protocol, work engine, widget files) for
// wrangler dev / miniflare. Node built-ins stay external: the Worker runs with nodejs_compat.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
await build({
  entryPoints: [here("src/worker.ts"), here("src/site.ts")],
  outdir: here("dist"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  external: ["node:*", "cloudflare:workers"],
  loader: { ".js": "js" },
  plugins: [{
    name: "widget-text",
    setup(b) {
      // The widget files are served by the Worker, so import them as text, not as code.
      b.onLoad({ filter: /widget[\\/]dist[\\/].*\.js$/ }, async (a) => ({ contents: await (await import("node:fs/promises")).readFile(a.path, "utf8"), loader: "text" }));
    },
  }],
  logLevel: "warning",
  legalComments: "none",
});
console.log("edge: dist/worker.js dist/site.js");
