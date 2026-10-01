# packages/agent

Toll client for automated callers (phase 2). It pays the per-request offer instead of doing the work, and does the work when no offer is available. Toll's own code (Amendment 1): invoices and credentials are opaque strings from the issuer, never parsed here.

```ts
import { createAgent, testBackendPayer } from "@toll/agent";
const agent = createAgent({ base: "http://localhost:8787", pay: testBackendPayer("http://localhost:8787") });
const r = await agent.fetch("/contact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
// r.via: "paid" | "work" | "none"; r.offer.amount_msat; r.offer.display?.usd
```

- Every request sends `Toll-Client: agent`.
- 402 with an offer: `pay(offer)` returns the preimage → `POST /v1/redeem` → one-use 60 s pass → retry once with `Authorization: Toll <pass>`.
- 403 with only a work challenge (paid requests off or paused): solve it with the work engine's Node solver and retry once (`work: false` turns that off).
- `pay` is yours to supply. `testBackendPayer(base)` uses the demo's test-only `POST /demo/stub-pay` and moves no real money.
- `maxAmountMsat` refuses offers above a limit.

## agent-pay

```
npm run demo                              # in one terminal
npm run agent-pay -- --writes 5           # or: node demo/agent-pay.mjs --writes 20 [--base URL] [--json]
```

Pays N writes to `/contact` (doing the work instead when no offer is available, unless `--no-work`), prints one line per write (status, rail/class of the pass, pass shape, amount in msat and USD, client timings: pay, solve, redeem, total), then checks that the same preimage is rejected (`401 replay`) and the spent pass is refused, and prints each amount in msat and USD (from the offer) plus the site ledger totals (gross, fee held, net, in msat, and USD) from `/demo/stats`. It also prints the server counters for the run: `offer_shown`, `paid`, `settled_msat`, and passes accepted by rail (work vs settle). Exits non-zero if any check fails.
