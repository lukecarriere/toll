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
```

Stop the demo and the site server when finished.

## Maintenance

Update this guide in the same change that does any of the following:

- change root `package.json` scripts, `engines`, or `workspaces`
- change a workspace package name, bin, or entrypoint (`packages/*/package.json`, `packages/server-php/composer.json`)
- add, remove, or retarget a demo or issuer route (`demo/server.ts`, `packages/server-node/src/http.ts`)
- add or rename a website page (`website/build.mjs`)
- change a command or an expected line above
