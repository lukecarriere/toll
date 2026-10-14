# Widget

`@lessspam/widget` is `toll.js` for forms. Version 0.1.0. The files are self-hosted: your server serves them, and the page loads them from your own origin.

```sh
npm install @lessspam/widget@0.1.0
```

```html
<script src="/toll/v1/toll.js" async></script>
<form method="post" action="/contact" data-toll="write">
  <button type="submit">Send</button>
  <noscript>This form needs JavaScript.</noscript>
</form>
```

`data-toll="write"` marks a write. Use `data-toll="search"` for a search that is sent as a form post. A page view is not a write and stays free.

`@lessspam/server` serves the files from `Toll.router()`:

- `/toll/v1/toll.js`
- `/toll/v1/toll.worker.js`
- `/toll/v1/toll.worker-argon2id.js`
- `/toll/v1/LICENSES.txt`

You can also copy them out of the package.

```js
import { tollJs, tollWorker, tollWorkerArgon2id, licenses } from "@lessspam/widget";
```

`tollJs`, `tollWorker` and `tollWorkerArgon2id` are URLs of those files. `licenses` is the third-party notices.

## Visible check

Off by default. Add `data-toll-checkbox="true"` on the form to show a "Verify before sending" button instead of an invisible check. Most sites don't need it.

If a check would take longer than the limit, the visitor gets that button instead of waiting. Set `data-max-solve-ms` on the script tag to the same number as `max_solve_ms` on the server.

## What the visitor sees

- Working: Checking…
- Done after a visible check: Verified
- Button name: Verify before sending
- Error: Couldn't check this form.
- Error action: Try again
- No JavaScript. The line is "This form needs JavaScript."

The check never reads or sends what people type into the form.
