// CI guard (spec §21): no secrets, secret names or payment connection strings in the widget build,
// and the same rule on the four public package tarballs (no .ts sources except .d.ts, no tests).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./copy-lib.mjs";

const dir = ROOT + "packages/widget/dist/";
const forbidden = [/TOLL_SECRET/, /TOLL_NWC/, /nostr\+walletconnect:\/\//i, /\bnwc_uri\b/i, /\bmacaroon_hex\b/i, /\bsite_secret\b/i];
const env = process.env.TOLL_SECRET;
let bad = 0;
// Zero third-party calls from visitors (spec §21, Amendment 1 §F): the JS the visitor loads must not
// contain any absolute URL (no CDN, no cloud verification), nor any captcha SaaS endpoint.
const noUrls = /https?:\/\/(?!www\.w3\.org\/)[a-z0-9.-]+/i;
const saas = /turnstile|recaptcha|hcaptcha|challenges\.cloudflare|sentinel|jsdelivr|unpkg|cdnjs/i;
for (const f of readdirSync(dir)) {
  if (statSync(dir + f).isDirectory()) continue;
  const text = readFileSync(dir + f, "utf8");
  if (f.endsWith(".js")) {
    const u = noUrls.exec(text);
    if (u) { console.error(`check-dist: ${f} contains an absolute URL ${u[0]} (visitors must make no third-party calls)`); bad++; }
    const v = saas.exec(text);
    if (v) { console.error(`check-dist: ${f} mentions ${v[0]}`); bad++; }
  }
  for (const re of forbidden) if (re.test(text)) { console.error(`check-dist: ${f} matches ${re}`); bad++; }
  if (env && env.length >= 8 && text.includes(env)) { console.error(`check-dist: ${f} contains the TOLL_SECRET value`); bad++; }
  // Any secret configured for the demo or tests must not leak either.
  for (const cfg of ["demo/toll.yaml", "toll.example.yaml"]) {
    try {
      const m = /^secret:\s*(\S+)/m.exec(readFileSync(ROOT + cfg, "utf8"));
      if (m && !m[1].startsWith("env:") && text.includes(m[1])) { console.error(`check-dist: ${f} contains the secret from ${cfg}`); bad++; }
    } catch { /* file may not exist */ }
  }
}
if (bad) process.exit(1);
console.log("check-dist: widget dist has no secrets, connection strings, absolute URLs or captcha SaaS references");

const PUBLIC = [
  ["@lessspam/widget", "packages/widget"],
  ["@lessspam/server", "packages/server-node"],
  ["@lessspam/agent", "packages/agent"],
  ["@lessspam/mcp", "packages/mcp"],
];
const WIDGET_JS = new Set(["toll.js", "toll.worker.js", "toll.worker-argon2id.js"]);
const tmp = mkdtempSync(join(tmpdir(), "toll-pack-"));
try {
  for (const [name, rel] of PUBLIC) {
    const dir = ROOT + rel;
    const meta = JSON.parse(readFileSync(dir + "/package.json", "utf8"));
    if (meta.private) { console.error(`check-dist: ${name} is still private`); bad++; }
    if (meta.name !== name) { console.error(`check-dist: ${rel} name is ${meta.name}`); bad++; }
    if (meta.license !== "MIT") { console.error(`check-dist: ${name} license is not MIT`); bad++; }
    if (meta.publishConfig?.access !== "public" || meta.publishConfig?.provenance !== true) {
      console.error(`check-dist: ${name} publishConfig must be public with provenance`);
      bad++;
    }
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tmp], { cwd: dir, encoding: "utf8" }));
    const tar = join(tmp, packed[0].filename);
    const entries = execFileSync("tar", ["-tzf", tar], { encoding: "utf8" }).trim().split("\n");
    execFileSync("tar", ["-xzf", tar, "-C", tmp]);
    const rootDir = join(tmp, "package");
    for (const entry of entries) {
      const inner = entry.replace(/^[^/]+\//, "");
      if (!inner || inner.endsWith("/")) continue;
      if (/\.(ts|tsx|mts|cts)$/.test(inner) && !inner.endsWith(".d.ts")) {
        console.error(`check-dist: ${name} tarball has TypeScript source ${inner}`);
        bad++;
      }
      if (/(^|\/)(tests?|__tests__)(\/|$)/.test(inner) || /\.(test|spec)\.[a-z]+$/.test(inner)) {
        console.error(`check-dist: ${name} tarball has a test file ${inner}`);
        bad++;
      }
      const abs = join(rootDir, inner);
      let text;
      try {
        if (!statSync(abs).isFile()) continue;
        text = readFileSync(abs, "utf8");
      } catch { continue; }
      const base = inner.slice(inner.lastIndexOf("/") + 1);
      if (WIDGET_JS.has(base)) {
        const u = noUrls.exec(text);
        if (u) { console.error(`check-dist: ${name} ${inner} contains an absolute URL ${u[0]}`); bad++; }
        const v = saas.exec(text);
        if (v) { console.error(`check-dist: ${name} ${inner} mentions ${v[0]}`); bad++; }
      }
      for (const re of forbidden) if (re.test(text)) { console.error(`check-dist: ${name} ${inner} matches ${re}`); bad++; }
      if (env && env.length >= 8 && text.includes(env)) { console.error(`check-dist: ${name} ${inner} contains the TOLL_SECRET value`); bad++; }
      for (const cfg of ["demo/toll.yaml", "toll.example.yaml"]) {
        try {
          const m = /^secret:\s*(\S+)/m.exec(readFileSync(ROOT + cfg, "utf8"));
          if (m && !m[1].startsWith("env:") && text.includes(m[1])) { console.error(`check-dist: ${name} ${inner} contains the secret from ${cfg}`); bad++; }
        } catch { /* file may not exist */ }
      }
    }
    rmSync(rootDir, { recursive: true, force: true });
    console.log(`check-dist: ${name} tarball ${packed[0].filename} (${entries.length} entries) has no TypeScript sources, tests or secrets`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (bad) process.exit(1);
