#!/usr/bin/env bash
# Local WordPress for the toll-gate plugin: PHP's built-in server + SQLite (no MySQL, no Docker).
# Local only. Downloads pinned WordPress, the SQLite database integration plugin and WP-CLI from
# their official sources the first time, then installs, links this plugin and starts the server.
#   packages/wp-toll-gate/dev/setup-local-wp.sh          # install (if needed) and start
#   packages/wp-toll-gate/dev/setup-local-wp.sh stop     # stop the server
# Needs: php >= 8.1 with pdo_sqlite (Debian: php8.4-sqlite3), curl, unzip.
set -euo pipefail
WP_VERSION="${WP_VERSION:-7.1.2}"
SQLITE_VERSION="${SQLITE_VERSION:-3.0.2}"
WPCLI_VERSION="${WPCLI_VERSION:-2.12.0}"
BASE="${WP_LOCAL_DIR:-/workspace/wp-local}"
SITE="$BASE/site"
HOST="${WP_HOST:-127.0.0.1}"
PORT="${WP_PORT:-8888}"
URL="http://$HOST:$PORT"
PLUGIN_SRC="$(cd "$(dirname "$0")/.." && pwd)"
CREDS="$BASE/ADMIN_CREDENTIALS.txt"
WP="php $BASE/wp-cli.phar --path=$SITE"

if [[ "${1:-}" == "stop" ]]; then
  [[ -f "$BASE/server.pid" ]] && kill "$(cat "$BASE/server.pid")" 2>/dev/null || true
  pkill -f "php -S $HOST:$PORT -t $SITE" 2>/dev/null || true
  rm -f "$BASE/server.pid"; echo "stopped"; exit 0
fi

php -m | grep -qi pdo_sqlite || { echo "php pdo_sqlite is missing (Debian: apt-get install php8.4-sqlite3)"; exit 1; }
mkdir -p "$BASE"
[[ -f "$BASE/wp-cli.phar" ]] || curl -fsSL -o "$BASE/wp-cli.phar" "https://github.com/wp-cli/wp-cli/releases/download/v$WPCLI_VERSION/wp-cli-$WPCLI_VERSION.phar"

if [[ ! -f "$SITE/wp-config.php" ]]; then
  mkdir -p "$SITE"
  $WP core download --version="$WP_VERSION" --force
  rm -rf "$SITE/wp-content/plugins/akismet" "$SITE/wp-content/plugins/hello.php"
  mkdir -p "$SITE/wp-content/database"
  curl -fsSL -o "$BASE/sqlite.zip" "https://downloads.wordpress.org/plugin/sqlite-database-integration.$SQLITE_VERSION.zip"
  unzip -q -o "$BASE/sqlite.zip" -d "$SITE/wp-content/plugins/"
  sed -e "s#{SQLITE_IMPLEMENTATION_FOLDER_PATH}#$SITE/wp-content/plugins/sqlite-database-integration#" \
      -e "s#{SQLITE_PLUGIN}#sqlite-database-integration/load.php#" \
      "$SITE/wp-content/plugins/sqlite-database-integration/db.copy" > "$SITE/wp-content/db.php"
  $WP config create --dbname=wordpress --dbuser=unused --dbpass=unused --dbhost=localhost --skip-check --force \
    --extra-php <<'PHP'
define( 'DB_DIR', __DIR__ . '/wp-content/database/' );
define( 'DB_FILE', '.ht.sqlite' );
define( 'WP_ENVIRONMENT_TYPE', 'local' );
define( 'AUTOMATIC_UPDATER_DISABLED', true );
define( 'WP_HTTP_BLOCK_EXTERNAL', true );
define( 'WP_ACCESSIBLE_HOSTS', '' );
PHP
  PASS="$(php -r 'echo bin2hex(random_bytes(12));')"
  $WP core install --url="$URL" --title="Toll local" --admin_user=admin --admin_password="$PASS" --admin_email=admin@example.test --skip-email
  # WP-CLI can derive the URL from the install path; pin it to the server address.
  $WP option update home "$URL" >/dev/null
  $WP option update siteurl "$URL" >/dev/null
  $WP rewrite structure '/%postname%/' >/dev/null
  $WP option update comment_moderation 0 >/dev/null
  $WP option update comment_previously_approved 0 >/dev/null
  $WP option update require_name_email 1 >/dev/null
  $WP option update show_avatars 0 >/dev/null   # no third-party avatar requests on the local site
  umask 077
  printf 'Local WordPress for toll-gate (local only, not in git)\nURL: %s\nAdmin: %s/wp-admin/\nUser: admin\nPassword: %s\n' "$URL" "$URL" "$PASS" > "$CREDS"
fi

# Local test site only: let the test suite post several comments in a row from 127.0.0.1.
mkdir -p "$SITE/wp-content/mu-plugins"
cat > "$SITE/wp-content/mu-plugins/toll-local-dev.php" <<'PHP'
<?php
// Local development site for toll-gate only (written by dev/setup-local-wp.sh).
add_filter( 'comment_flood_filter', '__return_false' );
// The test suite fetches more than the default 60 challenges a minute from 127.0.0.1.
add_filter( 'toll_gate_challenges_per_min', fn () => 300 );
PHP

ln -sfn "$PLUGIN_SRC" "$SITE/wp-content/plugins/toll-gate"
$WP plugin activate toll-gate >/dev/null 2>&1 || $WP plugin activate toll-gate

if [[ -f "$BASE/server.pid" ]] && kill -0 "$(cat "$BASE/server.pid")" 2>/dev/null; then
  echo "already running: $URL"
else
  PHP_CLI_SERVER_WORKERS="${PHP_CLI_SERVER_WORKERS:-4}" nohup php -S "$HOST:$PORT" -t "$SITE" "$PLUGIN_SRC/dev/router.php" > "$BASE/server.log" 2>&1 &
  echo $! > "$BASE/server.pid"
  sleep 1
  echo "started: $URL"
fi
echo "admin credentials: $CREDS"
