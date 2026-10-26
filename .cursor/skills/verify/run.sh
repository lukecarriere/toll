#!/usr/bin/env bash
# Full verify run: install, test, then drive the site, the demo form, the npm packages, and the WordPress plugin zip.
# Evidence stays in docs/runs/verify-e2e/. Cleanup kills only the PIDs this run started.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
EVID="$ROOT/docs/runs/verify-e2e"
mkdir -p "$EVID"
PIDFILE="$EVID/pids.txt"
: > "$PIDFILE"
TRANSCRIPT="$EVID/transcript.txt"
: > "$TRANSCRIPT"

log() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }

cleanup() {
  if [[ -f "$PIDFILE" ]]; then
    while read -r pid; do
      [[ -n "$pid" ]] || continue
      kill "$pid" 2>/dev/null || true
      # Children of the launcher (php, wrangler, workerd), not a process-name sweep.
      pkill -P "$pid" 2>/dev/null || true
    done < "$PIDFILE"
  fi
  rm -f "$ROOT/.dev.vars"
}
trap cleanup EXIT

wait_http() {
  local url="$1" tries="${2:-60}"
  local i
  for ((i = 1; i <= tries; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  log "not ready: $url"
  return 1
}

log "verify e2e $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "node $(node -v) php $(php -v | head -n 1)"

log "install"
npm ci
(cd packages/server-php && composer install --no-interaction --no-progress)
npx playwright install --with-deps chromium

log "npm test"
set +e
npm test > "$EVID/npm-test.txt" 2>&1
test_status=$?
set -e
tail -n 40 "$EVID/npm-test.txt" | tee -a "$TRANSCRIPT"
log "npm test exit $test_status"
[[ "$test_status" -eq 0 ]]

log "packages"
node --input-type=module <<'EOF' | tee -a "$TRANSCRIPT"
import { VERSION } from "./packages/server-node/dist/index.js";
import { createAgent } from "./packages/agent/dist/index.js";
import { tollJs } from "./packages/widget/dist/index.js";
import { toolList } from "./packages/mcp/dist/index.js";
import { statSync } from "node:fs";
const tools = toolList().map((t) => t.name).join(",");
if (VERSION !== "1.0.0") throw new Error("server " + VERSION);
if (typeof createAgent !== "function") throw new Error("agent");
if (!String(tollJs).endsWith("/toll.js")) throw new Error("widget " + tollJs);
if (statSync(new URL(tollJs)).size < 100) throw new Error("toll.js");
if (tools !== "price_write_action,gate_form_write,verify_write_pass") throw new Error("mcp " + tools);
console.log("packages ok", VERSION, tools);
EOF
php -r 'require "packages/server-php/vendor/autoload.php"; $ok = class_exists("Toll\\Protocol") && class_exists("Toll\\Settlement"); echo $ok ? "php ok\n" : "php missing\n"; exit($ok ? 0 : 1);' | tee -a "$TRANSCRIPT"

log "demo"
env -u TOLL_SECRET -u TOLL_OWNER_KEY node demo/server.ts > "$EVID/demo.log" 2>&1 &
echo $! >> "$PIDFILE"
wait_http http://127.0.0.1:8787/v1/health 60
grep -F "Toll demo on http://localhost:8787" "$EVID/demo.log" | tee -a "$TRANSCRIPT"
grep -F "TOLL_SECRET not set" "$EVID/demo.log" | tee -a "$TRANSCRIPT"
base=http://127.0.0.1:8787
{
  curl -fsS "$base/" | grep -o "Every form on this page is protected"
  curl -fsS "$base/hammer" | grep -o "Bot hammer" | head -n 1
  curl -fsS "$base/v1/health"; echo
  curl -fsS "$base/.well-known/toll.json" | php -r '$j=json_decode(stream_get_contents(STDIN)); echo $j->name, " ", ($j->reads_free ? "reads_free" : "not_free"), " ", $j->api, "\n";'
  curl -fsS "$base/.well-known/agents.json"; echo
  curl -fsS -D - -o /dev/null "$base/toll/v1/toll.js" | head -n 1
  curl -fsS "$base/demo/stats" | php -r '$j=json_decode(stream_get_contents(STDIN)); echo $j->accepted, " ", $j->rejected, " ", $j->mode, "\n";'
  curl -sS -o "$EVID/demo-contact.json" -w '%{http_code}\n' -X POST -H 'accept: application/json' -H 'content-type: application/x-www-form-urlencoded' "$base/contact" --data 'message=hi'
  php -r 'echo json_decode(file_get_contents($argv[1]))->error, "\n";' "$EVID/demo-contact.json"
} | tee -a "$TRANSCRIPT"

log "human path"
WRITE_PATH=/contact node --input-type=module <<'EOF' | tee -a "$TRANSCRIPT"
import { solveWork } from "./packages/agent/dist/index.js";
const base = process.env.BASE ?? "http://127.0.0.1:8787";
const writePath = process.env.WRITE_PATH ?? "/contact";
const denied = await fetch(base + writePath, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
const deniedBody = await denied.json();
if (denied.status !== 403 || deniedBody.error !== "toll_required" || !deniedBody.challenge) throw new Error("denied " + denied.status);
const solved = await solveWork(deniedBody.challenge.work);
if (!solved) throw new Error("solve");
const redeem = await fetch(base + "/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id: deniedBody.challenge.id, challenge: deniedBody.challenge, solution: { work: { counter: solved.counter, derivedKey: solved.derivedKey }, took_ms: 1 } }) });
if (redeem.status !== 200) throw new Error("redeem " + redeem.status);
const redeemed = await redeem.json();
if (typeof redeemed.pass !== "string") throw new Error("redeem body");
const ok = await fetch(base + writePath, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", authorization: "Toll " + redeemed.pass }, body: JSON.stringify({ message: "hi" }) });
const okBody = await ok.json();
if (ok.status !== 200 || okBody.ok !== true) throw new Error("write " + ok.status);
console.log("human path ok", denied.status, deniedBody.error, redeem.status, ok.status);
EOF

log "static site"
php -S 127.0.0.1:8791 -t website/dist > "$EVID/site.log" 2>&1 &
echo $! >> "$PIDFILE"
wait_http http://127.0.0.1:8791/ 30
site=http://127.0.0.1:8791
{
  curl -fsS "$site/" | grep -o "Less traffic." | head -n 1
  curl -fsS "$site/mission.html" | grep -o "<h1>Mission</h1>"
  curl -fsS "$site/vision.html" | grep -o "<h1>Vision</h1>"
  curl -fsS "$site/values.html" | grep -o "<h1>Values</h1>"
  curl -fsS "$site/ecosystem.html" | grep -o "<h1>Where Toll fits</h1>"
  curl -fsS "$site/privacy.html" | grep -o "<h1>Privacy</h1>"
  curl -fsS "$site/terms.html" | grep -o "<h1>Terms</h1>"
  curl -fsS "$site/support.html" | grep -o "<h1>Support</h1>"
  curl -fsS "$site/robots.txt"
  curl -fsS "$site/" | grep -o 'href="/docs"'
  for p in docs/index.html docs/quick-start.html docs/widget.html docs/server.html docs/agent.html docs/mcp.html docs/wordpress.html docs/self-hosting.html download/index.html; do
    curl -fsS -o /tmp/toll-page.html "$site/$p"
    echo "200 $p $(grep -o '<h1>[^<]*</h1>' /tmp/toll-page.html)"
  done
} | tee -a "$TRANSCRIPT"
zip=$(grep -o '/download/toll-gate-[^"]*\.zip' /tmp/toll-page.html | head -n 1)
curl -fsS -o "$EVID/$(basename "$zip")" "$site$zip"
curl -fsS -o "$EVID/$(basename "$zip").sha256" "$site$zip.sha256"
(cd "$EVID" && sha256sum -c "$(basename "$zip").sha256") | tee -a "$TRANSCRIPT"
unzip -t "$EVID/$(basename "$zip")" > "$EVID/unzip.txt"
unzip -p "$EVID/$(basename "$zip")" toll-gate/toll-gate.php | grep -o "GPL-2.0-or-later" | tee -a "$TRANSCRIPT"
unzip -p "$EVID/$(basename "$zip")" toll-gate/toll-gate.php | grep -o "Plugin Name: Toll Gate" | tee -a "$TRANSCRIPT"

log "worker"
node --input-type=module <<'EOF'
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
writeFileSync(".dev.vars", `SITE_SECRET="${randomBytes(24).toString("hex")}"\n`, { mode: 0o600 });
console.log("wrote .dev.vars");
EOF
node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port 8788 --show-interactive-dev-session=false > "$EVID/worker.log" 2>&1 &
echo $! >> "$PIDFILE"
ready=0
for ((i = 1; i <= 90; i++)); do
  if grep -q "Ready on http://127.0.0.1:8788" "$EVID/worker.log"; then ready=1; break; fi
  sleep 1
done
[[ "$ready" -eq 1 ]]
grep -F "Ready on http://127.0.0.1:8788" "$EVID/worker.log" | tee -a "$TRANSCRIPT"
worker=http://127.0.0.1:8788
{
  curl -fsS "$worker/" | grep -o 'href="/docs"'
  for p in /docs /docs/quick-start /docs/widget /docs/server /docs/agent /docs/mcp /docs/wordpress /docs/self-hosting /download /privacy /terms /support /mission; do
    code=$(curl -sS -o /tmp/toll-page.html -w '%{http_code}' "$worker$p")
    echo "$code $p $(grep -o '<h1>[^<]*</h1>' /tmp/toll-page.html)"
  done
} | tee -a "$TRANSCRIPT"
zip=$(grep -o '/download/toll-gate-[^"]*\.zip' /tmp/toll-page.html | head -n 1)
mkdir -p "$EVID/worker-zip"
curl -fsS -o "$EVID/worker-zip/$(basename "$zip")" "$worker$zip"
curl -fsS -o "$EVID/worker-zip/$(basename "$zip").sha256" "$worker$zip.sha256"
(cd "$EVID/worker-zip" && sha256sum -c "$(basename "$zip").sha256") | tee -a "$TRANSCRIPT"
curl -sS -o "$EVID/worker-contact.json" -w '%{http_code}\n' -X POST -H 'accept: application/json' -H 'content-type: application/json' "$worker/demo/contact" --data '{"message":"hi"}' | tee -a "$TRANSCRIPT"
php -r 'echo json_decode(file_get_contents($argv[1]))->error, "\n";' "$EVID/worker-contact.json" | tee -a "$TRANSCRIPT"
BASE=$worker WRITE_PATH=/demo/contact node --input-type=module <<'EOF' | tee -a "$TRANSCRIPT"
import { solveWork } from "./packages/agent/dist/index.js";
const base = process.env.BASE ?? "http://127.0.0.1:8787";
const writePath = process.env.WRITE_PATH ?? "/contact";
const denied = await fetch(base + writePath, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
const deniedBody = await denied.json();
if (denied.status !== 403 || deniedBody.error !== "toll_required" || !deniedBody.challenge) throw new Error("denied " + denied.status);
const solved = await solveWork(deniedBody.challenge.work);
if (!solved) throw new Error("solve");
const redeem = await fetch(base + "/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id: deniedBody.challenge.id, challenge: deniedBody.challenge, solution: { work: { counter: solved.counter, derivedKey: solved.derivedKey }, took_ms: 1 } }) });
if (redeem.status !== 200) throw new Error("redeem " + redeem.status);
const redeemed = await redeem.json();
if (typeof redeemed.pass !== "string") throw new Error("redeem body");
const ok = await fetch(base + writePath, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", authorization: "Toll " + redeemed.pass }, body: JSON.stringify({ message: "hi" }) });
const okBody = await ok.json();
if (ok.status !== 200 || okBody.ok !== true) throw new Error("write " + ok.status);
console.log("human path ok", denied.status, deniedBody.error, redeem.status, ok.status);
EOF

if curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:8888/ 2>/dev/null; then
  log "wordpress live: port 8888 answered; this run does not drive the admin UI"
else
  log "wordpress live: not running. The plugin journey is the download zip above."
fi

log "evidence"
test -s "$TRANSCRIPT"
test -s "$EVID/npm-test.txt"
test -s "$EVID/demo-contact.json"
test -s "$EVID/worker-contact.json"
log "verify e2e ok"
