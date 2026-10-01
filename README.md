# Toll

Invisible checks for forms, logins, and write APIs.
High-volume clients pay more. People don't notice.

npm / composer / wp plugin / wrangler

> Not published yet. Today Toll runs from a clone (see [Run it locally](#run-it-locally)). The WordPress plugin and the edge worker run locally only (packages/wp-toll-gate, packages/edge-cf).

## How it works

1. Add `toll.js` to your page and `data-toll="write"` to a form.
2. While the visitor reads or types, the browser does a few hundred milliseconds of background work.
3. The work is checked by your server and exchanged for a short-lived pass.
4. The pass rides along with the form post, so pressing Send just sends.
5. One pass covers about 20 actions for 15 minutes, so a person pays once per visit.
6. Requests without a pass are rejected. Scripts that skip the check get nowhere.
7. Clients that send a lot of requests have to do the work again and again.
8. Reads stay free. You choose which routes count as search, write, account or admin.
9. Optional usage payouts for operators: high-volume clients can pay per request instead, and you withdraw the collected value. (Coming in a later release.)
10. No puzzles, no tracking pixels.

```html
<script src="https://cdn.example.com/toll/v1/toll.js" async></script>
<form method="post" action="/contact" data-toll="write">
  <!-- fields -->
  <button type="submit">Send</button>
  <noscript>This form needs JavaScript.</noscript>
</form>
```

On the server (Node):

```js
import { Toll, loadConfig } from "@toll/server";
const toll = Toll.create(loadConfig("toll.yaml"));
app.use(Toll.router(toll));                                   // /v1/* and /toll/v1/toll.js
app.post("/contact", Toll.middleware(toll, { action: "write" }), handler);
```

## Privacy

- The check never reads or sends what people type into your forms.
- No third-party cookies. The pass lives in a first-party `toll_pass` cookie or in memory.
- No IP-based blocking. Shared networks only change how much work is asked, never whether a person gets through.
- Nothing is sent to us. Checks run on your own server.

## Protocol

The wire protocol, the work rule and shared test vectors are in [docs/protocol.md](docs/protocol.md) and [docs/vectors.json](docs/vectors.json). Words we use and avoid: [docs/copy.md](docs/copy.md).

## Run it locally

Node 22.18 or newer (TypeScript runs directly with Node's type stripping). PHP 8.1+ with Composer for the PHP vector test (ext-sodium for hardened mode).

```sh
npm install
(cd packages/server-php && composer install)
npm run demo        # http://localhost:8787  (TOLL_WORK_MODE=hardened for the memory-hard mode)
npm test            # build, typecheck, copy lint, all tests, PHP vectors
npm run bench       # solve times, standard and hardened, desktop and phone-like
npm run agent-pay -- --writes 5   # with the demo running: an automated client pays per request (test backend, no real money)
packages/wp-toll-gate/dev/setup-local-wp.sh   # local WordPress with the plugin: http://127.0.0.1:8888 (see packages/wp-toll-gate/README.md)
npm run dev -w packages/edge-cf   # the edge worker under wrangler dev, local only (see packages/edge-cf/README.md)
```

## Internal notes

For the team; review before any public release.

- **Engines (Amendment 1, 2026-09-30).** Toll keeps the `/v1` API, the signed envelope, policy, passes, `<toll-gate>` and the agent SDK. The proof-of-work puzzle comes from a pinned, MIT-licensed, self-hosted engine, which runs only as a headless solver in workers behind `<toll-gate>`. It never renders UI and never calls a network service. Payments, when they arrive, go through an MIT-licensed reverse proxy, and this build has only a stub of it. The picks, pinned versions, licences, measured sizes and the reasoning are in [docs/adapters.md](docs/adapters.md). The copy lint keeps vendor names out of this README and every visitor-facing surface.
- **Paid requests (phase 2, test backend only).** Automated clients that identify themselves get a per-request offer and a one-use, 60-second pass after paying; everyone else keeps the invisible check. The demo runs this on a local test backend with a fixed test rate for USD (not a market price). No real money moves. Operator withdrawals work against the test backend only (owner API, used by the WordPress plugin's Payment server setting). Details: [docs/settlement.md](docs/settlement.md).
- **Modes.** `work.mode: standard` (PBKDF2, the default) or `hardened` (Argon2id, memory-hard). Measured solve times for both modes are in [docs/policy.md](docs/policy.md) §3.
- **Widget size.** The default path is 7.5 KB gzipped (`toll.js` plus one worker). Hardened mode adds a 14.5 KB gzipped worker, loaded only in that mode. Third-party notices ship as `/toll/v1/LICENSES.txt`.
