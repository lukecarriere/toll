#!/bin/sh
# Live check for the public site.
# The price tool's payment object stays a stub when the gate charges, so this reads
# the gate_form_write tool, not the first "payment" field in the file.
# A post without the agent header gets the work challenge (403). With it, the gate is 402.
set -eu
BASE="${1:-https://lessspam.dev}"
export CHECK_BASE="$BASE"
export EXPECT_PAYMENT="${EXPECT_PAYMENT:-cashu}"
exec node --input-type=module <<'JS'
const base = process.env.CHECK_BASE.replace(/\/$/, "");
const expect = process.env.EXPECT_PAYMENT;
const text = async (res) => {
  const body = await res.text();
  if (!res.ok && res.status !== 402) throw new Error(res.status + " " + body.slice(0, 200));
  return body;
};
console.log("health:");
console.log(await text(await fetch(base + "/v1/health")));
console.log("price:");
console.log(await text(await fetch(base + "/v1/price?action=write")));
const manifest = JSON.parse(await text(await fetch(base + "/.well-known/toll.json")));
const gate = (manifest.tools ?? []).find((t) => t && t.name === "gate_form_write");
if (!gate) {
  console.error("no gate_form_write");
  process.exit(2);
}
const status = String(gate.payment?.status ?? "");
console.log("gate_form_write payment: " + status);
if (status !== expect) {
  console.error("gate payment is " + status + ", expected " + expect);
  process.exit(1);
}
const posted = await fetch(base + "/demo/contact", {
  method: "POST",
  headers: { accept: "application/json", "content-type": "application/json", "toll-client": "agent" },
  body: "{}",
});
const postedBody = await posted.text();
console.log("POST /demo/contact " + posted.status);
console.log(postedBody);
if (posted.status !== 402) {
  console.error("POST status is " + posted.status + ", expected 402");
  process.exit(1);
}
JS
