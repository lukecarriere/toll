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

`cashuPayer` pays a `creqA` challenge from a `cashuA` or `cashuB` string, or from proofs plus the mint they belong to. `testMintPayer` stays the local test mint. An exact source is sent as it arrived. When the source is larger than the request, the payment and the leftover are `cashuB` strings, and the leftover is passed to `onChange`.

```js
import { createAgent, cashuPayer } from "@lessspam/agent";

const pay = cashuPayer({ token: process.env.TOLL_CASHU_SOURCE });
const agent = createAgent({ base: "https://pay.example.com", pay });
const result = await agent.fetch("/contact", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
```

The `toll-agent-pay` command runs against a local demo. It is for tests.
