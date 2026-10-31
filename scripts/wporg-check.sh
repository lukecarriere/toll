#!/usr/bin/env bash
# WordPress.org readiness check for the Toll Gate plugin. Rebuilds the zip exactly as it would be
# uploaded (scripts/build-wp-zip.mjs), installs it in a throwaway WordPress (PHP built-in SQLite, no
# MySQL, no Docker), runs the official Plugin Check (all checks, low-severity and experimental
# included, runtime checks on) and validates readme.txt against the WordPress.org readme rules.
# Exits 0 only when Plugin Check reports no errors and no warnings and the readme passes.
# Read-only towards wordpress.org: it downloads WordPress and Plugin Check and reads public APIs.
#
#   scripts/wporg-check.sh                 # needs a clean tree (release build)
#   WPORG_ALLOW_DIRTY=1 scripts/wporg-check.sh
#   WPORG_STRICT=1 scripts/wporg-check.sh  # also fail while Contributors is empty
# Env: WPORG_CHECK_DIR (default /tmp/toll-wporg-check), WP_VERSION (default: latest release),
#      PLUGIN_CHECK_VERSION (default: latest), WPORG_OUT (report dir, default $WPORG_CHECK_DIR/out).
# Needs: php >= 8.1 with pdo_sqlite, node, composer, curl, unzip.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${WPORG_CHECK_DIR:-/tmp/toll-wporg-check}"
OUT="${WPORG_OUT:-$DIR/out}"
WPCLI_VERSION="${WPCLI_VERSION:-2.12.0}"
SQLITE_VERSION="${SQLITE_VERSION:-3.0.2}"
SITE="$DIR/site"
WP="php -d memory_limit=1G $DIR/wp-cli.phar --path=$SITE --quiet"
mkdir -p "$DIR" "$OUT"
fail=0

latest_wp="$(curl -fsS https://api.wordpress.org/core/version-check/1.7/ | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).offers[0].version))')"
WP_VERSION="${WP_VERSION:-$latest_wp}"
PLUGIN_CHECK_VERSION="${PLUGIN_CHECK_VERSION:-$(curl -fsS -g 'https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=plugin-check' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')}"
echo "wporg-check: WordPress $WP_VERSION (latest $latest_wp), Plugin Check $PLUGIN_CHECK_VERSION"

# 1. The zip, as uploaded.
build_args=(); [[ "${WPORG_ALLOW_DIRTY:-}" == 1 ]] && build_args+=(--allow-dirty)
(cd "$ROOT" && node scripts/build-wp-zip.mjs "${build_args[@]}" | grep '^build-wp-zip:')
ZIP="$(ls -t "$ROOT"/dist-release/toll-gate-*.zip | head -1)"
echo "wporg-check: zip $ZIP"
bad="$(unzip -Z1 "$ZIP" | grep -E '(^|/)(\.git|node_modules|tests?|dev)/|(^|/)\.[^/]+$|\.(map|ts|sh|phar)$|phpunit|(^|/)README\.md$' | grep -v '^toll-gate/lib/server-php/vendor/altcha-org/altcha/README.md$' || true)"
if [[ -n "$bad" ]]; then echo "wporg-check: FAIL dev files in the zip:"; echo "$bad"; fail=1; fi
[[ "$(unzip -Z1 "$ZIP" | cut -d/ -f1 | sort -u)" == "toll-gate" ]] || { echo "wporg-check: FAIL zip root is not toll-gate/"; fail=1; }

# 2. Throwaway WordPress with Plugin Check.
if [[ ! -f "$DIR/wp-cli.phar" ]]; then curl -fsSL -o "$DIR/wp-cli.phar" "https://github.com/wp-cli/wp-cli/releases/download/v$WPCLI_VERSION/wp-cli-$WPCLI_VERSION.phar"; fi
if [[ ! -f "$SITE/wp-config.php" ]] || [[ "$($WP core version 2>/dev/null || true)" != "$WP_VERSION" ]]; then
  rm -rf "$SITE"; mkdir -p "$SITE/wp-content/database"
  $WP core download --version="$WP_VERSION" --force
  rm -rf "$SITE/wp-content/plugins/akismet" "$SITE/wp-content/plugins/hello.php"
  curl -fsSL -o "$DIR/sqlite.zip" "https://downloads.wordpress.org/plugin/sqlite-database-integration.$SQLITE_VERSION.zip"
  unzip -q -o "$DIR/sqlite.zip" -d "$SITE/wp-content/plugins/"
  sed -e "s#{SQLITE_IMPLEMENTATION_FOLDER_PATH}#$SITE/wp-content/plugins/sqlite-database-integration#" \
      -e "s#{SQLITE_PLUGIN}#sqlite-database-integration/load.php#" \
      "$SITE/wp-content/plugins/sqlite-database-integration/db.copy" > "$SITE/wp-content/db.php"
  $WP config create --dbname=wordpress --dbuser=unused --dbpass=unused --dbhost=localhost --skip-check --force --extra-php <<'PHP'
define( 'DB_DIR', __DIR__ . '/wp-content/database/' );
define( 'DB_FILE', '.ht.sqlite' );
define( 'WP_ENVIRONMENT_TYPE', 'local' );
define( 'AUTOMATIC_UPDATER_DISABLED', true );
PHP
  $WP core install --url=http://127.0.0.1:8899 --title=wporg-check --admin_user=admin \
    --admin_password="$(php -r 'echo bin2hex(random_bytes(12));')" --admin_email=admin@example.test --skip-email
fi
if [[ "$($WP plugin get plugin-check --field=version 2>/dev/null || true)" != "$PLUGIN_CHECK_VERSION" ]]; then
  curl -fsSL -o "$DIR/plugin-check.zip" "https://downloads.wordpress.org/plugin/plugin-check.$PLUGIN_CHECK_VERSION.zip"
  $WP plugin install "$DIR/plugin-check.zip" --force --activate
fi
$WP plugin install "$ZIP" --force

# 3. Plugin Check: every check, every severity, runtime checks on.
(cd "$SITE" && php -d memory_limit=1G "$DIR/wp-cli.phar" --path="$SITE" plugin check toll-gate --format=csv \
  --include-low-severity-errors --include-experimental --require=./wp-content/plugins/plugin-check/cli.php) > "$OUT/plugin-check.csv" 2>"$OUT/plugin-check.stderr" || true
errors="$(grep -c ',ERROR,' "$OUT/plugin-check.csv" || true)"
warnings="$(grep -c ',WARNING,' "$OUT/plugin-check.csv" || true)"
if grep -q 'Fatal\|Error:' "$OUT/plugin-check.stderr"; then echo "wporg-check: FAIL Plugin Check did not run:"; cat "$OUT/plugin-check.stderr"; fail=1; fi
echo "wporg-check: Plugin Check errors=$errors warnings=$warnings (full report: $OUT/plugin-check.csv)"
if [[ "$errors" != 0 || "$warnings" != 0 ]]; then grep -E ',(ERROR|WARNING),|^FILE' "$OUT/plugin-check.csv" | cut -c1-240; fail=1; fi

# 4. readme.txt against the WordPress.org readme rules.
unzip -p "$ZIP" toll-gate/readme.txt > "$OUT/readme.txt"
unzip -p "$ZIP" toll-gate/toll-gate.php > "$OUT/toll-gate.php"
LATEST_WP="$latest_wp" STRICT="${WPORG_STRICT:-}" node - "$OUT/readme.txt" "$OUT/toll-gate.php" > "$OUT/readme-check.txt" <<'JS' || fail=1
const fs = require("fs");
const [readme, php] = process.argv.slice(2).map((f) => fs.readFileSync(f, "utf8"));
const problems = [], notes = [];
const head = readme.split(/\n\n/)[0], body = readme.slice(head.length);
const field = (k) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(head)?.[1].trim();
const hdr = (k) => new RegExp(`^\\s*\\*\\s*${k}:\\s*(.+?)\\s*$`, "m").exec(php)?.[1];
const title = /^=== (.+) ===$/m.exec(readme)?.[1];
if (title !== hdr("Plugin Name")) problems.push(`readme title "${title}" is not the Plugin Name "${hdr("Plugin Name")}"`);
if (/wordpress/i.test(title ?? "")) problems.push("plugin name contains a trademark (WordPress)");
for (const k of ["Requires at least", "Tested up to", "Requires PHP", "Stable tag", "License", "License URI", "Tags"]) if (!field(k)) problems.push(`readme header "${k}" missing`);
if (field("Stable tag") !== hdr("Version")) problems.push(`Stable tag ${field("Stable tag")} is not Version ${hdr("Version")}`);
if (field("Requires at least") !== hdr("Requires at least")) problems.push("Requires at least differs between readme and plugin header");
if (field("Requires PHP") !== hdr("Requires PHP")) problems.push("Requires PHP differs between readme and plugin header");
const latest = process.env.LATEST_WP.split(".").slice(0, 2).join(".");
if (field("Tested up to") !== latest) problems.push(`Tested up to ${field("Tested up to")} is not the current WordPress release ${latest}`);
if (!/^(GPL-?2\.0-or-later|GPLv2 or later|GPL-?3\.0-or-later|GPLv3 or later)$/i.test(field("License") ?? "")) problems.push(`License "${field("License")}" is not a GPL-compatible SPDX/wp.org value`);
if (hdr("License") !== field("License")) problems.push("License differs between readme and plugin header");
const tags = (field("Tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
if (tags.length > 5) problems.push(`${tags.length} tags; WordPress.org shows at most 5`);
const short = body.trim().split("\n")[0];
if (!short || short.startsWith("==")) problems.push("short description missing");
else if (short.length > 150) problems.push(`short description is ${short.length} characters (max 150)`);
for (const sec of ["Description", "Installation", "External services", "Changelog"]) if (!new RegExp(`^== ${sec} ==$`, "m").test(readme)) problems.push(`section "== ${sec} ==" missing`);
const contributors = field("Contributors");
if (!contributors) (process.env.STRICT ? problems : notes).push("Contributors is empty: needs the owner's wordpress.org username (WPORG_CONTRIBUTORS in scripts/build-wp-zip.mjs)");
else if (!/^[a-z0-9_-]+(\s*,\s*[a-z0-9_-]+)*$/.test(contributors)) problems.push(`Contributors "${contributors}" is not a list of wordpress.org usernames`);
console.log(`readme: Stable tag ${field("Stable tag")}, Tested up to ${field("Tested up to")} (current ${process.env.LATEST_WP}), Requires at least ${field("Requires at least")}, Requires PHP ${field("Requires PHP")}, License ${field("License")}, short description ${short.length} chars, tags ${tags.join(", ")}`);
for (const n of notes) console.log("readme NOTE: " + n);
for (const p of problems) console.log("readme FAIL: " + p);
process.exit(problems.length ? 1 : 0);
JS
cat "$OUT/readme-check.txt"

# 5. Slug (informational: a free slug answers "Plugin not found").
slug="$(curl -sS -g 'https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=toll-gate' || true)"
case "$slug" in *"Plugin not found"*) echo "wporg-check: slug toll-gate: not taken on WordPress.org (api: Plugin not found)";; *) echo "wporg-check: slug toll-gate: TAKEN or closed: ${slug:0:200}";; esac

if [[ $fail == 0 ]]; then echo "wporg-check: PASS ($ZIP)"; else echo "wporg-check: FAIL"; fi
exit $fail
