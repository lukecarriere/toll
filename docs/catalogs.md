# Catalogs (Amendment 3): where Toll would be listed, and what each listing waits on

Status on Oct 1, 2026: **nothing submitted.** No public host, no real manifest URL, no real payable offer, and no yes from Luke yet. Listing is free; buying placement is out of scope.

What exists locally and is shared by every row:

- `GET /.well-known/toll.json` on the Node issuer, the WordPress plugin and the edge worker. It is free (no pass, no challenge, no payment) and carries the three write tools, `reads_free: true`, `not_for`, and prices derived from the live offer function with `status` "test" or "stub". `GET /.well-known/agents.json` is a pointer to it.
- `packages/mcp`: a local stdio MCP server with exactly `price_write_action`, `gate_form_write` and `verify_write_pass`, using docs/copy.md wording. It calls each site's existing `/v1` API.
- Payment: `stub` (docs/adapters.md §4). The only completable offer is the `/v1` ln402 offer on the local test backend.

| Catalog | Ready | Waiting on |
|---|---|---|
| **x402 Bazaar** (CDP discovery: `/discovery/resources`, `/discovery/search`, MCP `search_resources`), as an HTTP endpoint and as an MCP resource | Manifest shape, tool input schemas (the Bazaar extension wants a strict JSON Schema for `input`), MCP tools, and price derivation shared with the 402. | 1. **A real payable x402 offer.** x402 isn't wired (adapters.md §4); it needs Luke's yes to a second rail, a facilitator, and a `payTo` address (test network first). 2. **A public host.** Resource URLs must be absolute https with no IP literal or loopback. 3. **One successful settlement through the CDP facilitator**, with `paymentPayload.resource` set and the bazaar extension declared on the route. There is no separate registration step: the Bazaar indexes on first settlement. 4. **Luke's yes** to list. Amendment 3: do not submit until a real offer exists. |
| **Official MCP registry** (registry.modelcontextprotocol.io) | The stdio server and its three tools. The `server.json` fields are known: name, description (the 147-character seed), version, packages and/or remotes. | 1. **A package or remote the registry can verify.** Either publish `@toll/mcp` to npmjs.org (with ownership metadata), or host a public streamable-HTTP MCP endpoint (not built; stdio only today). 2. **Namespace auth:** `io.github.lukecarriere/*` via GitHub login, or a domain namespace via `/.well-known/mcp-registry-auth` on a public host. 3. **Luke's yes** to publish (an npm publish and a registry entry are both public). |
| **Toll's own docs** (a line that shows the manifest URL) | docs/protocol.md §7 documents `https://<toll-host>/.well-known/toll.json`. The local URLs are `http://127.0.0.1:8787`, `:8888` and `:8789`. | A public host, to replace `<toll-host>` with a real URL. The website pages stay as written (Amendment 2); the ecosystem paragraph says agents find Toll in public tool catalogs without naming one. |

Amendment 3 names no other catalogs. Don't build Toll's own catalog of other people's tools.
