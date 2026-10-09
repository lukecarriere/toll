# @lessspam/agent

Client for automated callers. It sends `Toll-Client: agent`. When a write needs a pass, it does the work and retries once. Test mode only.

```js
import { createAgent, solveWork } from "@lessspam/agent";

const agent = createAgent({ base: "http://127.0.0.1:8787" });
const result = await agent.fetch("/contact", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "hi" }),
});
```

`solveWork` solves a challenge payload in Node. Browsers use `@lessspam/widget` instead.

The `toll-agent-pay` command runs against a local demo. It is for tests.
