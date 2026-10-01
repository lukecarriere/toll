// Generates docs/settlement-vectors.json (spec §19.9, docs/settlement.md §14): price (Q3), fee (Q5),
// USD display (Q4), and paid redeem on the LOCAL TEST BACKEND: offer -> test invoice -> preimage ->
// settle pass (Q6: n = 1, exp = now + 60), plus rejection cases.
// The offer credential and invoice here are the stub's TEST-ONLY stand-ins (sealed HMAC caveats and a
// fake "lnstub1" string). Real credentials and invoices come from the settlement engine
// (docs/adapters.md §2); Toll never parses them. Everything is deterministic: fixed secret, shared
// test preimage, deterministic settler, fixed offer ids and pass ids. Run: npm run vectors:settlement
import { writeFileSync } from "node:fs";
import { type PassClaims, sha256, fromHex, toHex, signPass } from "../packages/protocol/src/index.ts";
import {
  StubSettler, mintOffer, verifyPaidRedeem, offerAmountMsat, priceMsat, splitFee, usdDisplay, offerUsd, stubEngineSecret, feePercent, paymentRequired, type Offer,
} from "../packages/settlement-ln/src/index.ts";

const SECRET = "toll-test-vector-secret-do-not-use";
const SITE = "site_abc123";
const NOW = 1790000000;
const PREIMAGE = "5e" + "11".repeat(31); // shared test preimage (spec §8.6.7), test only
const OTHER_PREIMAGE = "5e" + "22".repeat(31);
const engine_secret = await stubEngineSecret(SECRET);
const settler = new StubSettler({ sharedPreimage: PREIMAGE, deterministic: true });

// Q3: policy price rounded to integer msat, then up to a whole 1,000 msat.
const price_cases = ([
  ["search", 1, 1], ["write", 1, 1], ["account", 1, 1], ["admin", 1, 1],
  ["write", 1.1, 1], ["search", 1, 1.25], ["search", 1.0004, 1], ["write", 1.5, 1.3], ["admin", 2, 1], ["search", 0.3, 1],
] as const).map(([cls, velocity_mult, suspicion_mult]) => ({ cls, velocity_mult, suspicion_mult, price_msat: priceMsat(cls, velocity_mult, suspicion_mult), amount_msat: offerAmountMsat(cls, velocity_mult, suspicion_mult) }));

// Q5: fee = floor(gross * fee_bps / 10000), net = gross - fee.
const fee_cases = ([[10000, 1000], [2000, 1234], [1, 1000], [999, 10000], [12345, 0], [50000, 1000], [25000, 333]] as const).map(([gross_msat, fee_bps]) => ({ gross_msat, fee_bps, ...splitFee(gross_msat, fee_bps) }));

// {fee} in owner copy (docs/copy.md "Money"): fee_bps / 100, trailing zeros dropped.
const fee_display_cases = [1000, 750, 25, 0, 1, 1005, 1230, 1234, 10000].map((fee_bps) => ({ fee_bps, fee: feePercent(fee_bps) }));

// Q4: owner totals (two decimals, rounded down, "less than $0.01"), offer display (4 places, rounded
// up), null = hide when the rate is missing or older than 900 s. Rates are illustrative test values.
const usdRows: [number, number | null, number][] = [
  [180000, 100000, 0], [100, 100000, 0], [0, 100000, 0], [45000, 100000, 0], [1_000_000_000, 100000, 0], [10000, 100000, 0], [2000, 100000, 0],
  [10000, 63412.57, 0], [25000, 63412.57, 0], [1234567, 63412.57, 0], [999999999, 63412.57, 0],
  [10000, 100000, 900], [10000, 100000, 901], [10000, null, 0],
];
const usd_cases = usdRows.map(([msat, usd_per_btc, age_s]) => {
  const fx = usd_per_btc === null ? null : { usd_per_btc, fetched_at: NOW - age_s, source: "test" };
  return { msat, usd_per_btc, fetched_at: fx?.fetched_at ?? null, now: NOW, owner: usdDisplay(msat, fx, NOW), offer: offerUsd(msat, fx, NOW) ?? null };
});

async function offer(cls: "search" | "write" | "account" | "admin", id: string, now = NOW, site = SITE): Promise<Offer> {
  return mintOffer({ secret: engine_secret, site, cls, amount_msat: offerAmountMsat(cls), settler, now, ttl_s: 120, fixed: { id } });
}
const payment_hash = toHex(await sha256(fromHex(PREIMAGE)));

const paid = [];
for (const [k, cls] of (["write", "search", "account"] as const).entries()) {
  const o = await offer(cls, `off_00000000000000000000000${k + 1}`);
  const at = NOW + 5;
  const r = await verifyPaidRedeem({ secret: engine_secret, site: SITE, offer_id: o.id, preimage: PREIMAGE, macaroon: o.macaroon, now: at, firstUse: async () => true });
  const claims: PassClaims = { v: 1, site: SITE, sub: `pass_5e771e000000000${k}`, cls, n: 1, iat: at, exp: at + 60, jti: `5e771e00000000000000000000000${k}`.padEnd(32, "0") };
  paid.push({
    name: `paid ${cls}`,
    offer: o,
    preimage: PREIMAGE,
    payment_hash,
    now: at,
    expect: { cls: r.cls, amount_msat: r.amount_msat },
    ledger: { fee_bps: 1000, gross_msat: r.amount_msat, ...splitFee(r.amount_msat, 1000) },
    settle_pass: { claims, token: await signPass(SECRET, claims), valid_at: at + 59, expired_at: at + 60 },
  });
}

const o1 = paid[0].offer;
const o2 = await offer("search", "off_0000000000000000000000ff");
const oOtherSite = await offer("write", "off_0000000000000000000000ee", NOW, "site_other");
const flip = (s: string) => s.slice(0, -2) + (s.endsWith("AA") ? "BB" : "AA");
const paid_invalid = [
  { name: "wrong preimage", offer_id: o1.id, macaroon: o1.macaroon, preimage: OTHER_PREIMAGE, now: NOW + 5, expect: "bad_solution" },
  { name: "credential from another offer (substituted invoice)", offer_id: o1.id, macaroon: o2.macaroon, preimage: PREIMAGE, now: NOW + 5, expect: "bad_sig" },
  { name: "tampered credential payload", offer_id: o1.id, macaroon: flip(o1.macaroon.split(".")[0]) + "." + o1.macaroon.split(".")[1], preimage: PREIMAGE, now: NOW + 5, expect: "bad_sig" },
  { name: "tampered credential seal", offer_id: o1.id, macaroon: flip(o1.macaroon), preimage: PREIMAGE, now: NOW + 5, expect: "bad_sig" },
  { name: "expired offer", offer_id: o1.id, macaroon: o1.macaroon, preimage: PREIMAGE, now: o1.exp + 1, expect: "expired" },
  { name: "offer for another site", offer_id: oOtherSite.id, macaroon: oOtherSite.macaroon, preimage: PREIMAGE, now: NOW + 5, expect: "wrong_site" },
  { name: "malformed preimage", offer_id: o1.id, macaroon: o1.macaroon, preimage: "5e11", now: NOW + 5, expect: "malformed" },
  { name: "uppercase preimage is malformed (the issuer lowercases before calling)", offer_id: o1.id, macaroon: o1.macaroon, preimage: PREIMAGE.toUpperCase(), now: NOW + 5, expect: "malformed" },
];
// Agent gate (docs/settlement.md §4): the 402 body links the work challenge instead of carrying one.
const gate_cases = [
  { action: "write", path: "/contact", offers: [o1] },
  { action: "search", path: "/search?q=a b&x=1", offers: [o2] },
  { action: "write", path: "/wp-comments-post.php", offers: [o1] },
].map((c) => {
  const r = paymentRequired(SITE, c.action, c.path, c.offers);
  return { site: SITE, action: c.action, path: c.path, status: r.status, www_authenticate: r.headers["www-authenticate"], body: r.body };
});

// Stateful (replay store): the same offer + preimage twice -> second is "replay". Node only.
const paid_replay = { offer_id: o1.id, macaroon: o1.macaroon, preimage: PREIMAGE, now: NOW + 5, expect: ["ok", "replay"] };

const out = {
  version: 1,
  about: "Toll settlement vectors (phase 2, local test backend). Offer credentials and lnstub1 invoices are test-only stand-ins from the stub engine; real ones come from the settlement engine and are opaque to Toll. Amounts are integer msat. The secret and preimages are for tests only.",
  secret: SECRET,
  engine_secret,
  engine_secret_derivation: "HMAC-SHA256(key = Toll secret, message = 'toll/settlement/stub/v1'), lowercase hex",
  site: SITE,
  base_msat: { search: 2000, write: 10000, account: 25000, admin: 100000 },
  price_rule: "amount_msat = ceil(round(base_msat[cls] * velocity_mult * suspicion_mult) / 1000) * 1000",
  fee_rule: "fee_msat = floor(gross_msat * fee_bps / 10000); net_msat = gross_msat - fee_msat",
  fee_display_rule: "{fee} = fee_bps / 100, plain number, trailing zeros dropped (docs/copy.md Money)",
  usd_rule: "fresh = rate > 0 and now - fetched_at <= 900. owner: cents = floor(msat * rate / 1e9 + 1e-6); '$D.CC', 'less than $0.01' when msat > 0 and cents < 1. offer: units = ceil(msat * rate / 1e7 - 1e-6); 'D.UUUU'. null when not fresh. Rounding confirmed in docs/copy.md 'Money': owner totals round down to the cent, offers round up to $0.0001.",
  settle_pass_rule: "pass claims n = 1, exp = iat + 60 (Q6); same token format as work passes",
  gate_rule: "agent 402 body = {error: 'payment_required', challenge_url, offers} in that key order; no inline challenge. challenge_url = '/v1/challenge?' + form-encoded site, action, path, client=agent, offers=0 (root-relative to the issuer). WWW-Authenticate = L402 macaroon=\"<offers[0].macaroon>\", invoice=\"<offers[0].invoice>\". The work challenge is minted only when challenge_url is fetched.",
  price_cases,
  fee_cases,
  fee_display_cases,
  usd_cases,
  paid,
  paid_invalid,
  paid_replay,
  gate_cases,
};
writeFileSync(new URL("../docs/settlement-vectors.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`settlement vectors: ${price_cases.length} price, ${fee_cases.length} fee, ${fee_display_cases.length} fee display, ${usd_cases.length} usd, ${paid.length} paid, ${paid_invalid.length} paid_invalid, 1 replay, ${gate_cases.length} gate`);
