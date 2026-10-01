# packages/mcp

Local MCP server for Toll's three write tools (Amendment 3). It runs over stdio, has no dependencies and no network service of its own. Not published anywhere (see docs/catalogs.md).

```sh
node packages/mcp/src/server.ts          # speaks MCP (JSON-RPC 2.0, one message per line) on stdin/stdout
```

Tools (names and descriptions are docs/copy.md, verbatim, from `packages/server-node/src/manifest.ts`):

| Tool | Calls | Returns |
|---|---|---|
| `price_write_action` `{site, action}` | `GET <api>/price?action=` | `{ action, price: { amount_msat, usd, status, display, basis: "current", load_multiplier }, work: { challenge_url }, reads_free }`: the price that applies now, load included, from the site's live `/price` (never the manifest's base figure) |
| `gate_form_write` `{site, action, path}` | `GET <api>/challenge?action&path&client=agent` | `{ offers, challenge, redeem_url }`: the payment offer and a work challenge |
| `gate_form_write` `{site, action, payment: {offer_id, kind, preimage, macaroon}}` | `POST <api>/redeem` | `{ paid: true, pass, exp, cls }`, a one-use pass |
| `verify_write_pass` `{site, secret, pass, action}` | `POST <api>/siteverify` | `{ valid: true, action, hostname }` or `{ valid: false, reason }` (spends one pass use) |

`<api>` is read from `<site>/.well-known/toll.json` (`api`, same origin only, cached 60 s). The tools use only the existing `/v1` contract. There is no second pay protocol, nothing gates reads, and nothing about the caller is sent or kept (the only extra header is `Toll-Client: agent`).

Counters (M11), per UTC day, no ids: `mcp_tools_list`, `mcp_call_price_write_action`, `mcp_call_gate_form_write`, `mcp_call_verify_write_pass`, `mcp_offer_returned` (a `gate_form_write` call that got at least one offer) and `mcp_paid` (a paid redeem that returned a pass). Each change is written to stderr as a JSON `counters` line; set `TOLL_MCP_COUNTERS_FILE` to also keep `{ "<day>": {...} }` in a file. The issuers count `manifest_fetch` and `agents_json_fetch` themselves.
