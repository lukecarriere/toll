// The site build ships the Toll Gate zip (GPL-2.0-or-later) at /download/, from scripts/build-wp-zip.mjs.
// npm test runs `npm run build` first, which writes dist-release/ and copies it into website/dist/download/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore plain JS build script
import { pluginRelease } from "../website/build.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const rel = pluginRelease();
const dist = join(ROOT, "website/dist/download");
const release = join(ROOT, "dist-release");

test("root build writes the worker bundle and the plugin zip before the site", () => {
  const script = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.build as string;
  const zipAt = script.indexOf("node scripts/build-wp-zip.mjs");
  const edgeAt = script.indexOf("node packages/edge-cf/build.mjs");
  const siteAt = script.indexOf("node website/build.mjs");
  assert.ok(zipAt > 0 && edgeAt > zipAt && siteAt > edgeAt, script);
  assert.ok(existsSync(join(ROOT, "packages/edge-cf/dist/site.js")), "packages/edge-cf/dist/site.js is missing: npm run build should produce the worker wrangler deploy loads");
  assert.match(readFileSync(join(ROOT, "packages/edge-cf/dist/site.js"), "utf8"), /TollStoreDO/);
});

test("website/dist/download serves the built zip and a matching sha256", () => {
  const zipPath = join(dist, rel.zip);
  const shaPath = join(dist, rel.shaName);
  assert.ok(existsSync(zipPath), zipPath + " is missing: run npm run build");
  assert.ok(existsSync(shaPath), shaPath);
  const zip = readFileSync(zipPath);
  const listed = readFileSync(shaPath, "utf8");
  const hex = listed.trim().split(/\s+/)[0];
  assert.match(listed, new RegExp("^" + hex + "  " + rel.zip.replace(/\./g, "\\.") + "\n$"));
  assert.equal(createHash("sha256").update(zip).digest("hex"), hex);
  assert.deepEqual(readFileSync(join(release, rel.zip)), zip, "dist copy matches dist-release");
  const listing = execFileSync("python3", ["-c", `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
if bad: raise SystemExit("bad entry " + bad)
names = z.namelist()
need = ["toll-gate/toll-gate.php", "toll-gate/readme.txt", "toll-gate/LICENSE", "toll-gate/assets/widget/toll.js", "toll-gate/lib/server-php/vendor/autoload.php"]
missing = [n for n in need if n not in names]
if missing: raise SystemExit("missing " + ", ".join(missing))
php = z.read("toll-gate/toll-gate.php").decode()
if "License: GPL-2.0-or-later" not in php: raise SystemExit("licence header")
if "Plugin Name: Toll Gate" not in php: raise SystemExit("plugin name")
print(len(names))
`, zipPath], { encoding: "utf8" }).trim();
  assert.ok(Number(listing) > 10, listing);
});
