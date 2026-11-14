// Daily accepted and rejected totals at GET /demo/stats/daily, with our own test traffic kept apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { doStorage } from "./do-harness.ts";
import type { SiteEnv } from "../packages/edge-cf/src/site.ts";
import type { TollDoStub, TollStoreDO } from "../packages/edge-cf/src/do-store.ts";

// The site worker imports the widget bundles as text (esbuild loader in packages/edge-cf/build.mjs).
// Serve the same default-export text when this file is loaded in Node.
registerHooks({
  load(url, context, next) {
    if (/\/widget\/dist\/toll(?:\.worker)?\.js$/.test(url)) {
      return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(readFileSync(new URL(url), "utf8")) };
    }
    return next(url, context);
  },
});

// Load the site worker after the do-harness has registered the cloudflare:workers stand-in.
const { default: site } = await import("../packages/edge-cf/src/site.ts");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KEYS = ["accepted", "date", "rejected", "test_accepted", "test_rejected"] as const;

function utcDay(offset = 0, from = new Date().toISOString().slice(0, 10)): string {
  return new Date(Date.parse(from + "T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10);
}

function asStub(store: TollStoreDO): TollDoStub {
  return new Proxy(store, {
    get(target, prop, recv) {
      const val = Reflect.get(target, prop, recv);
      if (typeof val === "function") {
        return (...args: unknown[]) => Promise.resolve((val as (...a: unknown[]) => unknown).apply(target, args));
      }
      return val;
    },
  }) as unknown as TollDoStub;
}

function siteEnv(storage = doStorage(), extra: Record<string, string> = {}) {
  const store = storage.open(extra);
  const env = {
    ASSETS: { fetch: async () => new Response("asset", { status: 200, headers: { "content-type": "text/plain" } }) },
    TOLL_STORE: { idFromName: () => "toll", get: () => asStub(store) },
    SITE_SECRET: "a".repeat(32),
    SITE_ID: "site_demo",
    WRITE_PATHS: JSON.stringify(["/demo/contact"]),
    TOLL_SITE_URL: "https://lessspam.dev",
    TOLL_TEST_HOOKS: "1",
    ...extra,
  } as unknown as SiteEnv;
  return { storage, store, env };
}

function call(env: SiteEnv, path: string, init: RequestInit = {}) {
  return site.fetch(new Request("https://lessspam.dev" + path, init), env);
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

function assertDayShape(day: Record<string, unknown>, date: string, counts: { accepted?: number; rejected?: number; test_accepted?: number; test_rejected?: number } = {}) {
  assert.deepEqual(Object.keys(day).sort(), [...KEYS]);
  assert.equal(day.date, date);
  assert.equal(day.accepted, counts.accepted ?? 0);
  assert.equal(day.rejected, counts.rejected ?? 0);
  assert.equal(day.test_accepted, counts.test_accepted ?? 0);
  assert.equal(day.test_rejected, counts.test_rejected ?? 0);
}

test("daily: 7 entries by default, oldest first, zeros filled, exact keys", async () => {
  const { env } = siteEnv();
  const res = await call(env, "/demo/stats/daily");
  const body = await jsonOf(res);
  const days = body.days as Record<string, unknown>[];
  assert.ok(Array.isArray(days), "body has a days array, got " + JSON.stringify({ status: res.status, body }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(days.length, 7);
  const today = utcDay(0);
  for (let i = 0; i < 7; i++) {
    assertDayShape(days[i], utcDay(i - 6, today));
  }
});

test("daily: days=30 gives 30; days=0, 31, x give 400 invalid_days", async () => {
  const { env } = siteEnv();
  const thirty = await call(env, "/demo/stats/daily?days=30");
  assert.equal(thirty.status, 200);
  const body = await jsonOf(thirty);
  const days = body.days as Record<string, unknown>[];
  assert.equal(days.length, 30);
  assert.equal(days[0].date, utcDay(-29));
  assert.equal(days[29].date, utcDay(0));
  assertDayShape(days[0], utcDay(-29));

  for (const bad of ["0", "31", "x", "1.5", "-1", "7.0"]) {
    const res = await call(env, "/demo/stats/daily?days=" + bad);
    assert.equal(res.status, 400, "days=" + bad);
    assert.deepEqual(await jsonOf(res), { error: "invalid_days" });
  }

  const head = await call(env, "/demo/stats/daily", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "application/json");
  assert.equal(head.headers.get("cache-control"), "no-store");
  assert.equal(await head.text(), "");
});

test("daily: toll-test: 1 counts in test_accepted/test_rejected and not in accepted/rejected", async () => {
  const { env } = siteEnv();
  const post = (test: boolean) =>
    call(env, "/demo/contact", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(test ? { "toll-test": "1" } : {}),
      },
      body: "{}",
    });
  assert.equal((await post(false)).status, 403);
  assert.equal((await post(true)).status, 403);
  const res = await call(env, "/demo/stats/daily?days=1");
  assert.equal(res.status, 200);
  const days = (await jsonOf(res)).days as Record<string, unknown>[];
  assert.equal(days.length, 1);
  assertDayShape(days[0], utcDay(0), { rejected: 1, test_rejected: 1 });
});

test("daily: existing rows read 0 for the new columns after migration", () => {
  const s = doStorage();
  s.db.exec("CREATE TABLE day (d TEXT PRIMARY KEY, accepted INTEGER NOT NULL, rejected INTEGER NOT NULL)");
  s.db.exec("INSERT INTO day (d, accepted, rejected) VALUES ('2026-11-01', 2, 3)");
  const store = s.open();
  assert.deepEqual(s.columns("day"), ["d", "accepted", "rejected", "test_accepted", "test_rejected"]);
  assert.doesNotThrow(() => s.open(), "a second start finds the columns and adds nothing");
  const row = s.db.prepare("SELECT accepted, rejected, test_accepted, test_rejected FROM day WHERE d = '2026-11-01'").get() as Record<string, number>;
  assert.deepEqual(row, { accepted: 2, rejected: 3, test_accepted: 0, test_rejected: 0 });
  store.note("accepted");
  store.note("rejected", true);
  const today = s.db.prepare("SELECT accepted, rejected, test_accepted, test_rejected FROM day WHERE d = ?").get(utcDay(0)) as Record<string, number>;
  assert.deepEqual(today, { accepted: 1, rejected: 0, test_accepted: 0, test_rejected: 1 });
  const old = s.db.prepare("SELECT accepted, rejected, test_accepted, test_rejected FROM day WHERE d = '2026-11-01'").get() as Record<string, number>;
  assert.deepEqual(old, { accepted: 2, rejected: 3, test_accepted: 0, test_rejected: 0 }, "old rows stay at 0 for the new columns");
});

test("demo/stats: keys unchanged and excludes test traffic", async () => {
  const { env } = siteEnv();
  const post = (headers: Record<string, string> = {}) =>
    call(env, "/demo/contact", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...headers },
      body: "{}",
    });
  assert.equal((await post()).status, 403);
  assert.equal((await post({ "toll-test": "1" })).status, 403);
  const res = await call(env, "/demo/stats");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await jsonOf(res);
  assert.deepEqual(Object.keys(body).sort(), ["accepted", "rejected", "reversals", "reversed_sats"]);
  assert.equal(body.accepted, 0);
  assert.equal(body.rejected, 1);
  assert.equal(body.reversals, 0);
  assert.equal(body.reversed_sats, 0);
});

test("live-checks: every request the script sends to /demo/contact carries toll-test: 1", () => {
  const files = [
    "scripts/live-checks.mjs",
    "scripts/l402-live-check.sh",
    "scripts/check-live-state.sh",
    "scripts/check-open-intelligence.sh",
  ];
  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.match(src, /demo\/contact/, rel + " posts to the live demo");
    assert.match(src, /toll-test/, rel + " sends the test-traffic header");
  }

  const live = readFileSync(join(ROOT, "scripts/live-checks.mjs"), "utf8");
  // Every fetch to /demo/contact or pathW (the spend-mode contact path) must include the header
  // on the shared headers object used by that call.
  assert.match(live, /headers\s*=\s*\{[^}]*"toll-test":\s*"1"/s);
  assert.match(live, /postHeaders\s*=\s*\{[^}]*"toll-test":\s*"1"/s);

  const l402 = readFileSync(join(ROOT, "scripts/l402-live-check.sh"), "utf8");
  const curls = [...l402.matchAll(/curl[\s\S]*?\$base\$path/g)].map((m) => m[0]);
  assert.ok(curls.length >= 1, "l402-live-check.sh curls the gated path");
  for (const block of curls) {
    assert.match(block, /toll-test:\s*1/, "each curl to the gated path carries toll-test: 1");
  }

  const state = readFileSync(join(ROOT, "scripts/check-live-state.sh"), "utf8");
  assert.match(state, /fetch\(base \+ "\/demo\/contact"[\s\S]*?"toll-test": "1"/);

  const oi = readFileSync(join(ROOT, "scripts/check-open-intelligence.sh"), "utf8");
  assert.match(oi, /paid_curl_args\(\)[\s\S]*toll-test:\s*1/);
});

// silence unused import if the type-only dirname is dropped by type stripping
