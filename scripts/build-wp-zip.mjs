// Builds the WordPress plugin zip from the committed tree: dist-release/toll-gate-<version>.zip plus a
// .sha256 file. Build only: nothing is uploaded or published.
//
//   node scripts/build-wp-zip.mjs                  # needs a clean working tree (tracked files)
//   node scripts/build-wp-zip.mjs --allow-dirty    # local experiments only, never for a release
//
// What goes in the zip (folder toll-gate/):
// - the tracked files of packages/wp-toll-gate, except dev/ and README.md (repo notes, not plugin files)
// - assets/widget/: real copies of the built widget (in the repo it is a symlink to packages/widget/dist)
// - lib/server-php/: the tracked PHP library plus a `composer install --no-dev` (includes/lib.php
//   loads lib/server-php first)
// - readme.txt, generated here from the plugin header and docs/copy.md
// It fails when docs/copy.md isn't final for the readme: a TBD/TODO/DRAFT marker, a display name that
// doesn't match the "Plugin Name" header, or a header Description that isn't one of the copy.md
// plugin one-liners word for word, or is over 150 characters. readme.txt is copy-linted too.
// Same commit, same zip: entries are sorted, timestamps are the commit time and modes are fixed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { ROOT, readCopy, section, lintText, lintVendor } from "./copy-lib.mjs";

const ALLOW_DIRTY = process.argv.includes("--allow-dirty");
const fail = (msg) => { console.error("build-wp-zip: " + msg); process.exit(1); };
const run = (cmd, args, cwd = ROOT, quiet = true) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", quiet ? "pipe" : "inherit", "inherit"] });
const git = (...a) => run("git", a).trim();

// 1. Committed tree only.
const dirty = git("status", "--porcelain", "--untracked-files=no");
if (dirty && !ALLOW_DIRTY) fail("uncommitted changes to tracked files (commit them, or --allow-dirty for a local try):\n" + dirty);
const commit = git("rev-parse", "HEAD");
const commitTime = Number(git("log", "-1", "--format=%ct"));

// 2. Plugin header.
const PLUGIN = "packages/wp-toll-gate";
const mainPhp = readFileSync(join(ROOT, PLUGIN, "toll-gate.php"), "utf8");
const header = (key) => {
  const m = new RegExp(`^\\s*\\*\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(mainPhp);
  if (!m) fail(`toll-gate.php has no "${key}" header`);
  return m[1];
};
const name = header("Plugin Name"), desc = header("Description"), version = header("Version");
const requiresWp = header("Requires at least"), requiresPhp = header("Requires PHP");
const license = header("License"), licenseUri = header("License URI");
const constVersion = /define\('TOLL_GATE_VERSION',\s*'([^']+)'\)/.exec(mainPhp)?.[1];
if (constVersion !== version) fail(`Version header ${version} and TOLL_GATE_VERSION ${constVersion} differ`);
if (license !== "GPL-2.0-or-later") fail(`License header is "${license}", expected GPL-2.0-or-later`);

// 3. docs/copy.md must be final for every readme line.
const copy = readCopy();
const marker = /\b(TBD|TODO|DRAFT|PLACEHOLDER)\b/.exec(copy);
if (marker) fail(`docs/copy.md is not final: it contains "${marker[1]}"`);
const naming = /display name "([^"]+)"/.exec(copy);
if (!naming) fail('docs/copy.md: no WordPress plugin display name ("display name "...") found');
if (naming[1] !== name) fail(`Plugin Name header "${name}" is not the copy.md display name "${naming[1]}"`);
const oneLinerBlock = /Plugin one-liner \(readme\.txt\)[^\n]*\n((?:- [^\n]*\n)+)/.exec(copy);
if (!oneLinerBlock) fail("docs/copy.md: plugin one-liner block not found");
const oneLiners = [...oneLinerBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
if (!oneLiners.includes(desc)) fail(`Description header is not one of the copy.md one-liners, word for word:\n  ${desc}\n  options:\n  ${oneLiners.join("\n  ")}`);
if (desc.length > 150) fail(`short description is ${desc.length} characters; the limit is 150`);
const installLine = /First screen after install[^\n]*?exact[^\n]*?:\s*"([^"]+)"/.exec(copy)?.[1];
if (!installLine) fail("docs/copy.md: the install line (First screen after install, exact) was not found");
const testedUpTo = /WP_VERSION="\$\{WP_VERSION:-(\d+\.\d+)/.exec(readFileSync(join(ROOT, PLUGIN, "dev/setup-local-wp.sh"), "utf8"))?.[1];
if (!testedUpTo) fail("no WordPress version found in dev/setup-local-wp.sh for Tested up to");

// 4. Build the widget the plugin serves.
run("node", ["scripts/gen-strings.mjs"], ROOT, false);
run("node", ["packages/widget/build.mjs"], ROOT, false);
run("node", ["scripts/check-dist.mjs"], ROOT, false);

// 5. Stage dist-release/toll-gate/.
const OUT = join(ROOT, "dist-release"), STAGE = join(OUT, "toll-gate");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
const tracked = (dir) => git("ls-files", "-z", "--", dir).split("\0").filter(Boolean);
const copyFile = (from, to) => { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { dereference: true }); };
for (const f of tracked(PLUGIN)) {
  const rel = relative(PLUGIN, f);
  if (rel.startsWith("dev/") || rel === "README.md" || rel === "assets/widget") continue;
  copyFile(join(ROOT, f), join(STAGE, rel));
}
const WIDGET_DIST = join(ROOT, "packages/widget/dist");
for (const f of readdirSync(WIDGET_DIST)) {
  if (f.endsWith(".map")) continue;
  copyFile(join(WIDGET_DIST, f), join(STAGE, "assets/widget", f));
}
const LIB = "packages/server-php";
for (const f of tracked(LIB)) copyFile(join(ROOT, f), join(STAGE, "lib/server-php", relative(LIB, f)));
run("composer", ["install", "--no-dev", "--no-interaction", "--prefer-dist", "--no-progress", "--classmap-authoritative", "--quiet"], join(STAGE, "lib/server-php"), false);
for (const required of ["toll-gate.php", "uninstall.php", "LICENSE", "assets/widget/toll.js", "lib/server-php/vendor/autoload.php"]) {
  if (!existsSync(join(STAGE, required))) fail(`staged plugin is missing ${required}`);
}

// 6. readme.txt.
const readme = `=== ${name} ===
Requires at least: ${requiresWp}
Tested up to: ${testedUpTo}
Requires PHP: ${requiresPhp}
Stable tag: ${version}
License: ${license}
License URI: ${licenseUri}

${desc}

== Description ==

${installLine}

== Changelog ==

= ${version} =
* First release.
`;
const lintHits = [...lintText(`${PLUGIN}/readme.txt`, readme), ...lintVendor(`${PLUGIN}/readme.txt`, readme)];
if (lintHits.length) fail("readme.txt copy lint: " + lintHits.map((h) => `line ${h.line} "${h.text}"`).join(", "));
writeFileSync(join(STAGE, "readme.txt"), readme);

// 7. Deterministic zip.
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e), st = statSync(p);
    if (st.isDirectory()) walk(p); else files.push(p);
  }
};
walk(STAGE);
const dos = (() => {
  const d = new Date(commitTime * 1000);
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
})();
const locals = [], centrals = [];
let offset = 0;
for (const p of files) {
  const nameBuf = Buffer.from("toll-gate/" + relative(STAGE, p).split("\\").join("/"));
  const data = readFileSync(p), packed = deflateRawSync(data, { level: 9 }), crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(dos.time, 10); local.writeUInt16LE(dos.date, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10); central.writeUInt16LE(dos.time, 12); central.writeUInt16LE(dos.date, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
  locals.push(local, nameBuf, packed);
  centrals.push(central, nameBuf);
  offset += local.length + nameBuf.length + packed.length;
}
const centralBuf = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...locals, centralBuf, end]);
const zipName = `toll-gate-${version}.zip`;
writeFileSync(join(OUT, zipName), zip);
const sha = createHash("sha256").update(zip).digest("hex");
writeFileSync(join(OUT, zipName + ".sha256"), `${sha}  ${zipName}\n`);
console.log(`build-wp-zip: dist-release/${zipName}, ${files.length} files, ${zip.length} B, commit ${commit.slice(0, 7)}${dirty ? " (dirty, not for release)" : ""}`);
console.log(`build-wp-zip: sha256 ${sha}`);
