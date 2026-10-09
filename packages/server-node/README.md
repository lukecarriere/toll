# @lessspam/server

Issuer and verifier for Node. It serves the `/v1` API and the self-hosted widget at `/toll/v1/toll.js`.

```js
import express from "express";
import { Toll, loadConfig } from "@lessspam/server";

const toll = Toll.create(loadConfig("toll.yaml"));
const app = express();
app.use(Toll.router(toll));
app.post("/contact", Toll.middleware(toll, { action: "write" }), (req, res) => {
  res.status(200).json({ ok: true });
});
app.listen(8787);
```

`secret` in the config is at least 16 characters. Reads stay free. The optional backend in this version is local and for tests.
