# Privacy

Plain-language, not legal advice. Last updated October 15, 2026.

## The MCP server

The `@lessspam/mcp` package runs on your own computer. It stores no data and has no service of its own. It only sends requests to the site you name in each tool call, and only to that site's public `/v1` API.

## This site

- Pages, docs and downloads are static files. There are no analytics, no ads and no tracking scripts.
- The demo form is checked and then thrown away. Its name, email and message are not read, stored or logged.
- To rate-limit the demo, the site keeps a counter keyed by your network address. The counter resets each window and is never linked to anything you type.
- When you pass the check, the site sets one short-lived cookie, `toll_pass`. It holds the pass and nothing else, and it expires within minutes.
- The demo keeps daily totals of accepted and rejected sends. These are plain counts with no personal data.
- Our hosting provider handles the network traffic for this site and may keep its own short-term request records.

## Questions

See [Support](/support).
