# Demo form

The demo form at the issuer asks for a write check. A post with no pass is refused. Doing the work, redeeming, and posting again is accepted. The worker exposes the same form at `/demo/contact`.

## Sub-features

- `demo-page` shows the protected-form line and the hammer page.
- `demo-manifest` publishes reads-free discovery.
- `demo-refuse` answers a bare write with 403 `toll_required`.
- `demo-work` turns that challenge into a pass and a 200 write.
- `demo-worker` repeats the refuse and work path on the worker.

## How to get to it (user POV)

- Open the demo at `http://127.0.0.1:8787/`.
- Submit the contact form.
- Open the hammer page.
- On the worker, submit `/demo/contact`.

## Driving it with curl and node

Preconditions:

- Doctor health is `settlement` `stub`.
- Stats are read before the refusing POST.

- **Page.** `curl -fsS http://127.0.0.1:8787/` contains `Every form on this page is protected`. `curl -fsS http://127.0.0.1:8787/hammer` contains `Bot hammer`.
- **Manifest.** `/.well-known/toll.json` prints `Toll reads_free` and the `/v1` API. `/.well-known/agents.json` names the manifest URL. `toll/v1/toll.js` returns `HTTP/1.1 200 OK`.
- **Stats.** `/demo/stats` prints a mode of `test payments on`.
- **Refuse.** POST `/contact` with `message=hi` and `accept: application/json`. Status `403`, body error `toll_required`.
- **Work path.** Run the human-path program in `SKILL.md` with `WRITE_PATH=/contact`. Stdout is `human path ok 403 toll_required 200 200` and does not contain a pass.
- **Worker form.** POST `/demo/contact` on port 8788. Status `403`, error `toll_required`. Repeat the human path with `BASE=http://127.0.0.1:8788` and `WRITE_PATH=/demo/contact`.

## Gotchas

- Read the JSON body. The status alone does not show `toll_required`.
- The pass is a secret for this run. Print statuses only.
- Settlement stays on the stub. There is no live payout in this journey.
