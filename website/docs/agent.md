# Agent SDK

`@lessspam/agent` is the client for automated callers. Version 0.1.0. Test mode only. Paid requests are in testing and move no real money.

```sh
npm install @lessspam/agent@0.1.0
```

Every request sends `Toll-Client: agent`. When a write needs a pass, the client does the work and retries once.

```js
import { createAgent } from "@lessspam/agent";

const agent = createAgent({ base: "http://127.0.0.1:8787" });
const result = await agent.fetch("/contact", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "hi" }),
});
```

`result.response` is the final response. `result.via` is `work` when the client did the work, and `none` when the first response was already final.

`solveWork`, also exported from this package, runs a challenge payload in Node. Browsers use `@lessspam/widget` instead.

For a WordPress site, set `issuer` to `<site>/wp-json/toll`. The [server page](/docs/server) describes the routes the client calls.

The `toll-agent-pay` command runs against a local demo. It is for tests.
