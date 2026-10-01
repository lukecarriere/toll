# Toll

Invisible checks for forms, logins, and write APIs.
High-volume clients pay more. People don't notice.

npm / composer / wp plugin / wrangler

> Not published yet. Today Toll runs from a clone (see [Run it locally](#run-it-locally)). The WordPress plugin and the edge worker are not built yet.

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

Node 22.18 or newer (TypeScript runs directly with Node's type stripping). PHP 8.1+ for the PHP vector test.

```sh
npm install
npm run demo        # http://localhost:8787
npm test            # build, typecheck, copy lint, all tests, PHP vectors
```
