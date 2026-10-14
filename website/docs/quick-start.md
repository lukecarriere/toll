# Quick start

Toll checks writes, not page views. Leave public pages open so people and answer engines can read you. Turn Toll on for comments, forms, logins, and APIs.

The npm packages are version 0.1.0.

- Widget: `@lessspam/widget`
- Server for Node: `@lessspam/server`
- Agent SDK: `@lessspam/agent`
- MCP server: `@lessspam/mcp`

The WordPress plugin is Toll Gate, GPL-2.0-or-later, on the [download page](/download).

## Add the check to a form

Serve `toll.js` from your own site. `@lessspam/server` does that at `/toll/v1/toll.js`.

```html
<script src="/toll/v1/toll.js" async></script>
<form method="post" action="/contact" data-toll="write">
  <button type="submit">Send</button>
  <noscript>This form needs JavaScript.</noscript>
</form>
```

While someone reads or types, the browser does a little background work. Your server checks that work and exchanges it for a short-lived pass. The pass rides along with the form post. One pass covers about 20 actions for 15 minutes.

## Check the write

On Node, install the server and reject a write that has no pass. The [server page](/docs/server) is the full setup, including PHP.

```sh
npm install @lessspam/server@0.1.0 express
```

A request with no pass gets `403` and `toll_required`. Reads stay free.

## Next

- [Widget](/docs/widget)
- [Server](/docs/server)
- [Agent SDK](/docs/agent)
- [MCP server](/docs/mcp)
- [WordPress plugin](/docs/wordpress)
- [Self-hosting](/docs/self-hosting)
