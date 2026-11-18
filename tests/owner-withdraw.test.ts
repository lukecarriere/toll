// Owner books and withdraw on the site worker, run in Node: the Durable Object SQL over node:sqlite
// and the loopback keyset mint behind the configured mint URL (the same proxy the worker tests use).
// No real mint is called and no sats move.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { doStorage } from "./do-harness.ts";
import { randomHex } from "../packages/protocol/src/bytes.ts";
import { toHex } from "../packages/protocol/src/bytes.ts";
import { encodeBolt11 } from "../packages/settlement-ln/src/bolt11.ts";
import { decodeTokenV4 } from "../packages/settlement-ln/src/cashu.ts";
import { secretY } from "../packages/settlement-ln/src/cashu-crypto.ts";
import { startKeysetMint } from "../packages/settlement-ln/src/keyset-mint.ts";
import { resolveLightningAddress } from "../packages/settlement-ln/src/cashu-melt.ts";
import { ownerRoute } from "../packages/edge-cf/src/owner.ts";
import type { TollDoStub } from "../packages/edge-cf/src/do-store.ts";

const MINT = "https://mint.minibits.cash/Bitcoin";
const KEY = "owner-key-for-tests-only-0123456789abcdef";
let mint: Awaited<ReturnType<typeof startKeysetMint>>;
let s: ReturnType<typeof doStorage>;
let d: ReturnType<ReturnType<typeof doStorage>["open"]>;
let env: Record<string, string>;
let seeded: string[] = [];

before(async () => { mint = await startKeysetMint(); });
after(async () => { await mint?.close(); });
beforeEach(() => {
  mint.setFault(null, null);
  mint.setMeltFees({ reserve: 2, fee: 1 });
  env = { OWNER_KEY: KEY, CASHU_MINTS: JSON.stringify([MINT]), TOLL_TEST_HOOKS: "1", CASHU_FETCH_PROXY: mint.url };
  s = doStorage();
  d = s.open(env);
  seeded = [];
});

/** Store proofs worth `amount` as if paid in, at the configured mint. */
function seed(amount: number) {
  for (const p of decodeTokenV4(mint.token(amount)).proofs) {
    s.db.prepare("INSERT INTO cashu_proof (secret, mint, unit, amount, keyset, c) VALUES (?, ?, 'sat', ?, ?, ?)").run(p.secret, MINT, p.amount, mint.keysetId, toHex(p.C));
    seeded.push(p.secret);
  }
}

const invoice = (sat: number) => encodeBolt11({ amountMsat: sat * 1000, paymentHash: randomHex(32) });

async function owner(path: string, body?: unknown, o: { key?: string | null; method?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = o.key === undefined ? KEY : o.key;
  if (key !== null) headers.authorization = "Bearer " + key;
  const req = new Request("https://lessspam.dev" + path, { method: o.method ?? (body === undefined ? "GET" : "POST"), headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await ownerRoute(req, env, d as unknown as TollDoStub, o.ip ?? "203.0.113.9");
  if (!res) return null;
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}

async function books() {
  const r = await owner("/v1/owner/books");
  assert.equal(r?.status, 200, r?.text);
  return r!.body;
}

function storedSum(): number {
  return Number((s.db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM cashu_proof").get() as { n: number }).n);
}

test("owner routes do not exist while OWNER_KEY is unset or short: the site answers as before", async () => {
  seed(10);
  for (const k of [undefined, "", "short-key"]) {
    env = { CASHU_MINTS: JSON.stringify([MINT]) };
    if (k !== undefined) env.OWNER_KEY = k;
    assert.equal(await owner("/v1/owner/books"), null);
    assert.equal(await owner("/v1/owner/withdraw", { invoice: invoice(5) }), null);
    assert.equal(await owner("/v1/owner/withdraw/check", { quote: "abc" }), null);
  }
  assert.equal(storedSum(), 10, "nothing moved");
});

test("a missing or wrong owner key is 401, and repeated failures are rate limited", async () => {
  seed(10);
  assert.equal((await owner("/v1/owner/books", undefined, { key: null }))?.status, 401);
  assert.equal((await owner("/v1/owner/books", undefined, { key: KEY + "x" }))?.status, 401);
  assert.equal((await owner("/v1/owner/withdraw", { invoice: invoice(5) }, { key: KEY.slice(0, -1) }))?.status, 401);
  for (let i = 0; i < 10; i++) assert.equal((await owner("/v1/owner/books", undefined, { key: "nope", ip: "198.51.100.7" }))?.status, 401);
  assert.equal((await owner("/v1/owner/books", undefined, { key: "nope", ip: "198.51.100.7" }))?.status, 429);
  assert.equal((await owner("/v1/owner/books", undefined, { ip: "198.51.100.7" }))?.status, 429, "the limit holds for that address");
  assert.equal((await owner("/v1/owner/books"))?.status, 200, "another address is not limited");
  assert.equal(storedSum(), 10);
});

test("books: stored amounts per mint and counts only, never a proof value", async () => {
  seed(37);
  s.db.prepare("INSERT INTO cashu_proof (secret, mint, unit, amount, keyset, c) VALUES (?, ?, 'sat', ?, ?, ?)").run("other-secret", "https://mint.other.example", 4, mint.keysetId, "02" + "cd".repeat(32));
  const r = await owner("/v1/owner/books");
  assert.equal(r?.status, 200);
  assert.deepEqual(r!.body.mints, [
    { mint: MINT, stored_sat: 37, proofs: seeded.length, withdrawing_sat: 0, withdrawals_pending: 0 },
    { mint: "https://mint.other.example", stored_sat: 4, proofs: 1, withdrawing_sat: 0, withdrawals_pending: 0 },
  ].sort((a, b) => a.mint.localeCompare(b.mint)));
  assert.equal(r!.body.stored_sat, 41);
  assert.equal(r!.body.withdrawn_sat, 0);
  for (const secret of [...seeded, "other-secret"]) assert.ok(!r!.text.includes(secret), "no secret in the body");
  assert.ok(!/"(secret|C|c|C_|B_|r|inputs|outputs)"/.test(r!.text), "no proof fields");
  assert.equal((await owner("/v1/owner/nope"))?.status, 404);
});

test("withdraw melts stored proofs to the invoice, stores the change, and books amount and fee", async () => {
  seed(64);
  const inv = invoice(20);
  const r = await owner("/v1/owner/withdraw", { invoice: inv });
  assert.equal(r?.status, 200, r?.text);
  assert.equal(r!.body.state, "paid");
  assert.equal(r!.body.amount_sat, 20);
  assert.equal(r!.body.fee_sat, 1);
  assert.equal(r!.body.change_sat, 64 - 20 - 1);
  assert.ok(!r!.text.includes(inv), "the invoice is not echoed");
  assert.deepEqual(mint.meltsPaid(), [inv]);
  const b = await books();
  assert.equal(b.stored_sat, 43);
  assert.equal(b.withdrawn_sat, 20);
  assert.equal(b.withdraw_fee_sat, 1);
  assert.equal(b.withdrawing_sat, 0);
  assert.equal(storedSum() + b.withdrawn_sat + b.withdraw_fee_sat, 64, "every sat is stored, paid out, or fee");
  // The change is real: it pays a second withdrawal at the same mint.
  const again = await owner("/v1/owner/withdraw", { invoice: invoice(30) });
  assert.equal(again?.body.state, "paid", again?.text);
  assert.equal(storedSum() + (await books()).withdrawn_sat + (await books()).withdraw_fee_sat, 64);
  assert.equal(mint.meltsPaid().length, 2);
});

test("a PAID reply without the change still stores it, from restore of the blank outputs", async () => {
  seed(64);
  mint.setFault("/v1/melt/bolt11", "no-change");
  const r = await owner("/v1/owner/withdraw", { invoice: invoice(20) });
  assert.equal(r!.body.state, "paid", r?.text);
  assert.equal(r!.body.change_sat, 43);
  assert.equal(r!.body.fee_sat, 1);
  assert.equal(storedSum(), 43);
});

test("withdraw refuses before any melt: no amount, too much, fee over the cap, bad input", async () => {
  seed(32);
  const posts = mint.meltPosts();
  const noAmount = encodeBolt11({ amountMsat: 1000, paymentHash: randomHex(32) }).replace(/^lnbc10n/, "lnbc");
  const cases: [unknown, string][] = [
    [{ invoice: invoice(40) }, "insufficient"],
    [{ invoice: invoice(10), max_fee_sat: 1 }, "fee_too_high"],
    [{ invoice: "lnbc1notaninvoice" }, "bad_invoice"],
    [{ invoice: invoice(10), mint: "https://mint.other.example" }, "insufficient"],
    [{}, "malformed"],
    [{ invoice: invoice(10), max_fee_sat: -1 }, "malformed"],
  ];
  for (const [body, error] of cases) {
    const r = await owner("/v1/owner/withdraw", body);
    assert.equal(r?.status, 400, JSON.stringify(body));
    assert.equal(r!.body.error, error, JSON.stringify(body));
  }
  const na = await owner("/v1/owner/withdraw", { invoice: noAmount });
  assert.equal(na?.status, 400);
  assert.ok(["amount_required", "bad_invoice"].includes(na!.body.error));
  assert.equal(mint.meltPosts(), posts, "no melt was sent");
  assert.equal(storedSum(), 32);
  assert.equal((await books()).withdrawing_sat, 0);
});

test("a melt quote for another amount than the invoice is refused before anything is reserved or melted", async () => {
  seed(32);
  const posts = mint.meltPosts();
  mint.setMeltQuoteAmount(11);
  try {
    const r = await owner("/v1/owner/withdraw", { invoice: invoice(10) });
    assert.equal(r?.status, 400, r?.text);
    assert.equal(r!.body.error, "mint_bad_quote");
  } finally {
    mint.setMeltQuoteAmount(null);
  }
  assert.equal(mint.meltPosts(), posts, "no melt was sent");
  assert.equal(storedSum(), 32);
  assert.equal(Number((s.db.prepare("SELECT COUNT(*) AS n FROM cashu_withdraw").get() as { n: number }).n), 0, "nothing reserved");
});

test("a melt the mint refuses returns every proof in one write", async () => {
  seed(32);
  mint.setFault("/v1/melt/bolt11", "refuse");
  const r = await owner("/v1/owner/withdraw", { invoice: invoice(10) });
  assert.equal(r?.status, 502, r?.text);
  assert.equal(r!.body.state, "released");
  assert.equal(storedSum(), 32);
  const left = s.db.prepare("SELECT secret FROM cashu_proof ORDER BY secret").all().map((x) => String((x as { secret: string }).secret));
  assert.deepEqual(left, [...seeded].sort(), "the same proofs are back");
  const b = await books();
  assert.equal(b.withdrawn_sat, 0);
  assert.equal(b.withdrawals_pending.length, 0);
  mint.setFault("/v1/melt/bolt11", "unpaid");
  const unpaid = await owner("/v1/owner/withdraw", { invoice: invoice(10) });
  assert.equal(unpaid!.body.state, "released");
  assert.equal(storedSum(), 32);
});

test("a lost melt response stays pending with the proofs held, and check settles it from the mint", async () => {
  seed(32);
  mint.setFault("/v1/melt/bolt11", "drop-after");
  const r = await owner("/v1/owner/withdraw", { invoice: invoice(10) });
  assert.equal(r?.status, 202, r?.text);
  assert.equal(r!.body.state, "pending");
  let b = await books();
  assert.equal(b.withdrawing_sat + b.stored_sat, 32, "held, not lost");
  assert.ok(b.withdrawing_sat >= 12);
  assert.deepEqual(b.withdrawals_pending.map((w: { quote: string }) => w.quote), [r!.body.quote]);
  mint.setFault(null, null);
  const c = await owner("/v1/owner/withdraw/check", { quote: r!.body.quote });
  assert.equal(c?.status, 200, c?.text);
  assert.equal(c!.body.state, "paid");
  assert.equal(c!.body.fee_sat, 1);
  b = await books();
  assert.equal(b.withdrawing_sat, 0);
  assert.equal(b.stored_sat + b.withdrawn_sat + b.withdraw_fee_sat, 32);
  const twice = await owner("/v1/owner/withdraw/check", { quote: r!.body.quote });
  assert.equal(twice!.body.state, "paid", "a second check changes nothing");
  assert.equal((await books()).withdrawn_sat, 10);
});

test("a pending Lightning payment keeps the proofs until the mint settles it either way", async () => {
  seed(32);
  seed(32);
  mint.setFault("/v1/melt/bolt11", "pending");
  const a = await owner("/v1/owner/withdraw", { invoice: invoice(10) });
  const z = await owner("/v1/owner/withdraw", { invoice: invoice(10) });
  assert.equal(a!.body.state, "pending");
  assert.equal(z!.body.state, "pending");
  mint.setFault(null, null);
  assert.equal((await owner("/v1/owner/withdraw/check", { quote: a!.body.quote }))!.body.state, "pending", "still in flight");
  const held = storedSum();
  mint.settleMelt(a!.body.quote, "UNPAID");
  const released = await owner("/v1/owner/withdraw/check", { quote: a!.body.quote });
  assert.equal(released!.body.state, "released");
  assert.ok(storedSum() > held);
  mint.settleMelt(z!.body.quote, "PAID");
  const paid = await owner("/v1/owner/withdraw/check", { quote: z!.body.quote });
  assert.equal(paid!.body.state, "paid");
  const b = await books();
  assert.equal(b.stored_sat + b.withdrawn_sat + b.withdraw_fee_sat, 64);
  assert.equal(b.withdrawn_sat, 10);
  assert.equal((await owner("/v1/owner/withdraw/check", { quote: "unknown" }))?.status, 404);
});

test("two withdrawals at once cannot spend the same proof", async () => {
  seed(32);
  const [x, y] = await Promise.all([owner("/v1/owner/withdraw", { invoice: invoice(20) }), owner("/v1/owner/withdraw", { invoice: invoice(20) })]);
  const label = (r: { body: { state: string; error?: string } }) => r.body.state === "refused" ? r.body.error : r.body.state;
  const states = [label(x!), label(y!)].sort();
  assert.deepEqual(states, ["insufficient", "paid"]);
  const b = await books();
  assert.equal(b.stored_sat + b.withdrawn_sat + b.withdraw_fee_sat, 32);
});

test("the melt inputs are spent at the mint and gone from the store; nothing else changed", async () => {
  seed(16);
  const r = await owner("/v1/owner/withdraw", { invoice: invoice(8) });
  assert.equal(r!.body.state, "paid");
  const res = await fetch(mint.url + "/v1/checkstate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ Ys: seeded.map(secretY) }) });
  const states = (await res.json()).states.map((x: { state: string }) => x.state);
  assert.deepEqual(states, seeded.map(() => "SPENT"));
  const left = s.db.prepare("SELECT secret FROM cashu_proof").all().map((x) => String((x as { secret: string }).secret));
  assert.ok(seeded.every((sec) => !left.includes(sec)));
  const row = s.db.prepare("SELECT state, inputs, outputs FROM cashu_withdraw").get() as { state: string; inputs: string; outputs: string };
  assert.deepEqual({ ...row }, { state: "paid", inputs: "[]", outputs: "[]" }, "a closed row keeps no proof");
});

test("a Lightning address resolves to an invoice for exactly the amount, over https only", async () => {
  const pr = invoice(21);
  const seen: string[] = [];
  const fake = (pay: string, callback = "https://pay.example.com/cb?x=1") => (async (url: string | URL | Request) => {
    const href = String(url);
    seen.push(href);
    if (href.includes("/.well-known/lnurlp/")) return new Response(JSON.stringify({ tag: "payRequest", callback, minSendable: 1000, maxSendable: 1_000_000_000, metadata: "[]" }));
    return new Response(JSON.stringify({ pr: pay }));
  }) as typeof fetch;
  assert.equal(await resolveLightningAddress("Owner@Pay.Example.com", 21, fake(pr)), pr);
  assert.equal(seen[0], "https://pay.example.com/.well-known/lnurlp/owner");
  assert.equal(new URL(seen[1]).searchParams.get("amount"), "21000");
  await assert.rejects(resolveLightningAddress("owner@pay.example.com", 21, fake(invoice(22))), /malformed/);
  await assert.rejects(resolveLightningAddress("owner@pay.example.com", 21, fake(pr, "http://pay.example.com/cb")), /malformed/);
  for (const bad of ["owner@127.0.0.1", "owner@localhost", "nobody", "a@b"]) await assert.rejects(resolveLightningAddress(bad, 21, fake(pr)), /malformed/);
});

for (const callback of ["https://127.0.0.1/cb", "https://10.0.0.5/cb", "https://169.254.169.254/latest", "https://[::1]/cb", "https://localhost/cb", "https://192.168.1.1/cb", "https://pay.local/cb", "https://pay.internal/cb"]) {
  test("a Lightning address callback on a non-public host is refused before it is fetched: " + callback, async () => {
    const pr = invoice(21);
    const seen: string[] = [];
    const fake = (async (url: string | URL | Request) => {
      seen.push(String(url));
      if (String(url).includes("/.well-known/lnurlp/")) return new Response(JSON.stringify({ tag: "payRequest", callback, minSendable: 1000, maxSendable: 1_000_000_000, metadata: "[]" }));
      return new Response(JSON.stringify({ pr }));
    }) as typeof fetch;
    await assert.rejects(resolveLightningAddress("owner@pay.example.com", 21, fake), /malformed/);
    assert.equal(seen.length, 1, "the callback was not fetched");
  });
}
