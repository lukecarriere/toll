// Widget tests in real Chromium (Playwright): §19.2, §19.7, §19.8, §19.11 and the nine design states.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { startDemo, type Running } from "./helpers.ts";

const V = JSON.parse(readFileSync(new URL("../docs/vectors.json", import.meta.url), "utf8"));
let browser: Browser;
let fast: Running; // default policy
let tiny: Running; // very light work: solves well under 500ms
let slow: Running; // heavy work: solves take well over 500ms

before(async () => {
  browser = await chromium.launch();
  fast = await startDemo();
  tiny = await startDemo({ work: { unit_iterations: 20_000 } });
  slow = await startDemo({ work: { unit_iterations: 2_500_000, max_iterations: 60_000_000 } });
});
after(async () => {
  await browser?.close();
  await Promise.all([fast?.close(), tiny?.close(), slow?.close()]);
});

async function newPage(o: { reducedMotion?: "reduce" | "no-preference"; js?: boolean } = {}) {
  const ctx = await browser.newContext({ reducedMotion: o.reducedMotion ?? "no-preference", javaScriptEnabled: o.js ?? true });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as any).__csp.push(e.violatedDirective + " " + e.blockedURI));
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { page, ctx, errors };
}

/** Serve a test page on the demo origin that loads the real toll.js. */
async function fixture(page: Page, base: string, body: string, scriptAttrs = "") {
  await page.route(base + "/fixture", (r) => r.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><script src="/toll/v1/toll.js" ${scriptAttrs} async></script></head><body>${body}</body></html>` }));
  await page.goto(base + "/fixture");
}

const gateState = (page: Page, sel = "toll-gate") =>
  page.evaluate((s) => {
    const g = document.querySelector(s) as any;
    if (!g) return null;
    const root = g.shadowRoot as ShadowRoot;
    const vis = (el: Element | null) => !!el && !(el as HTMLElement).hidden;
    const status = root.querySelector('[role="status"]');
    const alert = root.querySelector('[role="alert"]');
    const btn = root.querySelector("button.btn") as HTMLButtonElement | null;
    return {
      hidden: g.hidden,
      status: vis(status) ? status!.textContent : null,
      alert: vis(alert) ? alert!.textContent : null,
      button: vis(btn) ? { text: btn!.textContent, busy: btn!.getAttribute("aria-busy"), disabled: btn!.getAttribute("aria-disabled") } : null,
    };
  }, sel);

test("19.2 the widget's worker solves a known challenge in the browser", async () => {
  const { page, ctx } = await newPage();
  await page.goto(fast.url + "/");
  const out = await page.evaluate(async (challenge) => {
    const w = new Worker("/toll/v1/toll.worker.js");
    return await new Promise<any>((ok) => { w.onmessage = (e) => ok(e.data); w.postMessage({ id: 1, challenge }); });
  }, V.work[0].challenge);
  assert.equal(out.ok, true);
  assert.deepEqual(out.nonces, V.work[0].solution.nonces);
  await ctx.close();
});

test("forms: submit without thinking is accepted; offers empty with settlement off (19.11); no CSP violations; no field values sent to the issuer", async () => {
  const { page, ctx, errors } = await newPage();
  const issuerBodies: string[] = [];
  const offers: any[] = [];
  page.on("request", (r) => { if (r.url().includes("/v1/")) issuerBodies.push(r.url() + " " + (r.postData() ?? "")); });
  page.on("response", async (r) => { if (r.url().includes("/v1/challenge")) offers.push((await r.json()).offers); });
  await page.goto(fast.url + "/");
  await page.fill("#m", "unique-private-message-7731");
  await page.click("#contact button[type=submit]");
  await page.waitForURL(/sent=contact/);
  assert.match((await page.textContent("#contact .pill"))!, /Accepted/);
  assert.ok(offers.length >= 1 && offers.every((o) => Array.isArray(o) && o.length === 0));
  assert.ok(!issuerBodies.join("\n").includes("unique-private-message-7731"));
  assert.ok(!issuerBodies.join("\n").includes("ana@example.com"));
  assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("19.7 the widget skips work when a valid pass exists", async () => {
  const { page, ctx } = await newPage();
  let challenges = 0;
  page.on("request", (r) => { if (r.url().includes("/v1/challenge")) challenges++; });
  await page.goto(fast.url + "/");
  await page.waitForResponse((r) => r.url().includes("/v1/redeem"));
  assert.equal(challenges, 1, "one solve covers both write forms and the search form");
  await page.reload();
  await page.waitForTimeout(1500);
  assert.equal(challenges, 1, "reload with a valid pass cookie starts no work");
  await page.fill("#cmt", "second comment");
  await page.click("#comments button[type=submit]");
  await page.waitForURL(/#comments/);
  assert.equal(challenges, 1);
  assert.match((await page.textContent(".comments"))!, /second comment/);
  await ctx.close();
});

test("19.8 bot hammer: without the check >= 95% rejected; with the widget >= 95% accepted", async () => {
  const { page, ctx } = await newPage();
  await page.goto(fast.url + "/hammer");
  await page.click("#r1-btn");
  await page.waitForFunction(() => document.body.hasAttribute("data-r1-done"), null, { timeout: 30000 });
  await page.click("#r2-btn");
  await page.waitForFunction(() => document.body.hasAttribute("data-r2-done"), null, { timeout: 120000 });
  const [a1, r1] = (await page.getAttribute("body", "data-r1-done"))!.split("/").map(Number);
  const [a2, r2] = (await page.getAttribute("body", "data-r2-done"))!.split("/").map(Number);
  assert.ok(r1 / (a1 + r1) >= 0.95, `without check: ${a1} accepted, ${r1} rejected`);
  assert.ok(a2 / (a2 + r2) >= 0.95, `with check: ${a2} accepted, ${r2} rejected`);
  assert.equal(await page.getAttribute("#r2-cells", "aria-label"), `${a2} of 50 accepted`);
  // The live stats card on this page follows the server's counts (other tests share this demo, hence >=).
  await page.waitForFunction(([a, r]) => Number(document.getElementById("st-acc")!.textContent) >= a && Number(document.getElementById("st-rej")!.textContent) >= r, [a2, r1], { timeout: 5000 });
  await ctx.close();
});

test("state 1: a solve under 500ms renders nothing, ever (and never shows Verified)", async () => {
  const { page, ctx } = await newPage();
  await page.goto(tiny.url + "/");
  const seen = await page.evaluate(async () => {
    const out: string[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 2000) {
      document.querySelectorAll("toll-gate").forEach((g: any) => { if (!g.hidden) out.push(g.shadowRoot.textContent); });
      await new Promise((r) => setTimeout(r, 15));
    }
    return out;
  });
  assert.deepEqual(seen, []);
  const ev = tiny.events.filter((e) => e.event === "redeem_ok");
  assert.ok(ev.length >= 1 && ev.every((e) => e.took_ms < 500), "solves were under 500ms");
  await ctx.close();
});

test("states 2 and 3: Checking… appears at 500ms (not before), then Verified; host submit button untouched; placement after submit", async () => {
  const { page, ctx } = await newPage();
  await fixture(page, slow.url, `<form id="f" method="post" action="/contact" data-toll="write" style="font-family: Georgia, serif; color: rgb(10, 20, 30)"><input name="m"><button type="submit" id="send" class="host-btn">Send</button><span id="after"></span></form>`);
  const timeline = await page.evaluate(async () => {
    const t0 = performance.now();
    const marks: { t: number; text: string; hidden: boolean }[] = [];
    let last = "";
    while (performance.now() - t0 < 12000) {
      const g = document.querySelector("toll-gate") as any;
      if (g) {
        const txt = g.hidden ? "" : g.shadowRoot.querySelector('[role="status"]').textContent;
        if (txt !== last) { marks.push({ t: performance.now(), text: txt, hidden: g.hidden }); last = txt; }
        if (txt === "Verified") break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const st = performance.getEntriesByType("resource").find((e) => e.name.includes("/v1/status"))!;
    return { marks: marks.map((m) => ({ ...m, t: Math.round(m.t - st.startTime) })) };
  });
  const checking = timeline.marks.find((m) => m.text === "Checking…");
  const verified = timeline.marks.find((m) => m.text === "Verified");
  assert.ok(checking, JSON.stringify(timeline));
  assert.ok(checking!.t >= 480, `Checking… shown at ${checking!.t}ms`);
  assert.ok(verified && verified.t - checking!.t >= 390, "Checking… stays up at least 400ms before Verified");
  const layout = await page.evaluate(() => {
    const g = document.querySelector("toll-gate") as any;
    const btn = document.getElementById("send") as HTMLButtonElement;
    const s = g.shadowRoot.querySelector(".s");
    const cs = getComputedStyle(s);
    return { prev: g.previousElementSibling?.id, hasShadow: !!g.shadowRoot, font: cs.fontFamily, color: cs.color, btnDisabled: btn.disabled, btnAttrs: btn.getAttributeNames().sort(), role: s.getAttribute("role") };
  });
  assert.equal(layout.prev, "send", "inserted right after the submit button");
  assert.equal(layout.hasShadow, true);
  assert.match(layout.font, /Georgia/);
  assert.equal(layout.color, "rgb(10, 20, 30)");
  assert.equal(layout.btnDisabled, false);
  assert.deepEqual(layout.btnAttrs, ["class", "id", "type"]);
  assert.equal(layout.role, "status");
  await ctx.close();
});

test("state 4: reduced motion keeps solving with a static bar; normal motion animates", async () => {
  for (const mode of ["reduce", "no-preference"] as const) {
    const { page, ctx } = await newPage({ reducedMotion: mode });
    await page.goto(slow.url + "/");
    await page.waitForFunction(() => { const g = document.querySelector("toll-gate") as any; return g && !g.hidden && g.shadowRoot.querySelector(".bar"); }, null, { timeout: 8000 });
    const anim = await page.evaluate(() => getComputedStyle((document.querySelector("toll-gate") as any).shadowRoot.querySelector(".bar"), "::after").animationName);
    assert.equal(anim, mode === "reduce" ? "none" : "toll-slide", mode);
    await page.waitForResponse((r) => r.url().includes("/v1/redeem"), { timeout: 15000 });
    await ctx.close();
  }
});

test("states 5-7: checkbox mode is a real, keyboard-operable button; no work before it is pressed", async () => {
  const { page, ctx } = await newPage();
  let challenges = 0;
  page.on("request", (r) => { if (r.url().includes("/v1/challenge")) challenges++; });
  await fixture(page, fast.url, `<form method="post" action="/contact" data-toll="write" data-toll-checkbox="true"><input name="m" id="m"><button type="submit">Send</button></form>`);
  const btn = page.getByRole("button", { name: "Verify before sending" });
  await btn.waitFor();
  await page.waitForTimeout(800);
  assert.equal(challenges, 0, "checkbox mode waits for the visitor");
  assert.deepEqual((await gateState(page))!.button, { text: "Verify before sending", busy: null, disabled: null });
  await page.focus("#m");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => (document.activeElement as any)?.tagName), "TOLL-GATE", "focus reaches the button inside the shadow root");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (document.querySelector("toll-gate") as any).shadowRoot.querySelector("button.btn").textContent === "Verified", null, { timeout: 10000 });
  const st = (await gateState(page))!.button!;
  assert.equal(st.disabled, "true");
  assert.equal(challenges, 1);
  assert.equal(await page.evaluate(() => (document.querySelector("toll-gate") as any).shadowRoot.activeElement?.className), "btn", "focus stays on the button");
  await ctx.close();
});

test("state 8: issuer unreachable shows Couldn't check this form. + Try again; the write stays blocked until a pass exists", async () => {
  const { page, ctx } = await newPage();
  let block = true;
  await page.route("**/v1/challenge*", (r) => (block ? r.abort() : r.continue()));
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/contact")) posts.push(r.url()); });
  await page.goto(fast.url + "/");
  await page.waitForFunction(() => { const g = document.querySelector("#contact toll-gate") as any; return g && g.shadowRoot.querySelector('[role="alert"]') && !g.shadowRoot.querySelector('[role="alert"]').hidden; }, null, { timeout: 8000 });
  const s = (await gateState(page, "#contact toll-gate"))!;
  assert.equal(s.alert, "Couldn't check this form.Try again");
  await page.click("#contact button[type=submit]");
  await page.waitForTimeout(700);
  assert.deepEqual(posts, [], "no POST while checks fail (fail closed)");
  block = false;
  await page.evaluate(() => (document.querySelector("#contact toll-gate") as any).shadowRoot.querySelector("button.link").click());
  await page.waitForResponse((r) => r.url().includes("/v1/redeem"));
  await page.click("#contact button[type=submit]");
  await page.waitForURL(/sent=contact/);
  assert.equal(posts.length, 1);
  await ctx.close();
});

test("8s cap (owner setting): a solve that runs past the cap switches to checkbox mode", async () => {
  const { page, ctx } = await newPage();
  await fixture(page, slow.url, `<form method="post" action="/contact" data-toll="write"><input name="m"><button type="submit">Send</button></form>`, 'data-max-solve-ms="700"');
  await page.getByRole("button", { name: "Verify before sending" }).waitFor({ timeout: 5000 });
  await ctx.close();
});

test("state 9: without JavaScript the form shows the note and the POST is rejected", async () => {
  const { page, ctx } = await newPage({ js: false });
  await page.goto(fast.url + "/");
  assert.match((await page.textContent("#contact form"))!, /This form needs JavaScript\./);
  const [resp] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/contact")), page.click("#contact button[type=submit]")]);
  assert.equal(resp.status(), 403);
  assert.match((await page.textContent("body"))!, /This form needs JavaScript\./);
  await ctx.close();
});

test("toll.fetch attaches a pass and retries once on 403 toll_required", async () => {
  const { page, ctx } = await newPage();
  await page.goto(fast.url + "/hammer");
  const out = await page.evaluate(async () => {
    const r = await (window as any).toll.fetch("/contact", { method: "POST", credentials: "omit", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "message=x" });
    return { status: r.status, body: await r.json() };
  });
  assert.deepEqual(out, { status: 200, body: { ok: true } });
  await ctx.close();
});
