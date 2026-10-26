# Site

The public site is the homepage, four mission pages, the docs, the download page, and Privacy, Terms, and Support. The same pages are served by the static build and by the worker.

## Sub-features

- `site-home` shows the homepage title line and the docs link.
- `site-mission` shows Mission, Vision, Values, and Where Toll fits.
- `site-docs` shows each guide heading.
- `site-legal` shows Privacy, Terms, and Support.
- `site-worker` serves those pages and the download zip from the worker.
- `site-phone` keeps every built page within a 360 and 390 viewport.

## How to get to it (user POV)

- Open `/` on the static site or the worker.
- Open Mission, Vision, Values, and Where Toll fits from the header.
- Open Docs, then each guide, then Download.
- Open Privacy, Terms, and Support from the footer.

## Driving it with curl and node

Preconditions:

- `npm test` has exited 0, so `website/dist/` exists and the phone-width test passed.
- `php -S 127.0.0.1:8791 -t website/dist` is the site this run started.
- The worker is `Ready on http://127.0.0.1:8788`.

- **Homepage.** `curl -fsS http://127.0.0.1:8791/`. The body contains `Less traffic.` and `href="/docs"`.
- **Mission pages.** Fetch `mission.html`, `vision.html`, `values.html`, and `ecosystem.html`. Headings are `Mission`, `Vision`, `Values`, and `Where Toll fits`.
- **Docs and download.** Fetch each `docs/*.html` page and `download/index.html`. Headings are Docs, Quick start, Widget, Server, Agent SDK, MCP server, WordPress plugin, Self-hosting, and Download.
- **Legal pages.** Fetch `privacy.html`, `terms.html`, and `support.html`. Headings are Privacy, Terms, and Support.
- **Robots.** `curl -fsS http://127.0.0.1:8791/robots.txt` contains `User-agent: *` and `Allow: /`.
- **Worker pages.** Fetch `/`, `/mission`, `/docs`, each guide, `/download`, `/privacy`, `/terms`, and `/support` on port 8788. Each status is 200 and the heading matches the static page.
- **Phone width.** `npm test` already ran `tests/viewport.test.ts`. The reporter shows `# fail 0`.

## Gotchas

- Static files use `.html`. The worker does not.
- A page can pass a heading check and still overflow a phone. The viewport test is the width proof.
- `npx wrangler deploy` publishes and can create DNS records. This journey uses `wrangler dev` only.
