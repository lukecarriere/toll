// Amendment 2: Toll checks writes, not page views. Config defaults, classification, the page-view
// confirm, and the install text in README and the WordPress plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createToll, loadConfig, normalizeConfig, classifyPath, protect, Metrics, MemoryStore, PAGE_VIEW_WARNING, PAGE_VIEW_CONFIRM } from "../packages/server-node/src/index.ts";
import { TEST_SECRET } from "./helpers.ts";

const COPY = readFileSync(new URL("../docs/copy.md", import.meta.url), "utf8");
const INSTALL = "Toll checks writes and searches, not page views. Leave public pages open so people and answer engines can read you. Turn Toll on for comments, forms, logins, and APIs.";
const base = { site_id: "site_test", secret: TEST_SECRET };

test("the page-view warning and install text are docs/copy.md word for word", () => {
  assert.ok(COPY.includes(`"${PAGE_VIEW_WARNING}"`));
  assert.ok(COPY.includes(`Buttons: "${PAGE_VIEW_CONFIRM.keep}" (focused, default) and "${PAGE_VIEW_CONFIRM.gate}" (destructive).`), "routes editor confirm buttons verbatim");
  assert.ok(COPY.includes(`"${INSTALL}"`));
  assert.ok(readFileSync(new URL("../README.md", import.meta.url), "utf8").includes("\n" + INSTALL + "\n"), "README: plain paragraph, verbatim");
  const php = readFileSync(new URL("../packages/wp-toll-gate/includes/strings.php", import.meta.url), "utf8");
  assert.ok(php.includes(`'install_line' => '${INSTALL}'`));
});

test("toll.example.yaml: '/' is an explicit read route first; search 1x; loads without a confirm", () => {
  const c = loadConfig(new URL("../toll.example.yaml", import.meta.url).pathname, { TOLL_SECRET: TEST_SECRET });
  assert.deepEqual(c.routes[0], { prefix: "/", class: "read" });
  assert.deepEqual(c.routes.find((r) => r.prefix === "/search"), { prefix: "/search", class: "search" });
  assert.equal(c.confirm_page_view_gating, false);
  const demo = loadConfig(new URL("../demo/toll.yaml", import.meta.url).pathname, { TOLL_SECRET: TEST_SECRET, TOLL_OWNER_KEY: "x".repeat(32) });
  assert.deepEqual(demo.routes[0], { prefix: "/", class: "read" });
});

test("classification: every page load is read (mapped or not); writes keep their class; unmapped writes stay write; search can cost 0", () => {
  const { routes } = normalizeConfig({ ...base, routes: [{ prefix: "/", class: "read" }, { prefix: "/contact", class: "write" }, { prefix: "/search", class: "search" }, { prefix: "/wp-login.php", class: "account" }] });
  for (const m of ["GET", "HEAD", "OPTIONS"]) {
    for (const p of ["/", "/contact", "/search?q=x", "/wp-login.php", "/blog/post-1", "/feed.xml", "/docs/a"]) assert.equal(classifyPath(routes, p, m).cls, "read", `${m} ${p}`);
  }
  assert.equal(classifyPath(routes, "/contact", "POST").cls, "write");
  assert.equal(classifyPath(routes, "/search", "POST").cls, "search");
  assert.equal(classifyPath(routes, "/wp-login.php", "POST").cls, "account");
  assert.equal(classifyPath(routes, "/", "POST").cls, "write", "the '/' page-view rule does not make writes free");
  assert.equal(classifyPath(routes, "/unmapped", "DELETE").cls, "write");
  const free = normalizeConfig({ ...base, routes: [{ prefix: "/search", class: "search", cost: 0 }] }).routes;
  assert.equal(classifyPath(free, "/search", "POST").cls, "read", "owner set search to 0");
  assert.throws(() => normalizeConfig({ ...base, routes: [{ prefix: "/search", class: "search", cost: 2 }] }), /cost can only be 0/);
});

test("gating page views ('/' above read, or get: true) refuses to load without confirm_page_view_gating, with the warning text", () => {
  for (const r of [{ prefix: "/", class: "write" }, { prefix: "/", class: "search" }, { prefix: "/docs", class: "account", get: true }]) {
    assert.throws(() => normalizeConfig({ ...base, routes: [r] }), (e: Error) => e.message.includes(PAGE_VIEW_WARNING) && e.message.includes("confirm_page_view_gating: true"), JSON.stringify(r));
  }
  // Not page gating: these load fine.
  normalizeConfig({ ...base, routes: [{ prefix: "/", class: "read" }, { prefix: "/docs", class: "read", get: true }, { prefix: "/search", class: "search", get: true, cost: 0 }] });
});

test("confirmed: GET is gated only where the owner said so; the warning is logged at startup and page_view_gate_confirmed counts it", () => {
  const lines: string[] = [];
  const config = normalizeConfig({ ...base, confirm_page_view_gating: true, routes: [{ prefix: "/members", class: "write", get: true }, { prefix: "/contact", class: "write" }] });
  assert.equal(classifyPath(config.routes, "/members/a", "GET").cls, "write");
  assert.equal(classifyPath(config.routes, "/contact", "GET").cls, "read");
  assert.equal(classifyPath(config.routes, "/", "GET").cls, "read");
  const toll = createToll(config, { metrics: new Metrics((l) => lines.push(l)), store: new MemoryStore() });
  assert.equal(toll.metrics.c.page_view_gate_confirmed, 1);
  const ev = lines.map((l) => JSON.parse(l)).find((e) => e.event === "page_view_gate_confirmed");
  assert.deepEqual({ warning: ev.warning, prefixes: ev.prefixes }, { warning: PAGE_VIEW_WARNING, prefixes: ["/members"] });
  const plain = createToll(normalizeConfig({ ...base, routes: [{ prefix: "/", class: "read" }] }), { metrics: new Metrics(() => {}), store: new MemoryStore() });
  assert.equal(plain.metrics.c.page_view_gate_confirmed, 0);
});

test("protect() mounted on the whole site: page loads pass through untouched (no challenge minted); writes are checked", async () => {
  const lines: string[] = [];
  const toll = createToll(normalizeConfig({ ...base, routes: [{ prefix: "/", class: "read" }, { prefix: "/contact", class: "write" }] }), { metrics: new Metrics((l) => lines.push(l)), store: new MemoryStore() });
  const guard = protect(toll);
  const srv = createServer((req, res) => guard(req as any, res, () => { res.statusCode = 200; res.end("page"); }));
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const u = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    for (const p of ["/", "/contact", "/blog/a", "/feed.xml"]) {
      const r = await fetch(u + p, { headers: { accept: "text/html" } });
      assert.equal(r.status, 200, p);
      assert.equal(await r.text(), "page");
    }
    assert.equal(toll.metrics.c.challenges_minted, 0);
    assert.equal(toll.metrics.c.pass_absent, 0);
    const w = await fetch(u + "/contact", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: "{}" });
    assert.equal(w.status, 403);
    assert.equal(toll.metrics.c.challenges_minted, 1);
  } finally {
    srv.close();
  }
});
