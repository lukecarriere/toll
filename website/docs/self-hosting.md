# Self-hosting

Toll runs on your server. Nothing is sent to us. Page views stay free. Checks run where you installed them.

## Packages

Install the published packages at version 0.1.0 and run them yourself. You do not need this website's worker to do that.

- `@lessspam/widget` serves the page script. See [Widget](/docs/widget).
- `@lessspam/server` is the Node issuer. See [Server](/docs/server).
- `@lessspam/agent` is the automated client. See [Agent SDK](/docs/agent).
- `@lessspam/mcp` is the local tool server. See [MCP server](/docs/mcp).
- The WordPress plugin is the PHP issuer. See [WordPress](/docs/wordpress) and [Download](/download).

`secret` is at least 16 characters. Keep it in the environment or a Worker secret. Do not commit it, and do not print it.

## This site's worker

The toll-site worker serves this static site and a work-only demo. The store is one SQLite-backed Durable Object, `TollStoreDO`. From a clean checkout:

```sh
npm ci
npm run build
npx wrangler deploy
```

`npm run build` writes the worker bundle and the static files the config points at. `npx wrangler deploy` publishes that worker. The config sets `workers_dev` and has no route and no zone, so the command does not change DNS.

Set `SITE_SECRET` before the demo can issue checks:

```sh
npx wrangler secret put SITE_SECRET
```

To run it on your own machine instead of publishing, copy `.dev.vars.example` to `.dev.vars`, replace the placeholder, and start `npx wrangler dev --local`. The placeholder is not a secret you can reuse.
