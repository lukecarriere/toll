# Server

Two servers speak the same `/v1` API. Node is the published package `@lessspam/server` at version 0.1.0. PHP is the `Toll\Protocol` library shipped inside the WordPress plugin (GPL-2.0-or-later), under `lib/server-php`. That library is not a separate package on a public PHP registry.

Reads stay free. A write with no pass gets `403` and `toll_required`. The pass cookie is `toll_pass`. The header is `Authorization: Toll`.

Paid requests in this version use a local test backend. No real money moves.

The hosted demo at lessspam.dev is the exception: it settles real Cashu payments through the Minibits mint.

## Node

```sh
npm install @lessspam/server@0.1.0 express
```

`secret` in the config is at least 16 characters. Put it in the environment. Do not commit it.

```yaml
site_id: site_abc123
secret: env:TOLL_SECRET
issuer_public_url: http://127.0.0.1:8787
routes:
  - { prefix: "/", class: read }
  - { prefix: "/contact", class: write }
```

The `/` route keeps every page view free. A route's class applies to writes under that prefix.

```js
import express from "express";
import { Toll, loadConfig } from "@lessspam/server";

const toll = Toll.create(loadConfig("toll.yaml"));
const app = express();
app.use(Toll.router(toll));
app.post("/contact", Toll.middleware(toll, { action: "write" }), (req, res) => {
  res.status(200).json({ ok: true });
});
app.listen(8787);
```

`Toll.router()` serves `/v1` and the widget files. `Toll.middleware()` checks the pass before your handler runs.

Behind a reverse proxy, list it in the `TOLL_TRUSTED_PROXIES` environment variable (comma-separated addresses and ranges). Toll does not read the framework's proxy setting.

## PHP

From a checkout, run `composer install` in `packages/server-php`, then load `vendor/autoload.php`. Inside the plugin zip the same library is `lib/server-php`.

```php
<?php
require __DIR__ . '/vendor/autoload.php';

use Toll\Protocol;

$claims = Protocol::verifyPass($secret, $pass, time(), $siteId, 'write');
```

A bad pass throws `Toll\TollError`. The WordPress plugin is the PHP issuer: the same routes live under `/wp-json/toll/v1/`. On a theme form, call `toll_gate_verify_request('write')` before handling the post. The [WordPress page](/docs/wordpress) covers that.

## /v1 API

- `GET /v1/health` reports the issuer.
- `GET /v1/challenge` returns a challenge for a write. Asking for a read is refused.
- `POST /v1/redeem` turns finished work into a pass.
- `GET /v1/status` reports whether a pass is still good, without spending a use.
- `POST /v1/siteverify` is for your own server. Send the secret and the pass. It spends one use.
- `GET /v1/price` returns the current check for one write, and the work alternative. It mints nothing.

`GET /.well-known/toll.json` and `GET /.well-known/agents.json` are free. They describe the write check. They do not identify the caller.
