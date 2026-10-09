// Published packages: install each tarball and import it as JavaScript (no type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PACKAGES: [string, string][] = [
  ["@lessspam/widget", "packages/widget"],
  ["@lessspam/server", "packages/server-node"],
  ["@lessspam/agent", "packages/agent"],
  ["@lessspam/mcp", "packages/mcp"],
];

function pack(dir: string, dest: string): string {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", dest], { cwd: join(ROOT, dir), encoding: "utf8" })) as { filename: string }[];
  return join(dest, packed[0].filename);
}

test("installed tarballs import as JavaScript, toll-mcp lists 3 tools, and an Express app redeems a pass", { timeout: 180_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "toll-install-"));
  const tarballs = mkdtempSync(join(tmpdir(), "toll-tarballs-"));
  try {
    const files = PACKAGES.map(([, dir]) => pack(dir, tarballs));
    const app = join(tmp, "app");
    mkdirSync(app);
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "toll-pack-proof", private: true, type: "module" }));
    execFileSync("npm", ["install", "--no-fund", "--no-audit", "--ignore-scripts", "--prefer-offline", ...files, "express@5.1.0"], { cwd: app, stdio: "inherit" });
    writeFileSync(join(app, "proof.mjs"), PROOF);
    const out = execFileSync(process.execPath, ["proof.mjs"], { cwd: app, encoding: "utf8" });
    assert.match(out, /import ok/);
    assert.match(out, /express flow ok 200/);
    console.log(out.trim());

    const listed = await mcpTools(app);
    const tools = listed.result?.tools ?? [];
    assert.equal(tools.length, 3, JSON.stringify(listed));
    assert.deepEqual(tools.map((t: { name: string }) => t.name).sort(), ["gate_form_write", "price_write_action", "verify_write_pass"]);
    console.log("npx toll-mcp tools/list", tools.map((t: { name: string }) => t.name).join(", "));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(tarballs, { recursive: true, force: true });
  }
});

function mcpTools(cwd: string): Promise<{ result?: { tools?: { name: string }[] } }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["--no-install", "toll-mcp"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("toll-mcp timed out\n" + out + "\n" + err));
    }, 20_000);
    child.stdout!.on("data", (d) => { out += d; });
    child.stderr!.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", () => {
      clearTimeout(timer);
      const lines = out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
      const list = lines.find((m) => m.id === 2);
      if (!list) reject(new Error("no tools/list response\n" + out + "\nstderr " + err));
      else resolve(list);
    });
    const send = (obj: unknown) => child.stdin!.write(JSON.stringify(obj) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "proof", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    child.stdin!.end();
  });
}

const PROOF = `
import express from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Toll, normalizeConfig, solveWork } from "@lessspam/server";
import { createAgent, solveWork as solveFromAgent } from "@lessspam/agent";
import { toolList } from "@lessspam/mcp";
import { licenses, tollJs, tollWorker, tollWorkerArgon2id } from "@lessspam/widget";

for (const [label, url] of [["toll.js", tollJs], ["worker", tollWorker], ["argon2", tollWorkerArgon2id], ["licenses", licenses]]) {
  if (!existsSync(fileURLToPath(url))) throw new Error("missing " + label + " " + url);
}
if (typeof Toll.create !== "function" || typeof normalizeConfig !== "function" || typeof solveWork !== "function") throw new Error("server import failed");
if (typeof createAgent !== "function" || typeof solveFromAgent !== "function") throw new Error("agent import failed");
const names = toolList().map((t) => t.name);
if (names.length !== 3) throw new Error("toolList " + names.join(","));
console.log("import ok " + names.join(","));

const toll = Toll.create(normalizeConfig({
  site_id: "site_pack",
  secret: "pack-test-secret-0123456789",
  issuer_public_url: "http://127.0.0.1:9",
  routes: [{ prefix: "/contact", class: "write" }],
  rate_limit: { challenge_per_min: 1000 },
  work: { standard: { cost: 100, unit_tries: 4 } },
}));
const app = express();
app.use(Toll.router(toll));
app.post("/contact", Toll.middleware(toll, { action: "write" }), (_req, res) => {
  res.status(200).json({ ok: true });
});
const server = await new Promise((ok) => {
  const s = app.listen(0, "127.0.0.1", () => ok(s));
});
const port = server.address().port;
const base = "http://127.0.0.1:" + port;
try {
  const js = await fetch(base + "/toll/v1/toll.js");
  if (js.status !== 200) throw new Error("toll.js " + js.status);
  const widget = await js.text();
  if (widget.length < 1000) throw new Error("toll.js too small");
  const denied = await fetch(base + "/contact", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: "{}" });
  const deniedBody = await denied.json();
  if (denied.status !== 403 || deniedBody.error !== "toll_required") throw new Error("expected 403 toll_required, got " + denied.status + " " + JSON.stringify(deniedBody));
  const chRes = await fetch(base + "/v1/challenge?action=write");
  if (chRes.status !== 200) throw new Error("challenge " + chRes.status);
  const { challenge } = await chRes.json();
  const sol = await solveWork(challenge.work);
  if (!sol) throw new Error("solveWork returned nothing");
  const red = await fetch(base + "/v1/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge_id: challenge.id, challenge, solution: { work: { counter: sol.counter, derivedKey: sol.derivedKey }, took_ms: 1, ua_class: "desktop" } }),
  });
  const redeemed = await red.json();
  if (red.status !== 200 || typeof redeemed.pass !== "string") throw new Error("redeem " + red.status + " " + JSON.stringify(redeemed));
  const ok = await fetch(base + "/contact", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: "Toll " + redeemed.pass },
    body: "{}",
  });
  if (ok.status !== 200) throw new Error("expected 200, got " + ok.status + " " + await ok.text());
  console.log("express flow ok " + ok.status);
} finally {
  server.close();
}
`;
