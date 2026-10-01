# Where Toll sits

Amendment 2 §B, as written. For contributors, not a public screen.

The web is growing a second audience. Some of that traffic only reads. Some of it writes. Some of it copies pages into a model. Those are different events. Price them differently.

Three jobs already exist around reading. Toll does not do them.

1. **Allow, charge, or block a known crawler on the fetch.** A site can let a search crawler read, charge a crawler for access, or refuse it. This needs the crawler to identify itself. Anonymous scripts cannot pay this way. Edge networks already sell this. Toll must not reimplement it.
2. **Get paid when a page is used, not when it is fetched.** A citation, a quote, or a recommendation is a later event. The buyer reports the use, a platform bills them, the publisher is paid monthly. That is a carriage deal for sites agents already know. Toll must not reimplement it.
3. **Charge an identified agent per API call.** HTTP 402, the agent pays, the response is released. Useful when the request is the product. Toll's machine rail is this shape for writes, aimed at callers who may not be on a verified-bot list.

Toll's job is the fourth one: make high-volume *writes* expensive, without asking who the caller is. A person pays once with a short background check. A swarm pays per action or leaves. Public reading stays free so a site nobody has heard of can still be fetched, cited, and found.

Putting Toll on page views fights discovery. Putting Toll on comments does not.

A site can use both. Allow answering crawlers on public pages. Block or license training crawlers somewhere else. Put Toll on the form. They clash only if Toll gates the read.

## Discovery

Agents find Toll as a tool, not as a page: see AMENDMENT_3.md. Each host serves `/.well-known/toll.json` (free, no check) and a local MCP server exposes the same three write tools. The website stays the human front door; the manifest is what an agent installs. Catalog status: docs/catalogs.md.
