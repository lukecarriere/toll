---
name: verify
description: Launch, doctor, and drive a Toll checkout (site, demo form, @lessspam packages, WordPress plugin). Use after install or when scripts, routes, or packages change.
---

# Verify a Toll checkout

Public copy still comes from `docs/copy.md`. This guide is not a public page. Update it when root scripts, HTTP routes, workspace packages, or website pages change.

Needs Node `>=22.18`, PHP `>=8.1` with `ext-sodium`, Composer, and a full git history (the copy lint reads commit titles). Never print `TOLL_SECRET`, `TOLL_OWNER_KEY`, `demo/.owner-key`, or the worker `SITE_SECRET`. The demo line that a secret was generated for the run is safe. The value is not.

Run from the repository root. One full pass is `bash .cursor/skills/verify/run.sh`. It writes `.verify-e2e/` (gitignored) and leaves that directory in place after it stops the processes it started. The saved run in `docs/runs/verify-e2e/` stays as committed.

Do not run `npx wrangler deploy`. Phase 4 stays locked: the demo uses the stub backend, no real money, and no live payouts.

## Launch

Install, then build and test. `npm test` is the ready check for the tree. Servers start after it exits 0.

```sh
npm ci
(cd packages/server-php && composer install --no-interaction --no-progress)
npx playwright install --with-deps chromium
npm test
```

Expected: each command exits 0. Composer prints `Generating autoload files`. Playwright reports Chromium installed. `npm test` rebuilds, typechecks, and copy-lints, then runs the Node and PHP suites. The Node reporter includes `# fail 0` and `# cancelled 0`. `# skipped` counts WordPress tests when no local WordPress is running. Each PHP runner's last line matches `passed, 0 failed`. No line starts with `FAIL `. `tests/edge-cashu.test.ts` is part of that Node run (miniflare via `wrangler dev --local`): a 402 `creqA` names the allowlisted mint, a payment is stored and the input is spent, a replay is rejected, an unlisted mint is refused, and a crash after the swap still leaves the proofs to be restored. The same file's conservation check injects a reset after the mint reads the swap, including when checkstate is forced to `UNSPENT`, an empty, partial, or malformed restore, mint error 11001, a `PENDING` checkstate, a replay, a mint that is down, a crash before the proof write, and, after the mint commits, an HTTP 500 (JSON and plain text), 502, 503, or 429, and a 4xx with an unparseable body. For each one, sats the mint signed equal stored proofs plus pending outputs plus recorded losses. A non-200 swap leaves the row pending. `abort()` runs only after a NUT-09 restore whose signature list is empty and NUT-07 reports every input `UNSPENT`. Mint error codes do not decide that. The conservation file walks every mint status, body (including 11000, 11002, 11003, 11004, 11005, 10002, a code above 20000, and a detail-only body), and input checkstate after the mint has signed, with a nosig restore. There is no dropped bucket. `node scripts/mutate-cashu-conservation.mjs` applies the replay, `PENDING`-as-unspent, dropped-restore-as-empty, skipped-`begin`, abort-on-a-listed-code-without-restore, dropped-bucket-counted-as-conserved, abort-when-restore-is-inconclusive, and checkstate-ignored mutants and requires that conservation test to fail on each. CI runs it after `npm test`. `bash .cursor/skills/verify/run.sh` runs it after `npm test` as well. `tests/settlement-cashu-receive.test.ts` checks the same replay and `PENDING` guards on the engine.

Build stdout, inside that test, includes `strings: wrote packages/widget/src/strings.gen.ts`, the widget `dist/toll.js`, `dist/toll.worker.js`, and `dist/toll.worker-argon2id.js` lines, `widget: default path total` and `budget 25600 B`, `@lessspam/widget`, `@lessspam/server`, `@lessspam/agent`, and `@lessspam/mcp` package lines, `check-dist:` lines that are not errors, `build-wp-zip: dist-release/toll-gate-` and `build-wp-zip: sha256 `, `edge: dist/worker.js dist/site.js`, and `website: built` with `website/dist/`. It must not contain `widget: over the 25 KB gzip budget`.

Start the three local surfaces only after that. Each listens on loopback. Refuse to start one whose port is already taken.

```sh
env -u TOLL_SECRET -u TOLL_OWNER_KEY node demo/server.ts
php -S 127.0.0.1:8791 -t website/dist
node --input-type=module <<'EOF'
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
writeFileSync(".dev.vars", `SITE_SECRET="${randomBytes(24).toString("hex")}"\n`, { mode: 0o600 });
console.log("wrote .dev.vars");
EOF
node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port 8788 --show-interactive-dev-session=false
```

Ready lines: `Toll demo on http://localhost:8787`, the PHP server accepting `http://127.0.0.1:8791/`, and wrangler `Ready on http://127.0.0.1:8788`. `.dev.vars` is gitignored. Delete it in cleanup.

## Doctor

Run this before driving, and again when a request looks wrong. The process must be the one this run started.

```sh
curl -fsS http://127.0.0.1:8787/v1/health; echo
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8791/
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/
```

Expected health body: `{"ok":true,"v":"1.0.0","settlement":"stub","settlement_degraded":false,"usd_rate":"ok"}`. The site and the worker return `200`. Demo stderr also contains `TOLL_SECRET not set; using a random secret for this run.` when those variables were unset.

## Drive

Drive every feature in `features/`. The commands are curl, node, and php. Read the feature file before the matching block. A live WordPress at `http://127.0.0.1:8888` is optional. When it is down, say so and drive the plugin through the download zip. Do not treat the zip as a pass for the admin UI.

Packages, after the build inside `npm test`:

```sh
node --input-type=module <<'EOF'
import { VERSION } from "./packages/server-node/dist/index.js";
import { createAgent, cashuPayer } from "./packages/agent/dist/index.js";
import { tollJs } from "./packages/widget/dist/index.js";
import { toolList } from "./packages/mcp/dist/index.js";
import { statSync } from "node:fs";
const tools = toolList().map((t) => t.name).join(",");
if (VERSION !== "1.0.0") throw new Error("server " + VERSION);
if (typeof createAgent !== "function") throw new Error("agent");
if (typeof cashuPayer !== "function") throw new Error("cashu payer");
if (!String(tollJs).endsWith("/toll.js")) throw new Error("widget " + tollJs);
if (statSync(new URL(tollJs)).size < 100) throw new Error("toll.js");
if (tools !== "price_write_action,gate_form_write,verify_write_pass") throw new Error("mcp " + tools);
console.log("packages ok", VERSION, tools);
console.log("cashu payer ok");
EOF
php -r 'require "packages/server-php/vendor/autoload.php"; $ok = class_exists("Toll\\Protocol") && class_exists("Toll\\Settlement"); echo $ok ? "php ok\n" : "php missing\n"; exit($ok ? 0 : 1);'
```

Expected: `packages ok 1.0.0 price_write_action,gate_form_write,verify_write_pass`, then `cashu payer ok`, and `php ok`.

Demo form, with the demo listening:

```sh
base=http://127.0.0.1:8787
curl -fsS "$base/" | grep -o "Every form on this page is protected"
curl -fsS "$base/hammer" | grep -o "Bot hammer" | head -n 1
curl -fsS "$base/v1/health"; echo
curl -fsS "$base/.well-known/toll.json" | php -r '$j=json_decode(stream_get_contents(STDIN)); echo $j->name, " ", ($j->reads_free ? "reads_free" : "not_free"), " ", $j->api, "\n";'
curl -fsS "$base/.well-known/agents.json"; echo
curl -fsS -D - -o /dev/null "$base/toll/v1/toll.js" | head -n 1
curl -fsS "$base/demo/stats" | php -r '$j=json_decode(stream_get_contents(STDIN)); echo $j->accepted, " ", $j->rejected, " ", $j->mode, "\n";'
curl -sS -o /tmp/toll-contact.json -w '%{http_code}\n' -X POST -H 'accept: application/json' -H 'content-type: application/x-www-form-urlencoded' "$base/contact" --data 'message=hi'
php -r 'echo json_decode(file_get_contents("/tmp/toll-contact.json"))->error, "\n";'
```

Expected, in order: `Every form on this page is protected`, `Bot hammer`, the health JSON from Doctor, `Toll reads_free http://127.0.0.1:8787/v1`, `{"manifest":"http://127.0.0.1:8787/.well-known/toll.json"}`, `HTTP/1.1 200 OK`, a stats line ending `test payments on`, `403`, `toll_required`. Run stats before the contact POST. `accepted` may already be above 0.

Human path on the demo. It prints statuses only. It must not print the pass.

```sh
WRITE_PATH=/contact node --input-type=module <<'EOF'
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
```

Expected: `human path ok 403 toll_required 200 200`.

Static site:

```sh
site=http://127.0.0.1:8791
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
zip=$(grep -o '/download/toll-gate-[^"]*\.zip' /tmp/toll-page.html | head -n 1)
curl -fsS -o "/tmp/$(basename "$zip")" "$site$zip"
curl -fsS -o "/tmp/$(basename "$zip").sha256" "$site$zip.sha256"
(cd /tmp && sha256sum -c "$(basename "$zip").sha256")
unzip -t "/tmp/$(basename "$zip")" >/tmp/toll-unzip.txt
unzip -p "/tmp/$(basename "$zip")" toll-gate/toll-gate.php | grep -o "GPL-2.0-or-later"
unzip -p "/tmp/$(basename "$zip")" toll-gate/toll-gate.php | grep -o "Plugin Name: Toll Gate"
```

Expected headings match the file names (`<h1>Docs</h1>`, `<h1>Quick start</h1>`, `<h1>Widget</h1>`, `<h1>Server</h1>`, `<h1>Agent SDK</h1>`, `<h1>MCP server</h1>`, `<h1>WordPress plugin</h1>`, `<h1>Self-hosting</h1>`, `<h1>Download</h1>`), plus `Less traffic.`, the four mission and three legal headings, `User-agent: *`, `Allow: /`, `href="/docs"`, a `sha256sum` line ending `OK`, `GPL-2.0-or-later`, and `Plugin Name: Toll Gate`. `unzip -t` exits 0.

Worker, same pages under extension-less paths, then the demo form on the worker:

```sh
worker=http://127.0.0.1:8788
curl -fsS "$worker/" | grep -o 'href="/docs"'
for p in /docs /docs/quick-start /docs/widget /docs/server /docs/agent /docs/mcp /docs/wordpress /docs/self-hosting /download /privacy /terms /support /mission; do
  code=$(curl -sS -o /tmp/toll-page.html -w '%{http_code}' "$worker$p")
  echo "$code $p $(grep -o '<h1>[^<]*</h1>' /tmp/toll-page.html)"
done
zip=$(grep -o '/download/toll-gate-[^"]*\.zip' /tmp/toll-page.html | head -n 1)
curl -fsS -o "/tmp/$(basename "$zip")" "$worker$zip"
curl -fsS -o "/tmp/$(basename "$zip").sha256" "$worker$zip.sha256"
(cd /tmp && sha256sum -c "$(basename "$zip").sha256")
unzip -t "/tmp/$(basename "$zip")" >/dev/null
curl -sS -o /tmp/toll-worker-contact.json -w '%{http_code}\n' -X POST -H 'accept: application/json' -H 'content-type: application/json' "$worker/demo/contact" --data '{"message":"hi"}'
php -r 'echo json_decode(file_get_contents("/tmp/toll-worker-contact.json"))->error, "\n";'
BASE=$worker WRITE_PATH=/demo/contact node --input-type=module <<'EOF'
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
```

Expected: `200` and the same headings for each path, `sha256sum` `OK`, `403`, `toll_required`, and `human path ok 403 toll_required 200 200`.

Worker health, after the human path. The allowlist is set, so settlement is `cashu`. `settlement_degraded` is false when the mint answers and true when it does not. Either value is a pass here. A non-agent contact post stays `403` `toll_required`.

```sh
curl -fsS "$worker/v1/health"; echo
```

Expected body includes `"settlement":"cashu"` and `"edge":true`.

Phone width is inside `npm test` (`tests/viewport.test.ts`): `/`, `/demo`, the mission pages, the docs pages, `/download`, and the legal pages at 360 and 390. `document.scrollWidth` stays `<= window.innerWidth`.

## Evidence

The helper writes `.verify-e2e/`. That directory is gitignored, so the run does not modify tracked files. `scripts/build-wp-zip.mjs` still requires a clean tracked tree. Keep `.verify-e2e/`. It holds the transcript, `npm-test.txt`, the demo and worker logs, the contact JSON (error code only, no pass), and the downloaded plugin zip with its `.sha256`. Proof is the command, the response, and the side effect together: a 403 `toll_required` followed by a 200 write, a zip whose `sha256sum -c` prints `OK`, and `# fail 0` from `npm test`. The saved run in `docs/runs/verify-e2e/` is not rewritten.

## Cleanup

Stop only the PIDs this run recorded in `.verify-e2e/pids.txt`, and their children. Do not kill by process name. Delete `.dev.vars`. Leave `.verify-e2e/` where it is. Leave `docs/runs/verify-e2e/` untouched. `bash .cursor/skills/verify/run.sh` does this on the way out, including after a failed step.

## Helpers

`bash .cursor/skills/verify/run.sh` runs Launch, Doctor, Drive, Evidence, and Cleanup in order. The feature map is the list of what that script drives.

## Maintenance

Update this skill in the same change that does any of the following:

- change root `package.json` scripts, `engines`, or `workspaces`
- change a workspace package name, bin, or entrypoint (`packages/*/package.json`, `packages/server-php/composer.json`)
- add, remove, or retarget a demo or issuer route (`demo/server.ts`, `packages/server-node/src/http.ts`)
- add or rename a website page (`website/build.mjs`)
- change page CSS that can widen a phone layout (`website/demo.css`, `website/docs.css`, `website/site.css`, `website/home.css`)
- change a command or an expected line above
