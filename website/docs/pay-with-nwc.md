# Pay with NWC

An agent can pay a write on lessspam.dev through NWC. The CLI detects the 402, pays the BOLT11 mint quote, and retries with the Authorization header. Page views stay free. Cashu remains an offer on the same 402.

This page covers the live path on lessspam.dev. A self-hosted server leaves the mint-quote offer off unless `L402_ENABLED` is `1`. No real money moves on the self-hosted server's stub backend.

## Connect

Point the CLI at an NWC connection first. Use `npx @getalby/cli connect` or `auth`, or pass `-c` / set `NWC_URL`. The CLI's own help covers setup. Do not paste a connection secret into a ticket or a log.

## Pay one write

On lessspam.dev, `POST /v1/demo/agent` is the pay URL (`/.well-known/toll.json` names it as `pay`). An unpaid post returns `402 payment_required`. The `www-authenticate` header carries the mint-quote offer. The body also has a `challenge_url` if you would rather do the work instead.

```sh
npx @getalby/cli fetch "https://lessspam.dev/v1/demo/agent" --method POST --max-amount N
```

Set `N` at or above the price of that write. On lessspam.dev a write is 10,000 msat. The CLI's `--help` names the units for `--max-amount`.

The CLI pays the invoice in the offer, then sends the same post again with the Authorization scheme that header names and the macaroon. Adding `:preimage` is optional: if the mint has already marked the quote paid, the retry is accepted without it. A paid post returns a pass for one write.

The mint-quote offer expires in at most 120 seconds. If the retry is late, request a fresh 402 and pay the new offer. Do not pay an expired invoice.

This pay URL does not need a `Toll-Client: agent` header. On another write path that returns the same 402, send `Toll-Client: agent` (or `client=agent` on the query) so the retry is treated as an agent payment.

## What this is not

The CLI is the payer. Toll does not receive into an NWC connection of its own, and it does not host connections for agents. Cashu on the same 402, and the work challenge, stay available.

For the other agent calls, see [Agent calls](/docs/ask). For the agent SDK, see [Agent SDK](/docs/agent).
