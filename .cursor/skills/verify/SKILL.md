---
name: verify
description: Install, build, test, lint, start, and smoke-check a Toll checkout. Update this guide when scripts, routes, or packages change.
---

# Verify a checkout

Update this guide whenever root scripts, HTTP routes, or workspace packages change. Public copy still comes from `docs/copy.md`. This guide is not a public page.

Needs Node `>=22.18`, PHP `>=8.1` with `ext-sodium`, Composer, and a full git history (the copy lint reads commit titles). Never print `TOLL_SECRET`, `TOLL_OWNER_KEY`, `demo/.owner-key`, or any other secret. The demo line that a secret was generated for the run is safe; the value is not.

Run from the repository root.

## Install

```sh
npm ci
(cd packages/server-php && composer install --no-interaction --no-progress)
npx playwright install --with-deps chromium
```

Expected: each command exits 0. Composer prints `Generating autoload files`. Playwright reports Chromium installed.

## Build

```sh
npm run build
```

Expected: exit 0. Stdout includes each of these:

- `strings: wrote packages/widget/src/strings.gen.ts`
- `widget: dist/toll.js `
- `widget: dist/toll.worker.js `
- `widget: dist/toll.worker-argon2id.js `
- `widget: default path total ` and `budget 25600 B`
- `packages: @lessspam/widget dist/index.js`
- `packages: @lessspam/server dist/index.js + dist/widget`
- `packages: @lessspam/agent dist/index.js dist/agent-pay.js`
- `packages: @lessspam/mcp dist/index.js`
- `check-dist: widget dist has no secrets, connection strings, absolute URLs or captcha SaaS references`
- `check-dist: @lessspam/widget tarball `
- `check-dist: @lessspam/server tarball `
- `check-dist: @lessspam/agent tarball `
- `check-dist: @lessspam/mcp tarball `
- `build-wp-zip: dist-release/toll-gate-`
- `build-wp-zip: sha256 `
- `edge: dist/worker.js dist/site.js`
- `website: built ` and `website/dist/`

Stdout must not contain `widget: over the 25 KB gzip budget` or a `check-dist:` line that starts with an error.

## Lint

```sh
npm run lint:copy
npm run typecheck
```

Expected: both exit 0. `npm run` prints its script header. The copy lint line matches `copy-lint: <files> files, <titles> commit titles, <rules> rules from docs/copy.md, <vendors> vendor names from docs/adapters.md, 0 hits`. `tsc` prints no diagnostics.

## Test

```sh
npm test
```

Expected: exit 0. The script rebuilds, typechecks, and copy-lints, then runs the Node and PHP suites. The Node reporter includes `# fail 0` and `# cancelled 0`. `# skipped` counts WordPress tests when no local WordPress is running. Each PHP runner's last line matches `passed, 0 failed`. No line starts with `FAIL `.

## Start locally

```sh
npm run demo
```

Expected, after the build, on stderr:

```
[demo] TOLL_SECRET not set; using a random secret for this run.
[demo] Toll demo on http://localhost:8787  (issuer + widget, paid requests on the local test backend, fixed test rate 100000, standard mode)
```

The process listens on `127.0.0.1:8787`. Leave it running for the smoke checks. When `TOLL_SECRET` is already set, the first line is absent.

## Smoke

Demo, with `npm run demo` running:

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

Expected, in order:

```
Every form on this page is protected
Bot hammer
{"ok":true,"v":"1.0.0","settlement":"stub","settlement_degraded":false,"usd_rate":"ok"}
Toll reads_free http://127.0.0.1:8787/v1
{"manifest":"http://127.0.0.1:8787/.well-known/toll.json"}
HTTP/1.1 200 OK
0 0 test payments on
403
toll_required
```

`accepted` may be higher than `0` if a write already landed. `rejected` rises by 1 after the contact check, so run the stats line before that POST.

Human path, still with `npm run demo` running. This does the work, redeems a pass, and retries the write. It prints statuses only. It must not print the pass.

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

Expected:

```
human path ok 403 toll_required 200 200
```

Packages and the built site, after `npm run build`:

```sh
node --input-type=module <<'EOF'
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
php -r 'require "packages/server-php/vendor/autoload.php"; $ok = class_exists("Toll\\Protocol") && class_exists("Toll\\Settlement"); echo $ok ? "php ok\n" : "php missing\n"; exit($ok ? 0 : 1);'
php -S 127.0.0.1:8791 -t website/dist
```

Leave the site server running, then:

```sh
site=http://127.0.0.1:8791
curl -fsS "$site/" | grep -o "Less traffic." | head -n 1
curl -fsS "$site/mission.html" | grep -o "<h1>Mission</h1>"
curl -fsS "$site/vision.html" | grep -o "<h1>Vision</h1>"
curl -fsS "$site/values.html" | grep -o "<h1>Values</h1>"
curl -fsS "$site/ecosystem.html" | grep -o "<h1>Where Toll fits</h1>"
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
```

Expected:

```
packages ok 1.0.0 price_write_action,gate_form_write,verify_write_pass
php ok
Less traffic.
<h1>Mission</h1>
<h1>Vision</h1>
<h1>Values</h1>
<h1>Where Toll fits</h1>
User-agent: *
Allow: /
href="/docs"
200 docs/index.html <h1>Docs</h1>
200 docs/quick-start.html <h1>Quick start</h1>
200 docs/widget.html <h1>Widget</h1>
200 docs/server.html <h1>Server</h1>
200 docs/agent.html <h1>Agent SDK</h1>
200 docs/mcp.html <h1>MCP server</h1>
200 docs/wordpress.html <h1>WordPress plugin</h1>
200 docs/self-hosting.html <h1>Self-hosting</h1>
200 download/index.html <h1>Download</h1>
toll-gate-0.1.0.zip: OK
GPL-2.0-or-later
```

`unzip -t` exits 0. The sha256 line names whatever version the plugin header has; `0.1.0` is that version today.

Stop the demo and the site server when finished.

## Phone width

`npm test` includes this. To run it on its own, after Install:

```sh
node --test tests/viewport.test.ts
```

Expected: exit 0. The reporter includes `# fail 0`. The test serves the built pages and opens `/`, `/demo`, every docs page, and `/download` at 360px and 390px. Each page must satisfy `document.scrollWidth <= window.innerWidth`, and `innerWidth` must be the requested width.

## Site worker

The same build serves the toll-site worker: static pages, the work-only demo, and the `TollStoreDO` Durable Object. `wrangler.toml` keeps `workers_dev = true` and attaches the production custom domains, so a deploy creates or keeps their DNS records. The production hostname is the custom domain; the `workers.dev` name stays as a fallback.

Write a local secret without printing it, then start the worker. `.dev.vars` is gitignored.

```sh
node --input-type=module <<'EOF'
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
writeFileSync(".dev.vars", `SITE_SECRET="${randomBytes(24).toString("hex")}"\n`, { mode: 0o600 });
console.log("wrote .dev.vars");
EOF
npx wrangler dev --local --ip 127.0.0.1 --port 8788 --show-interactive-dev-session=false
```

Expected: `Ready on http://127.0.0.1:8788`. Leave it running.

```sh
worker=http://127.0.0.1:8788
curl -fsS "$worker/" | grep -o 'href="/docs"'
for p in /docs /docs/quick-start /docs/widget /docs/server /docs/agent /docs/mcp /docs/wordpress /docs/self-hosting /download; do
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

Expected:

```
href="/docs"
200 /docs <h1>Docs</h1>
200 /docs/quick-start <h1>Quick start</h1>
200 /docs/widget <h1>Widget</h1>
200 /docs/server <h1>Server</h1>
200 /docs/agent <h1>Agent SDK</h1>
200 /docs/mcp <h1>MCP server</h1>
200 /docs/wordpress <h1>WordPress plugin</h1>
200 /docs/self-hosting <h1>Self-hosting</h1>
200 /download <h1>Download</h1>
toll-gate-0.1.0.zip: OK
403
toll_required
human path ok 403 toll_required 200 200
```

Stop the worker when finished.

## Deploy

From the repository root, after Install and Build, on a clean checkout. This is the command that publishes the toll-site worker. It does not change DNS. Do not run it as part of a local check.

```sh
npx wrangler deploy
```

Check the bundle without publishing:

```sh
npx wrangler deploy --dry-run --outdir /tmp/toll-site-dry
```

Expected: exit 0, and a `gzip:` size for the worker script. `--dry-run` does not deploy.

`SITE_SECRET` is a Worker secret. Set it with `npx wrangler secret put SITE_SECRET` before the demo can issue checks. Never print it. Never commit it.

## Maintenance

Update this guide in the same change that does any of the following:

- change root `package.json` scripts, `engines`, or `workspaces`
- change a workspace package name, bin, or entrypoint (`packages/*/package.json`, `packages/server-php/composer.json`)
- add, remove, or retarget a demo or issuer route (`demo/server.ts`, `packages/server-node/src/http.ts`)
- add or rename a website page (`website/build.mjs`)
- change page CSS that can widen a phone layout (`website/demo.css`, `website/docs.css`, `website/site.css`, `website/home.css`)
- change a command or an expected line above
