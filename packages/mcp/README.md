# @lessspam/mcp

Local MCP server for Toll's three write tools. It speaks JSON-RPC 2.0 on stdin and stdout, one message per line. It calls a site's existing `/v1` API and runs no network service of its own.

```sh
npx toll-mcp
```

From a clone, the same program is `node packages/mcp/src/server.ts`.

| Tool | Role |
|---|---|
| `price_write_action` | The current check for one write, and the work alternative |
| `gate_form_write` | Asks the site for a one-use pass for one write |
| `verify_write_pass` | For the site's own server: checks a pass |

The site is an origin such as `https://example.com`. The tools read `<site>/.well-known/toll.json` and call that origin only. Nothing about the caller is sent or kept. Counters are per UTC day, with no ids, and are written to stderr.

Test mode only.
