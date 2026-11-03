# Agent calls

Your agent doesn't need to read the docs. It needs this table.

Calls go to the site's origin, for example `https://lessspam.dev`. On WordPress the same routes are under `/wp-json/toll/v1/`.

| You ask | Your agent calls |
|---|---|
| Does this site use Toll? How do I get through it? | `GET /.well-known/toll.json` |
| Where's the agent manifest? | `GET /.well-known/agents.json` |
| Add Toll to my agent's tools. | MCP server `npx -y @lessspam/mcp@0.1.0`, which adds `price_write_action`, `gate_form_write` and `verify_write_pass` |
| Is Toll up on this site? | `GET /v1/health` |
| What does one comment or form post cost here right now? | MCP `price_write_action` `{site}`, or `GET /v1/price?action=write`. On lessspam.dev a write is 10,000 msat. |
| And a search, a signup, an admin action? | `price_write_action` with `action` set to `search`, `account` or `admin`, or `GET /v1/price?action=…`. On lessspam.dev: 2,000, 25,000 and 100,000 msat. |
| Do I pay to read the page? | Nothing to call. Page views are free (`reads_free: true` in `/v1/price`). |
| Get me a pass to post this form. | MCP `gate_form_write` `{site, action, path}`, which calls `GET /v1/challenge?action=write&client=agent`. You get a work challenge plus any payment offers. |
| Do the work instead of paying. | Solve the challenge, then `POST /v1/redeem` with `{challenge_id, challenge, solution}`. You get a pass. On lessspam.dev it covers 20 writes. |
| Do all of that for me in code. | `@lessspam/agent`: `createAgent(...)` sends `Toll-Client: agent`, does the work, and retries once. |
| Pay for one write on the lessspam.dev demo. | `POST /v1/demo/agent`. Unpaid, it returns `402 payment_required` with `x-cashu: creqA…`. Send it again with `X-Cashu: cashuA…` or `cashuB…` to get a pass for one write. Mint: Minibits. |
| Pay that demo with a BOLT11 mint quote instead. | Same `POST /v1/demo/agent`. The 402's `www-authenticate` header carries the offer. Pay the invoice, then send it again with the `Authorization` scheme that header names and the macaroon. Adding `:preimage` is optional. |
| Is my pass still good? | `GET /v1/status` with `Authorization: Toll <pass>`. It doesn't spend a use. `n` is the uses left. |
| Did this comment come with a valid pass? (site owner) | MCP `verify_write_pass` `{site, secret, pass}`, or `POST /v1/siteverify` with your site secret. Spends one use. |
| Protect a form on my Node server. | `Toll.middleware(toll, { action: "write" })` from `@lessspam/server`. `Toll.router()` serves `/v1` and the widget. |
| Protect a form on my WordPress site. | `data-toll="write"` on the form, then `toll_gate_verify_request('write')` before you handle the post. |
| Load the form widget. | `<script src="/toll/v1/toll.js">` and `data-toll="write"` on the form. |
| How many writes has the demo accepted? | `GET /demo/stats` |
| Why did my post get a 403? | It had no pass: `403 toll_required`, with a fresh challenge. Get a pass and send it again. |
| Why did I get a 402? | `payment_required`: pay the offer, or fetch the `challenge_url` in the body and do the work. |
| Why a 400 `bad_action`? | `read` isn't a paid action. Use `write`, `search`, `account` or `admin`. |
| Why a 400 `malformed` from `/v1/redeem`? | The body needs `challenge_id`, `challenge` and `solution` for the challenge you got. |
