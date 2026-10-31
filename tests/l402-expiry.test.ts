// Expired macaroons and retryable 503s on the production quote path. The mint is local; nothing is paid.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeBolt11, startKeysetMint } from "../packages/settlement-ln/src/index.ts";
import { PASS_COOKIE, guardFetch } from "../packages/server-node/src/http.ts";
import { startDemo } from "./helpers.ts";

const PUBLIC = "https://pay.example.com/Bitcoin";
const LOST = "mint signed; signatures were not recovered";

const saved = process.env.L402_ENABLED;
after(() => {
  if (saved === undefined) delete process.env.L402_ENABLED;
  else process.env.L402_ENABLED = saved;
});

type Fault = (path: string, init: RequestInit | undefined) => Response | null;

/** The allowlisted mint host is proxied to the local mint. `fault` may answer a call in its place. */
async function boot() {
  const mint = await startKeysetMint({ quotes: true });
  process.env.L402_ENABLED = "1";
  const clock = { now: Math.floor(Date.now() / 1000) };
  const box: { fault: Fault | null } = { fault: null };
  const proxied: typeof fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(href);
    const i = u.pathname.indexOf("/v1/");
    const path = i >= 0 ? u.pathname.slice(i) : u.pathname;
    const faulted = box.fault?.(path, init);
    if (faulted) return faulted;
    return fetch(new URL(mint.url).origin + path + u.search, init);
  };
  const dir = mkdtempSync(join(tmpdir(), "toll-l402-expiry-"));
  const demo = await startDemo({
    work: { standard: { cost: 500 } },
    settlement: { enabled: true, backend: "stub", fee_bps: 1000, fx: { source: "none" }, cashu: { enabled: true, mints: [PUBLIC], store: join(dir, "proofs.json") } },
  }, { now: () => clock.now, settlement: { mintGuard: { lookup: async () => ["1.1.1.1"], fetch: proxied } } });
  const close = async () => { delete process.env.L402_ENABLED; await demo.close(); await mint.close(); };
  return { mint, demo, clock, box, close };
}

async function paidOffer(env: Awaited<ReturnType<typeof boot>>) {
  const denied = await fetch(env.demo.url + "/contact", { method: "POST", headers: agentHeaders(), body: "{}" });
  const body = await denied.json();
  assert.equal(denied.status, 402, JSON.stringify(body));
  const m = /^L402 macaroon="([^"]+)", invoice="([^"]+)"$/.exec(denied.headers.get("www-authenticate") ?? "");
  assert.ok(m);
  assert.equal(decodeBolt11(m[2]).amountMsat, 10_000);
  const paid = await fetch(env.mint.url + "/test/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: m[2] }) });
  const preimage = ((await paid.json()) as { preimage: string }).preimage;
  assert.equal(paid.status, 200);
  const macaroon = m[1];
  const quote = JSON.parse(Buffer.from(macaroon.split(".")[0], "base64url").toString()).quote as string;
  const exp = body.offers[1].exp as number;
  const authorization = `L402 ${macaroon}:${preimage}`;
  const send = () => fetch(env.demo.url + "/contact", { method: "POST", headers: agentHeaders({ authorization }), body: "{}" });
  return { quote, exp, send, authorization };
}

function agentHeaders(extra: Record<string, string> = {}) {
  return { accept: "application/json", "content-type": "application/json", "toll-client": "agent", ...extra };
}

async function quoteState(mintUrl: string, quote: string): Promise<string> {
  return ((await (await fetch(mintUrl + "/v1/mint/quote/bolt11/" + quote)).json()) as { state: string }).state;
}

/** QA's #41 sequence: both mint posts outlive the 1.5 s timeout; `signLate` lets the mint sign afterwards. */
async function timeOutBothPosts(mint: Awaited<ReturnType<typeof startKeysetMint>>, quote: string, send: () => Promise<Response>) {
  const first = mint.holdNextMint();
  const pending = send();
  const a = await first;
  const second = mint.holdNextMint();
  const b = await second;
  const res = await pending;
  return {
    res, body: await res.json(),
    signLate: async () => {
      a.release();
      b.release();
      for (let i = 0; i < 100 && (await quoteState(mint.url, quote)) !== "ISSUED"; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(await quoteState(mint.url, quote), "ISSUED");
    },
  };
}

function booked(env: Awaited<ReturnType<typeof boot>>, quote: string) {
  const stored = (env.demo.store.mintQuoteStored?.() ?? []).filter((o) => o.quote === quote).reduce((n, o) => n + o.amount, 0);
  const lost = (env.demo.store.mintQuoteLosses?.() ?? []).filter((o) => o.quote === quote).reduce((n, o) => n + o.amount, 0);
  return { stored, lost };
}

test("an expired macaroon on a kept reservation books the late signature as stored, once, and grants no pass", async () => {
  const env = await boot();
  try {
    const { quote, exp, send } = await paidOffer(env);
    const missed = await timeOutBothPosts(env.mint, quote, send);
    assert.equal(missed.res.status, 503, JSON.stringify(missed.body));
    await missed.signLate();
    env.clock.now = exp + 1;
    const posts = env.mint.mintPosts();
    for (let i = 0; i < 3; i++) {
      const late = await send();
      const body = await late.json();
      assert.equal(late.status, 401, JSON.stringify(body));
      assert.equal(body.error, "expired");
      assert.deepEqual(booked(env, quote), { stored: 10, lost: 0 }, "the restored signatures are stored once, with no loss");
    }
    assert.equal(env.mint.mintPosts(), posts, "an issued quote is restored, not posted again");
  } finally {
    await env.close();
  }
});

test("an expired macaroon on a kept reservation the mint cannot restore books one loss across retries", async () => {
  const env = await boot();
  try {
    const { quote, exp, send } = await paidOffer(env);
    const missed = await timeOutBothPosts(env.mint, quote, send);
    assert.equal(missed.res.status, 503, JSON.stringify(missed.body));
    env.mint.setStuckMint(true);
    await missed.signLate();
    env.clock.now = exp + 1;
    for (let i = 0; i < 3; i++) {
      const lost = await send();
      const body = await lost.json();
      assert.equal(lost.status, 503, JSON.stringify(body));
      assert.equal(body.detail, LOST);
      assert.deepEqual(booked(env, quote), { stored: 0, lost: 10 });
    }
  } finally {
    await env.close();
  }
});

test("an expired macaroon on a paid quote that was never minted books the sats as stored, not as a loss", async () => {
  const env = await boot();
  try {
    const { quote, exp, send } = await paidOffer(env);
    env.clock.now = exp + 1;
    for (let i = 0; i < 2; i++) {
      const late = await send();
      const body = await late.json();
      assert.equal(late.status, 401, JSON.stringify(body));
      assert.equal(body.error, "expired");
      assert.deepEqual(booked(env, quote), { stored: 10, lost: 0 });
    }
    assert.equal(await quoteState(env.mint.url, quote), "ISSUED");
  } finally {
    await env.close();
  }
});

test("a retryable 503 carries Retry-After and the unrecoverable 503 does not", async () => {
  const env = await boot();
  try {
    const { quote, send } = await paidOffer(env);
    const missed = await timeOutBothPosts(env.mint, quote, send);
    assert.equal(missed.res.status, 503, JSON.stringify(missed.body));
    assert.equal(missed.body.detail, undefined);
    assert.equal(missed.res.headers.get("retry-after"), "5");
    env.mint.setStuckMint(true);
    await missed.signLate();
    const lost = await send();
    const body = await lost.json();
    assert.equal(lost.status, 503, JSON.stringify(body));
    assert.equal(body.detail, LOST);
    assert.equal(lost.headers.get("retry-after"), null, "retrying cannot recover these signatures");
  } finally {
    await env.close();
  }
});

test("a proxy's 502 page in place of the mint keeps the reservation and the retry passes once", async () => {
  const env = await boot();
  try {
    const { quote, send } = await paidOffer(env);
    const posts = env.mint.mintPosts();
    env.box.fault = (path, init) => path === "/v1/mint/bolt11" && init?.method === "POST"
      ? new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", { status: 502, headers: { "content-type": "text/html" } })
      : null;
    const failed = await send();
    const failedBody = await failed.json();
    assert.equal(failed.status, 503, JSON.stringify(failedBody));
    assert.equal(failedBody.error, "unavailable");
    assert.equal(failed.headers.get("retry-after"), "5");
    assert.equal(await env.demo.store.hasMintQuote?.(quote), true, "a page that is not the mint's answer is ambiguous");
    assert.equal(await quoteState(env.mint.url, quote), "PAID");
    assert.deepEqual(booked(env, quote), { stored: 0, lost: 0 });
    env.box.fault = null;
    const ok = await send();
    const okBody = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(okBody));
    assert.equal(okBody.rail, "settle");
    const again = await send();
    assert.equal(again.status, 401);
    assert.equal((await again.json()).error, "replay");
    assert.equal(env.mint.mintPosts(), posts + 1, "the kept outputs are posted once to the real mint");
    assert.deepEqual(booked(env, quote), { stored: 10, lost: 0 });
  } finally {
    await env.close();
  }
});

for (const expiredRetry of [false, true]) {
  test("a restore after a booked unrecoverable loss reverses it, once (" + (expiredRetry ? "expired" : "unexpired") + " retry)", async () => {
    const env = await boot();
    try {
      const { quote, exp, send } = await paidOffer(env);
      const missed = await timeOutBothPosts(env.mint, quote, send);
      assert.equal(missed.res.status, 503, JSON.stringify(missed.body));
      env.mint.setStuckMint(true);
      await missed.signLate();
      for (let i = 0; i < 2; i++) {
        const lost = await send();
        assert.equal((await lost.json()).detail, LOST);
      }
      assert.deepEqual(booked(env, quote), { stored: 0, lost: 10 });
      env.mint.setStuckMint(false);
      if (expiredRetry) env.clock.now = exp + 1;
      const recovered = await send();
      const body = await recovered.json();
      assert.equal(recovered.status, expiredRetry ? 401 : 200, JSON.stringify(body));
      for (let i = 0; i < 2; i++) {
        const again = await send();
        assert.equal(again.status, 401);
        assert.equal((await again.json()).error, expiredRetry ? "expired" : "replay");
      }
      assert.deepEqual(booked(env, quote), { stored: 10, lost: 0 }, "the 10 sats are counted once, as stored");
      const rows = (env.demo.store.mintQuoteLossRows?.() ?? []).filter((o) => o.quote === quote);
      assert.deepEqual(rows, [{ quote, action: "write", amount: 10, reason: "unrecoverable", recovered: true }], "the loss is kept as a recovered record");
    } finally {
      await env.close();
    }
  });
}

test("an expired paid quote the mint keeps refusing books one loss at the cap, and a later mint reverses it", async () => {
  const env = await boot();
  try {
    const { quote, exp, send } = await paidOffer(env);
    env.mint.failNextMints(1000);
    for (let i = 0; i < 6; i++) {
      const early = await send();
      assert.equal(early.status, 503, "refusals before expiry stay retryable and do not count toward the cap");
      await early.body?.cancel();
    }
    assert.deepEqual(booked(env, quote), { stored: 0, lost: 0 });
    env.clock.now = exp + 1;
    for (let i = 1; i < 5; i++) {
      const refused = await send();
      const body = await refused.json();
      assert.equal(refused.status, 503, `refusal ${i}: ${JSON.stringify(body)}`);
      assert.equal(refused.headers.get("retry-after"), "5");
      assert.deepEqual(booked(env, quote), { stored: 0, lost: 0 });
    }
    for (let i = 5; i < 8; i++) {
      const capped = await send();
      const body = await capped.json();
      assert.equal(capped.status, 401, `refusal ${i}: ${JSON.stringify(body)}`);
      assert.equal(body.error, "expired");
      assert.equal(capped.headers.get("retry-after"), null, "an expired macaroon past the cap is not invited to retry");
      assert.deepEqual(booked(env, quote), { stored: 0, lost: 10 }, "the loss is booked once across further retries");
    }
    assert.equal(await quoteState(env.mint.url, quote), "PAID");
    assert.deepEqual((env.demo.store.mintQuoteLossRows?.() ?? []).filter((o) => o.quote === quote), [{ quote, action: "write", amount: 10, reason: "mint_refused", recovered: false }]);
    env.mint.failNextMints(0);
    const healed = await send();
    assert.equal(healed.status, 401);
    assert.equal((await healed.json()).error, "expired");
    assert.equal(await quoteState(env.mint.url, quote), "ISSUED");
    assert.deepEqual(booked(env, quote), { stored: 10, lost: 0 }, "a later mint reverses the capped loss");
    const again = await send();
    assert.equal(again.status, 401);
    assert.deepEqual(booked(env, quote), { stored: 10, lost: 0 });
  } finally {
    await env.close();
  }
});

// Ported from QA's #42 check: guardFetch builds its own Response, so its quote 503s need their own header test.
test("guardFetch sends Retry-After on a retryable quote 503 and none on the unrecoverable one", async () => {
  const env = await boot();
  try {
    const gf = guardFetch(env.demo.demo.toll, () => new Response("ok"), { action: "write", remoteAddr: () => "127.0.0.1" });
    const sendGF = (authorization: string, cookie?: string) => gf(new Request("http://site.test/contact", {
      method: "POST", headers: agentHeaders(cookie ? { authorization, cookie } : { authorization }), body: "{}",
    }));

    const refusedOffer = await paidOffer(env);
    env.mint.failNextMints(2);
    const refused = await sendGF(refusedOffer.authorization, `${PASS_COOKIE}=stale`);
    assert.equal(refused.status, 503, JSON.stringify(await refused.clone().json()));
    assert.equal(refused.headers.get("retry-after"), "5", "a stale pass cookie beside the macaroon still gets Retry-After");
    env.mint.failNextMints(0);

    const { quote, authorization } = await paidOffer(env);
    const missed = await timeOutBothPosts(env.mint, quote, () => sendGF(authorization));
    assert.equal(missed.res.status, 503, JSON.stringify(missed.body));
    assert.equal(missed.res.headers.get("retry-after"), "5", "guardFetch says when to retry");
    env.mint.setStuckMint(true);
    try {
      await missed.signLate();
      const lost = await sendGF(authorization);
      const body = await lost.json();
      assert.equal(lost.status, 503, JSON.stringify(body));
      assert.equal(body.detail, LOST);
      assert.equal(lost.headers.get("retry-after"), null, "retrying cannot recover these signatures");
    } finally {
      env.mint.setStuckMint(false);
    }
  } finally {
    await env.close();
  }
});
