# @lessspam/widget

`toll.js` for forms. The files are self-hosted: your server serves them, and the page loads them from your own origin.

```html
<script src="/toll/v1/toll.js" async></script>
<form method="post" action="/contact" data-toll="write">
  <button type="submit">Send</button>
  <noscript>This form needs JavaScript.</noscript>
</form>
```

`@lessspam/server` serves these files from `Toll.router()`. You can also copy them from this package.

```js
import { tollJs, tollWorker, tollWorkerArgon2id, licenses } from "@lessspam/widget";
```

`tollJs`, `tollWorker` and `tollWorkerArgon2id` are URLs of `dist/toll.js`, `dist/toll.worker.js` and `dist/toll.worker-argon2id.js`. `licenses` is `dist/LICENSES.txt`.
