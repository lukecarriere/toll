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
import { pluginNameProblems } from "./plugin-name.mjs";

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
for (const problem of pluginNameProblems(mainPhp, copy)) fail(problem);
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
  const from = join(WIDGET_DIST, f);
  // Package builds also drop dist/types/ next to the browser files. The plugin serves the files only.
  if (!statSync(from).isFile()) continue;
  copyFile(from, join(STAGE, "assets/widget", f));
}
const LIB = "packages/server-php";
for (const f of tracked(LIB)) copyFile(join(ROOT, f), join(STAGE, "lib/server-php", relative(LIB, f)));
run("composer", ["install", "--no-dev", "--no-interaction", "--prefer-dist", "--no-progress", "--classmap-authoritative", "--quiet"], join(STAGE, "lib/server-php"), false);
for (const required of ["toll-gate.php", "uninstall.php", "LICENSE", "assets/widget/toll.js", "lib/server-php/vendor/autoload.php"]) {
  if (!existsSync(join(STAGE, required))) fail(`staged plugin is missing ${required}`);
}

// 6. readme.txt.
// WordPress.org usernames of the plugin's owners (comma separated). Empty until the owner's
// wordpress.org account exists; scripts/wporg-check.sh reports it as the one open item. The
// WPORG_CONTRIBUTORS environment variable overrides it for a trial build.
const WPORG_CONTRIBUTORS = "";
const contributors = (process.env.WPORG_CONTRIBUTORS ?? WPORG_CONTRIBUTORS).trim();
if (contributors && !/^[a-z0-9_-]+(\s*,\s*[a-z0-9_-]+)*$/.test(contributors)) fail(`Contributors "${contributors}" must be wordpress.org usernames (lowercase, comma separated)`);
const readme = `=== ${name} ===
${contributors ? `Contributors: ${contributors}\n` : ""}Tags: spam, comments, login, forms, rest-api
Requires at least: ${requiresWp}
Tested up to: ${testedUpTo}
Requires PHP: ${requiresPhp}
Stable tag: ${version}
License: ${license}
License URI: ${licenseUri}

${desc}

== Description ==

${installLine}

== Installation ==

1. In Plugins > Add New, search for ${name}, or upload the toll-gate folder to /wp-content/plugins/.
2. Activate ${name}.
3. Open Settings > Toll and choose which forms Toll checks.

== External services ==

By default ${name} connects to no outside service. The check runs in the visitor's browser and is verified on your own site, under /wp-json/toll/v1/.

The plugin calls one outside address only when you choose it: in Settings > Toll, choose "Payment server" and enter that server's address. The payment server is a Toll issuer that you run, or that someone you choose runs for you. It is not run by the plugin authors. Every call sends the server key you entered, so the server knows the request is from your site. No names, email addresses, comment text, passwords, or full IP addresses are sent.

What is sent, and when:

* GET /v1/owner/balance, when you open Settings > Toll with "Collect usage payouts" on: the server key only.
* POST /v1/owner/withdraw, when you withdraw with "Collect usage payouts" on: the server key and the withdrawal text you pasted.
* GET /v1/owner/price?net=1, when anyone loads /.well-known/toll.json or /wp-json/toll/v1/price with payouts on and that answer is not already cached (about 30 seconds): the server key only. The net=1 on this address means the site can send a coarse network later. This call does not send one.
* POST /v1/owner/quote, when anyone opens /wp-json/toll/v1/price with payouts on and the server has said the price can rise with load: the server key, the action (for example "write"), and, when it can be worked out, the visitor's coarse network (the address with its last part removed, such as 203.0.113.0/24).
* POST /v1/owner/offers, when an automated client (not a person in a browser) posts to a checked form with payouts on: the server key, the action, and, when it can be worked out, the visitor's coarse network, so the server can return payment offers.
* POST /v1/owner/redeem, when a client pays an offer and a payment server address is saved: the server key, the payment proof the client sent, and, when it can be worked out, the visitor's coarse network.
* POST /v1/owner/cashu, when a client retries with a payment string in the X-Cashu header and a payment server address is saved: the server key, that payment string, the action, and, when it can be worked out, the visitor's coarse network.

Terms of use: https://lessspam.dev/terms
Privacy policy: https://lessspam.dev/privacy
The operator of the address you enter applies their own terms of use and privacy policy to what that server stores.

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
