// Licence (2026-10-09): the repository and every Node package are MIT.
// The WordPress plugin and packages/server-php stay GPL-2.0-or-later.
// Bundled third-party code must be GPL-compatible (MIT).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const ROOT = new URL("..", import.meta.url).pathname;
// sha256 of https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt (fetched Oct 1, 2026; same bytes as Debian's common-licenses/GPL-2).
const GPL2_SHA256 = "edaef632cbb643e4e7a221717a6c441a4c1a7c918e6e4d56debc3d8739b233f6";
const sha = (p: string) => createHash("sha256").update(readFileSync(ROOT + p)).digest("hex");

const NODE_PACKAGES = [
  "package.json",
  "demo/package.json",
  "packages/agent/package.json",
  "packages/edge-cf/package.json",
  "packages/mcp/package.json",
  "packages/protocol/package.json",
  "packages/server-node/package.json",
  "packages/settlement-ln/package.json",
  "packages/widget/package.json",
  "packages/work-adapter/package.json",
];

test("plugin header and server-php composer.json say GPL-2.0-or-later; both carry the full GPL-2.0 text", () => {
  const header = /\/\*\*([\s\S]*?)\*\//.exec(readFileSync(ROOT + "packages/wp-toll-gate/toll-gate.php", "utf8"))![1];
  assert.match(header, /^ \* License: GPL-2\.0-or-later$/m);
  assert.match(header, /^ \* License URI: https:\/\/www\.gnu\.org\/licenses\/gpl-2\.0\.html$/m);
  assert.equal(JSON.parse(readFileSync(ROOT + "packages/server-php/composer.json", "utf8")).license, "GPL-2.0-or-later");
  for (const p of ["packages/wp-toll-gate/LICENSE", "packages/server-php/LICENSE"]) {
    assert.equal(sha(p), GPL2_SHA256, p + " is the GPL-2.0 text, unmodified");
    assert.match(readFileSync(ROOT + p, "utf8"), /^\s+GNU GENERAL PUBLIC LICENSE\n\s+Version 2, June 1991/);
  }
});

test("root LICENSE is MIT and names the 2026 copyright holder", () => {
  const text = readFileSync(ROOT + "LICENSE", "utf8");
  assert.match(text, /^MIT License\n/);
  const line = text.split("\n").find((l) => l.startsWith("Copyright (c) 2026 "));
  // sha256 of the copyright line. The name itself stays in LICENSE.
  assert.equal(line && createHash("sha256").update(line).digest("hex"), "df1445c165d9372e179ac8514ca81b0c2f706f7abcbd4493658e4bea1e903623");
});

test("every Node package.json is MIT", () => {
  for (const p of NODE_PACKAGES) {
    assert.equal(JSON.parse(readFileSync(ROOT + p, "utf8")).license, "MIT", p);
  }
});

test("bundled third-party code is MIT (GPL-compatible)", { skip: existsSync(ROOT + "packages/server-php/vendor/composer/installed.json") ? false : "composer install not run" }, () => {
  const installed = JSON.parse(readFileSync(ROOT + "packages/server-php/vendor/composer/installed.json", "utf8"));
  const pkgs = installed.packages ?? installed;
  assert.ok(pkgs.length > 0);
  for (const p of pkgs) assert.deepEqual(p.license, ["MIT"], p.name);
  const notices = readFileSync(ROOT + "packages/widget/dist/LICENSES.txt", "utf8");
  const blocks = notices.split(/\n(?=\S.* \d+\.\d+\.\d+ \()/).slice(1);
  assert.ok(blocks.length > 0);
  for (const b of blocks) assert.match(b, /^\S.*\n(\n)?MIT License/, b.split("\n")[0]);
});
