// CI guard (spec §21): no secrets, secret names or payment connection strings in the widget build.
import { readFileSync, readdirSync } from "node:fs";
import { ROOT } from "./copy-lib.mjs";

const dir = ROOT + "packages/widget/dist/";
const forbidden = [/TOLL_SECRET/, /TOLL_NWC/, /nostr\+walletconnect:\/\//i, /\bnwc_uri\b/i, /\bmacaroon_hex\b/i, /\bsite_secret\b/i];
const env = process.env.TOLL_SECRET;
let bad = 0;
// Zero third-party calls from visitors (spec §21, Amendment 1 §F): the JS the visitor loads must not
// contain any absolute URL (no CDN, no cloud verification), nor any captcha SaaS endpoint.
const noUrls = /https?:\/\/(?!www\.w3\.org\/)[a-z0-9.-]+/i;
const saas = /turnstile|recaptcha|hcaptcha|challenges\.cloudflare|sentinel|jsdelivr|unpkg|cdnjs/i;
for (const f of readdirSync(dir)) {
  const text = readFileSync(dir + f, "utf8");
  if (f.endsWith(".js")) {
    const u = noUrls.exec(text);
    if (u) { console.error(`check-dist: ${f} contains an absolute URL ${u[0]} (visitors must make no third-party calls)`); bad++; }
    const v = saas.exec(text);
    if (v) { console.error(`check-dist: ${f} mentions ${v[0]}`); bad++; }
  }
  for (const re of forbidden) if (re.test(text)) { console.error(`check-dist: ${f} matches ${re}`); bad++; }
  if (env && env.length >= 8 && text.includes(env)) { console.error(`check-dist: ${f} contains the TOLL_SECRET value`); bad++; }
  // Any secret configured for the demo or tests must not leak either.
  for (const cfg of ["demo/toll.yaml", "toll.example.yaml"]) {
    try {
      const m = /^secret:\s*(\S+)/m.exec(readFileSync(ROOT + cfg, "utf8"));
      if (m && !m[1].startsWith("env:") && text.includes(m[1])) { console.error(`check-dist: ${f} contains the secret from ${cfg}`); bad++; }
    } catch { /* file may not exist */ }
  }
}
if (bad) process.exit(1);
console.log("check-dist: widget dist has no secrets, connection strings, absolute URLs or captcha SaaS references");
