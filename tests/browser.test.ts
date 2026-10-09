// Widget tests in real Chromium (Playwright): §19.2, §19.7, §19.8, §19.11 and the nine design states.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { startDemo, type Running } from "./helpers.ts";

const V = JSON.parse(readFileSync(new URL("../docs/vectors.json", import.meta.url), "utf8"));
let browser: Browser;
let fast: Running; // default policy
let tiny: Running; // one cost-1 try: solves well under 500ms, including on a busy runner
let slow: Running; // heavy work: solves take well over 500ms and well under the widget's 8s cap (counter pinned mid-range)
let hard: Running; // hardened mode (Argon2id worker)

before(async () => {
  browser = await chromium.launch();
  fast = await startDemo();
  // State 1 must observe a solve that finishes under the widget's 500ms Checking… threshold.
  // unit_tries: 2 kept the default cost (5000) and a random counter, and the test read redeem_ok
  // the instant a 2s visibility poll ended. The widget starts that solve from requestIdleCallback
  // with a 2s timeout, so on a busy runner the poll and the idle timeout finished together and the
  // redeem was not in the log yet (the assertion failed with "solves were under 500ms"). One PBKDF2
  // iteration, counter pinned at 0, keeps took_ms to worker startup once the solve does start.
  tiny = await startDemo({ work: { standard: { cost: 1, unit_tries: 1 } } }, { pickCounter: () => 0 });
  // The slow policy must sit well inside the window its tests need: over ~2s (Checking… 500ms after an
  // interaction made 1s into the solve, then 400ms of Checking…) and well under the widget's default 8s
  // cap (MAX_SOLVE_MS), past which an engaged form switches to the checkbox and never shows Verified.
  // Pinned at 0.95 of the range a solve took ~6.7-7.6s on an idle 8-core box, so any CPU load (a full
  // suite next door) pushed it past 8s. At 0.45 it takes ~3.3s: room for 2x either way.
  slow = await startDemo({ work: { standard: { unit_tries: 1100 }, max_units: 64 } }, { pickCounter: (m) => 0.45 * m });
  hard = await startDemo({ work: { mode: "hardened" } });
});
after(async () => {
  await browser?.close();
  await Promise.all([fast?.close(), tiny?.close(), slow?.close(), hard?.close()]);
});

/** The slow policy's solve times so far, for failure messages ("took_ms" of each redeem). */
const slowTook = () => JSON.stringify(slow.events.filter((e) => e.event === "redeem_ok").map((e) => e.took_ms));
/** True when a <toll-gate> shows the checkbox: in a background solve that means the 8s cap was hit. */
const capHit = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll("toll-gate")).some((g: any) => !g.hidden && !g.shadowRoot.querySelector("button.btn").hidden));

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

test("19.2 the engine's workers, as served by the issuer, solve the vector challenges in the browser (both modes)", async () => {
  const { page, ctx } = await newPage();
  await page.goto(fast.url + "/");
  for (const w of V.work) {
    const url = w.challenge.alg === "argon2id" ? "/toll/v1/toll.worker-argon2id.js" : "/toll/v1/toll.worker.js";
    // The engine's worker protocol: { type: "work", challenge, counterStart, counterStep } -> solution.
    const out = await page.evaluate(async ({ url, challenge }) => {
      const wk = new Worker(url);
      const r = await new Promise<any>((ok) => { wk.onmessage = (e) => ok(e.data); wk.postMessage({ type: "work", challenge, counterStart: 0, counterStep: 1 }); });
      wk.terminate();
      return r;
    }, { url, challenge: w.challenge.work });
    assert.equal(out.counter, w.secret_counter, w.name);
    assert.equal(out.derivedKey, w.solution.work.derivedKey, w.name);
  }
  await ctx.close();
});

test("hardened mode: the demo form submits without thinking with the Argon2id engine (no CSP violations)", async () => {
  const { page, ctx, errors } = await newPage();
  const workers: string[] = [];
  page.on("worker", (w) => workers.push(w.url()));
  await page.goto(hard.url + "/");
  await page.click("#contact button[type=submit]");
  await page.waitForURL(/sent=contact/, { timeout: 30000 });
  assert.match((await page.textContent("#contact .pill"))!, /Accepted/);
  assert.ok(workers.some((u) => u.endsWith("/toll/v1/toll.worker-argon2id.js")), JSON.stringify(workers));
  assert.ok(!workers.some((u) => u.endsWith("/toll/v1/toll.worker.js")), "standard worker not loaded in hardened mode");
  assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
  assert.deepEqual(errors, []);
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
  const redeemed = page.waitForResponse((r) => r.url().includes("/v1/redeem")); // listen before the solve can start
  await page.goto(fast.url + "/");
  await redeemed;
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

test("state 1: a solve under 500ms renders nothing, ever (and never shows Verified)", async (t) => {
  const { page, ctx } = await newPage();
  // Watch from the first script. A 2s evaluate loop ended in the same moment requestIdleCallback's
  // 2s timeout started the solve, so the redeem was still in flight when took_ms was checked.
  await page.addInitScript(() => {
    const w = window as any;
    w.__gateSeen = [];
    const tick = () => {
      document.querySelectorAll("toll-gate").forEach((g: any) => { if (!g.hidden) w.__gateSeen.push(g.shadowRoot.textContent); });
      setTimeout(tick, 15);
    };
    setTimeout(tick, 0);
  });
  try {
    const mark = tiny.events.length;
    const redeemed = page.waitForResponse((r) => r.url().includes("/v1/redeem") && r.status() === 200, { timeout: 15000 });
    await page.goto(tiny.url + "/");
    await redeemed;
    // A second form can mint its own challenge if it starts before the write solve is in flight.
    const extra = Date.now() + 2000;
    let took: number[] = [];
    while (Date.now() < extra) {
      const ev = tiny.events.slice(mark);
      const minted = ev.filter((e) => e.event === "challenge_minted").length;
      const ok = ev.filter((e) => e.event === "redeem_ok");
      took = ok.map((e) => e.took_ms);
      if (minted > 0 && ok.length >= minted) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    // Checking… arms at 500ms and Verified holds at least 400ms, so a paint would be on screen
    // within a second of the redeem.
    await page.waitForTimeout(1000);
    const seen = await page.evaluate(() => (window as any).__gateSeen as string[]);
    assert.deepEqual(seen, [], `a solve under 500ms rendered ${JSON.stringify(seen)} (took_ms ${JSON.stringify(took)})`);
    assert.ok(took.length >= 1 && took.every((ms) => typeof ms === "number" && ms < 500), `solves were under 500ms: ${JSON.stringify(took)}`);
    t.diagnostic(`took_ms ${JSON.stringify(took)}`);
  } finally {
    await ctx.close();
  }
});

test("states 2 and 3: Checking… appears at 500ms (not before), then Verified; host submit button untouched; placement after submit", async () => {
  const { page, ctx } = await newPage();
  await fixture(page, slow.url, `<form id="f" method="post" action="/contact" data-toll="write" style="font-family: Georgia, serif; color: rgb(10, 20, 30)"><input name="m"><button type="submit" id="send" class="host-btn">Send</button><span id="after"></span></form>`);
  const timeline = await page.evaluate(async () => {
    const t0 = performance.now();
    (document.querySelector('input[name="m"]') as HTMLInputElement).focus(); // gap 1: nothing shows before the visitor interacts
    const marks: { t: number; text: string; hidden: boolean }[] = [];
    let last = "";
    while (performance.now() - t0 < 12000) {
      const g = document.querySelector("toll-gate") as any;
      if (g) {
        const txt = g.hidden ? "" : g.shadowRoot.querySelector('[role="status"]').textContent;
        if (txt !== last) { marks.push({ t: performance.now(), text: txt, hidden: g.hidden }); last = txt; }
        if (txt === "Verified") break;
        if (!g.hidden && !g.shadowRoot.querySelector("button.btn").hidden) { marks.push({ t: performance.now(), text: "checkbox (cap)", hidden: false }); break; }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const st = performance.getEntriesByType("resource").find((e) => e.name.includes("/v1/status"))!;
    return { marks: marks.map((m) => ({ ...m, t: Math.round(m.t - st.startTime) })) };
  });
  const checking = timeline.marks.find((m) => m.text === "Checking…");
  const verified = timeline.marks.find((m) => m.text === "Verified");
  assert.ok(!timeline.marks.some((m) => m.text === "checkbox (cap)"), `the slow solve hit the 8s cap (slow solves took ${slowTook()}ms): ` + JSON.stringify(timeline));
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
    const redeemed = page.waitForResponse((r) => r.url().includes("/v1/redeem"), { timeout: 15000 }); // listen before the solve can start
    await page.goto(slow.url + "/");
    await page.focus("#m"); // gap 1: nothing shows before the visitor interacts
    await page.waitForFunction(() => { const g = document.querySelector("toll-gate") as any; return g && !g.hidden && g.shadowRoot.querySelector(".bar"); }, null, { timeout: 8000 });
    const anim = await page.evaluate(() => getComputedStyle((document.querySelector("toll-gate") as any).shadowRoot.querySelector(".bar"), "::after").animationName);
    assert.equal(anim, mode === "reduce" ? "none" : "toll-slide", mode);
    await redeemed;
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
  await page.focus("#m"); // gap 1: an idle failure shows only once the visitor interacts
  await page.waitForFunction(() => { const g = document.querySelector("#contact toll-gate") as any; return g && g.shadowRoot.querySelector('[role="alert"]') && !g.shadowRoot.querySelector('[role="alert"]').hidden; }, null, { timeout: 8000 });
  const s = (await gateState(page, "#contact toll-gate"))!;
  assert.equal(s.alert, "Couldn't check this form.Try again");
  await page.click("#contact button[type=submit]");
  await page.waitForTimeout(700);
  assert.deepEqual(posts, [], "no POST while checks fail (fail closed)");
  block = false;
  const redeemed = page.waitForResponse((r) => r.url().includes("/v1/redeem")); // listen before Try again starts the solve
  await page.evaluate(() => (document.querySelector("#contact toll-gate") as any).shadowRoot.querySelector("button.link").click());
  await redeemed;
  await page.click("#contact button[type=submit]");
  await page.waitForURL(/sent=contact/);
  assert.equal(posts.length, 1);
  await ctx.close();
});

test("8s cap (owner setting): a solve that runs past the cap switches to checkbox mode", async () => {
  const { page, ctx } = await newPage();
  await fixture(page, slow.url, `<form method="post" action="/contact" data-toll="write"><input name="m"><button type="submit">Send</button></form>`, 'data-max-solve-ms="700"');
  await page.focus('input[name="m"]'); // gap 1: the checkbox shows once the visitor interacts
  await page.getByRole("button", { name: "Verify before sending" }).waitFor({ timeout: 5000 });
  await ctx.close();
});

// ---- Gap 1: an idle solve changes nothing the visitor sees until they interact with the form -----
// Every frame, log what each <toll-gate> draws (host hidden state and box, and which of the status,
// alert and checkbox rows show, with their text; none of them while the host is hidden). A new entry is written only when that changes.
async function watchGates(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__gateLog = [];
    let last = "";
    const tick = () => {
      const gates = Array.from(document.querySelectorAll("toll-gate")) as any[];
      if (gates.length) {
        const sig = JSON.stringify(gates.map((g) => {
          const r = g.shadowRoot as ShadowRoot | null;
          // A hidden host draws none of its rows, whatever their own hidden flags say.
          const vis = (el: Element | null | undefined) => !g.hidden && !!el && !(el as HTMLElement).hidden;
          const s = r?.querySelector('[role="status"]'), a = r?.querySelector('[role="alert"]'), b = r?.querySelector("button.btn");
          const box = g.getBoundingClientRect();
          return { hidden: g.hidden, w: box.width, h: box.height, status: vis(s) ? s!.textContent : null, alert: vis(a) ? a!.textContent : null, button: vis(b) ? b!.textContent : null };
        }));
        if (sig !== last) { last = sig; w.__gateLog.push({ t: performance.now(), sig }); }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const gateLog = (page: Page) => page.evaluate(() => (window as any).__gateLog as { t: number; sig: string }[]);
/** Focus a field and return the page time of that first interaction. */
const focusAt = (page: Page, sel: string) => page.evaluate((s) => { const t = performance.now(); (document.querySelector(s) as HTMLElement).focus(); return t; }, sel);
const FORM = `<form method="post" action="/contact" data-toll="write"><input name="m"><button type="submit">Send</button></form>`;
const NOTHING = JSON.stringify([{ hidden: true, w: 0, h: 0, status: null, alert: null, button: null }]);

test("acceptance gap 1: an idle solve that finishes leaves the widget exactly as it was on load; the first interaction draws nothing and Submit posts with the ready pass", async () => {
  // Slow policy, so the solve runs well past 500ms: the widget never changes; after the first
  // interaction there is nothing to show (state 1) and Submit posts with the idle pass.
  {
    const { page, ctx, errors } = await newPage();
    await watchGates(page);
    let challenges = 0;
    page.on("request", (r) => { if (r.url().includes("/v1/challenge")) challenges++; });
    const redeemed = page.waitForResponse((r) => r.url().includes("/v1/redeem"), { timeout: 20000 });
    await fixture(page, slow.url, FORM);
    assert.equal((await redeemed).status(), 200);
    await page.waitForTimeout(700); // past any 500ms + 400ms window measured from the solve
    const before = await gateLog(page);
    assert.equal(before.length, 1, "no change before the first interaction: " + JSON.stringify(before));
    assert.equal(before[0].sig, NOTHING, "on load: hidden, zero size, nothing drawn");
    const tI = await focusAt(page, 'input[name="m"]');
    await page.waitForTimeout(1200);
    const afterLog = (await gateLog(page)).filter((e) => e.t >= tI);
    assert.deepEqual(afterLog, [], "solve finished silently: the interaction draws nothing (state 1)");
    await Promise.all([page.waitForURL(/sent=contact/, { timeout: 10000 }), page.click("button[type=submit]")]);
    assert.equal(challenges, 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test("acceptance gap 1: an idle solve that hits the cap stops the worker and shows nothing; the checkbox appears on the first interaction and works", async () => {
  // Short owner cap: still exactly as on load after the cap, then the checkbox on focus, and it works when pressed.
  {
    const { page, ctx, errors } = await newPage();
    await watchGates(page);
    let challenges = 0, redeems = 0;
    page.on("request", (r) => { if (r.url().includes("/v1/challenge")) challenges++; if (r.url().includes("/v1/redeem")) redeems++; });
    await fixture(page, slow.url, FORM, 'data-max-solve-ms="700"');
    await page.waitForTimeout(2500); // well past the 700ms cap
    const before = await gateLog(page);
    assert.equal(before.length, 1, "no change before the first interaction: " + JSON.stringify(before));
    assert.equal(before[0].sig, NOTHING);
    assert.equal(challenges, 1);
    assert.equal(redeems, 0, "the worker stopped at the cap");
    assert.equal(page.workers().length, 0, "no solver worker is left running after the cap");
    await focusAt(page, 'input[name="m"]');
    const box = page.getByRole("button", { name: "Verify before sending" });
    await box.waitFor({ timeout: 2000 });
    assert.deepEqual((await gateState(page))!, { hidden: false, status: null, alert: null, button: { text: "Verify before sending", busy: null, disabled: null } });
    assert.equal(challenges, 1, "focus alone starts no new work in checkbox mode");
    await box.click();
    await page.waitForFunction(() => (document.querySelector("toll-gate") as any).shadowRoot.querySelector("button.btn").textContent === "Verified", null, { timeout: 20000 });
    assert.equal(challenges, 2);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test("gap 1: an idle challenge failure shows nothing until focus, then shows the error; the write stays blocked", async () => {
  const { page, ctx } = await newPage();
  await watchGates(page);
  let challenges = 0;
  const posts: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/v1/challenge")) challenges++; if (r.method() === "POST" && r.url().endsWith("/contact")) posts.push(r.url()); });
  await page.route("**/v1/challenge*", (r) => r.abort());
  const failed = page.waitForEvent("requestfailed", { predicate: (r) => r.url().includes("/v1/challenge"), timeout: 8000 });
  await fixture(page, fast.url, FORM);
  await failed;
  await page.waitForTimeout(1000);
  const log = await gateLog(page);
  assert.equal(log.length, 1, JSON.stringify(log));
  assert.equal(log[0].sig, NOTHING);
  await page.focus('input[name="m"]');
  await page.waitForFunction(() => { const g = document.querySelector("toll-gate") as any; return !g.hidden && !g.shadowRoot.querySelector('[role="alert"]').hidden; }, null, { timeout: 2000 });
  assert.deepEqual((await gateState(page))!, { hidden: false, status: null, alert: "Couldn't check this form.Try again", button: null });
  await page.waitForTimeout(300);
  assert.equal(challenges, 1, "focus shows the held failure; it does not start another check");
  await page.click("button[type=submit]");
  await page.waitForTimeout(700);
  assert.deepEqual(posts, [], "no POST while checks fail (fail closed)");
  await ctx.close();
});

test("gap 1: an interaction in the middle of an idle solve shows Checking… no earlier than 480ms after the interaction, then Verified after at least 400ms", async () => {
  const { page, ctx } = await newPage();
  await watchGates(page);
  const started = page.waitForRequest((r) => r.url().includes("/v1/challenge"), { timeout: 8000 });
  await fixture(page, slow.url, FORM);
  await started;
  await page.waitForTimeout(1000); // the old timing would already show Checking… (500ms after solve start)
  const tI = await focusAt(page, 'input[name="m"]');
  // Verified, or the checkbox if the solve ran past the 8s cap (then fail at once and say so, not after 20s).
  await page.waitForFunction(() => { const r = (document.querySelector("toll-gate") as any).shadowRoot; return r.querySelector('[role="status"]').textContent === "Verified" || !r.querySelector("button.btn").hidden; }, null, { timeout: 20000 });
  assert.equal(await capHit(page), false, `the slow solve hit the 8s cap (slow solves took ${slowTook()}ms)`);
  const log = await gateLog(page);
  assert.ok(log.filter((e) => e.t < tI).every((e) => e.sig === NOTHING), "nothing drawn before the interaction: " + JSON.stringify(log));
  const checking = log.find((e) => e.sig.includes('"status":"Checking…"'));
  const verified = log.find((e) => e.sig.includes('"status":"Verified"'));
  assert.ok(checking && verified, JSON.stringify(log));
  assert.ok(checking!.t - tI >= 480, `Checking… shown ${Math.round(checking!.t - tI)}ms after the interaction`);
  assert.ok(verified!.t - checking!.t >= 390, "Checking… stays up at least 400ms before Verified");
  await ctx.close();
});

test("gap 1: challenge fetch count is unchanged: exactly 1 per page for the demo forms page", async () => {
  for (const [demo, label] of [[fast, "default"], [slow, "slow"]] as const) {
    const { page, ctx } = await newPage();
    let challenges = 0;
    page.on("request", (r) => { if (r.url().includes("/v1/challenge")) challenges++; });
    // Listen before goto: on the default policy the idle solve can redeem before goto and the focus calls return.
    const redeemed = page.waitForResponse((r) => r.url().includes("/v1/redeem"), { timeout: 20000 }).catch((e) => e as Error);
    await page.goto(demo.url + "/");
    // Interact with every form, early (during the idle solve on the slow policy).
    await page.focus("#m");
    await page.focus("#cmt");
    await page.focus("#q");
    const r = await redeemed;
    if (r instanceof Error) assert.fail(`${label}: no redeem${(await capHit(page)) ? ` (the solve hit the 8s cap; slow solves took ${slowTook()}ms)` : ""}: ${r.message}`);
    await page.waitForTimeout(1500);
    assert.equal(challenges, 1, label);
    await ctx.close();
  }
});

// Designer bug: `.btn { display: inline-flex }` beat the UA [hidden] rule, so the hidden checkbox
// button drew an empty 28x40 bordered box next to "Verified". Sample every frame: any element in the
// widget's shadow root that is hidden must have a zero-size box, in every state.
async function sampleHidden(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__hiddenBad = [];
    w.__views = new Set<string>();
    w.__frames = 0;
    const tick = () => {
      for (const g of Array.from(document.querySelectorAll("toll-gate")) as any[]) {
        const root = g.shadowRoot as ShadowRoot | null;
        if (!root) continue;
        const status = root.querySelector('[role="status"]') as HTMLElement;
        const alert = root.querySelector('[role="alert"]') as HTMLElement;
        const btn = root.querySelector("button.btn") as HTMLButtonElement;
        const view = g.hidden ? "none" : [status && !status.hidden ? "status:" + status.textContent : "", alert && !alert.hidden ? "alert" : "", btn && !btn.hidden ? "button:" + btn.textContent : ""].filter(Boolean).join("|");
        w.__views.add(view);
        for (const el of Array.from(root.querySelectorAll("[hidden]")) as HTMLElement[]) {
          const r = el.getBoundingClientRect();
          if (r.width !== 0 || r.height !== 0) w.__hiddenBad.push({ view, el: el.className || el.tagName, w: r.width, h: r.height });
        }
        if (btn?.hidden) {
          const r = btn.getBoundingClientRect();
          if (getComputedStyle(btn).display !== "none" || r.width || r.height) w.__hiddenBad.push({ view, el: "btn(display " + getComputedStyle(btn).display + ")", w: r.width, h: r.height });
        }
      }
      w.__frames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const hiddenReport = (page: Page) => page.evaluate(() => { const w = window as any; return { bad: w.__hiddenBad.slice(0, 5), badCount: w.__hiddenBad.length, views: [...w.__views], frames: w.__frames }; });
const btnBox = (page: Page, sel = "toll-gate") => page.evaluate((s) => {
  const b = (document.querySelector(s) as any).shadowRoot.querySelector("button.btn") as HTMLButtonElement;
  const r = b.getBoundingClientRect();
  return { hidden: b.hidden, w: r.width, h: r.height, display: getComputedStyle(b).display };
}, sel);

test("hidden widget parts take no space in any state: Checking…, Verified, error, checkbox (button is 0x0 whenever hidden)", async () => {
  // Checking… then Verified (slow policy), and the in-page hide afterwards.
  {
    const { page, ctx } = await newPage();
    await sampleHidden(page);
    await fixture(page, slow.url, `<form method="post" action="/contact" data-toll="write"><input name="m"><button type="submit">Send</button></form>`);
    await page.focus('input[name="m"]'); // gap 1: nothing shows before the visitor interacts
    await page.waitForFunction(() => { const g = document.querySelector("toll-gate") as any; return g && !g.hidden && g.shadowRoot.querySelector('[role="status"]').textContent === "Checking…"; }, null, { timeout: 8000 });
    assert.deepEqual(await btnBox(page), { hidden: true, w: 0, h: 0, display: "none" }, "during Checking…");
    await page.waitForFunction(() => { const g = document.querySelector("toll-gate") as any; return g && !g.hidden && g.shadowRoot.querySelector('[role="status"]').textContent === "Verified"; }, null, { timeout: 15000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.deepEqual(await btnBox(page), { hidden: true, w: 0, h: 0, display: "none" }, "after Verified");
    // The status row is the only thing drawn next to Verified.
    const row = await page.evaluate(() => { const g = document.querySelector("toll-gate") as any; return Array.from(g.shadowRoot.children as HTMLCollection).filter((e: any) => e.getBoundingClientRect().width > 0).map((e: any) => e.className); });
    assert.deepEqual(row, ["s"]);
    await page.waitForTimeout(1500);
    const rep = await hiddenReport(page);
    assert.ok(rep.views.includes("status:Checking…") && rep.views.includes("status:Verified"), JSON.stringify(rep.views));
    assert.equal(rep.badCount, 0, JSON.stringify(rep));
    await ctx.close();
  }
  // Error state (issuer unreachable): button and status hidden while the alert shows.
  {
    const { page, ctx } = await newPage();
    await sampleHidden(page);
    await page.route("**/v1/challenge*", (r) => r.abort());
    await fixture(page, fast.url, `<form method="post" action="/contact" data-toll="write"><input name="m"><button type="submit">Send</button></form>`);
    await page.focus('input[name="m"]'); // gap 1: an idle failure shows only once the visitor interacts
    await page.waitForFunction(() => { const g = document.querySelector("toll-gate") as any; return g && !g.shadowRoot.querySelector('[role="alert"]').hidden; }, null, { timeout: 8000 });
    await page.waitForTimeout(300);
    assert.deepEqual(await btnBox(page), { hidden: true, w: 0, h: 0, display: "none" }, "error state");
    const rep = await hiddenReport(page);
    assert.ok(rep.views.includes("alert"), JSON.stringify(rep.views));
    assert.equal(rep.badCount, 0, JSON.stringify(rep));
    await ctx.close();
  }
  // Checkbox mode: the status and alert rows are hidden while the button shows, before and after Verified.
  {
    const { page, ctx } = await newPage();
    await sampleHidden(page);
    await fixture(page, fast.url, `<form method="post" action="/contact" data-toll="write" data-toll-checkbox="true"><input name="m"><button type="submit">Send</button></form>`);
    const b = page.getByRole("button", { name: "Verify before sending" });
    await b.waitFor();
    await b.click();
    await page.waitForFunction(() => (document.querySelector("toll-gate") as any).shadowRoot.querySelector("button.btn").textContent === "Verified", null, { timeout: 10000 });
    await page.waitForTimeout(300);
    const rep = await hiddenReport(page);
    assert.ok(rep.views.some((v: string) => v.startsWith("button:")), JSON.stringify(rep.views));
    assert.equal(rep.badCount, 0, JSON.stringify(rep));
    await ctx.close();
  }
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

// ---- Amendment 1: the work engine is a solver only -----------------------------------------------
// In every widget state, no vendor name (docs/adapters.md list) may appear in <toll-gate>'s
// rendered text, its shadow markup (including hidden parts and attributes), or the page's
// accessibility tree; and the visitor's browser talks to no origin but the site's own.
test("vendor names never reach the visitor: rendered text, shadow markup and accessibility tree in all nine states; zero third-party requests", async () => {
  // @ts-ignore plain JS helper
  const { vendorRegexes } = await import("../scripts/copy-lib.mjs");
  const res: { term: string; re: RegExp }[] = vendorRegexes();
  const seen: Record<string, string> = {};
  const hits: string[] = [];
  const foreign: string[] = [];

  async function scan(page: Page, state: string) {
    const dom = await page.evaluate(() => {
      const out: string[] = [document.body?.innerText ?? ""];
      for (const g of Array.from(document.querySelectorAll("toll-gate")) as any[]) {
        out.push(g.outerHTML, g.textContent ?? "");
        if (g.shadowRoot) out.push(g.shadowRoot.innerHTML, g.shadowRoot.textContent ?? "");
      }
      return out.join("\n");
    });
    const cdp = await page.context().newCDPSession(page);
    const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as any;
    await cdp.detach();
    const ax = nodes.flatMap((n: any) => [n.name?.value, n.description?.value, n.value?.value, ...(n.properties ?? []).map((p: any) => p.value?.value)]).filter((x: any) => typeof x === "string").join("\n");
    for (const { term, re } of res) {
      for (const [where, text] of [["dom", dom], ["a11y", ax]] as const) {
        re.lastIndex = 0;
        const m = re.exec(text);
        if (m) hits.push(`${state} ${where}: "${m[0]}" (${term})`);
      }
    }
    seen[state] = (dom + "\n" + ax).replace(/\s+/g, " ").slice(0, 4000);
  }
  async function open(o: Parameters<typeof newPage>[0] = {}) {
    const r = await newPage(o);
    r.page.on("request", (q) => { const u = new URL(q.url()); if (!/^(127\.0\.0\.1|localhost)$/.test(u.hostname) && u.protocol !== "data:" && u.protocol !== "blob:") foreign.push(q.url()); });
    return r;
  }
  const shown = (p: Page, sel: string) => p.waitForFunction((s) => { const g = document.querySelector("toll-gate") as any; const el = g?.shadowRoot?.querySelector(s); return el && !el.hidden && !g.hidden; }, sel, { timeout: 10000 });

  // 1. fast solve: nothing rendered
  { const { page, ctx } = await open(); const redeemed = page.waitForResponse((r) => r.url().includes("/v1/redeem")); await page.goto(tiny.url + "/"); await redeemed; await scan(page, "1 invisible"); await ctx.close(); }
  // 2-3. slow solve: Checking…, then Verified (gap 1: states 2, 3, 4 and 8 show after the first interaction)
  { const { page, ctx } = await open(); const redeemed = page.waitForResponse((r) => r.url().includes("/v1/redeem"), { timeout: 20000 }); await page.goto(slow.url + "/"); await page.focus("#m"); await shown(page, '[role="status"]'); await scan(page, "2 checking"); await redeemed; await page.waitForTimeout(50); await scan(page, "3 verified"); await ctx.close(); }
  // 4. reduced motion
  { const { page, ctx } = await open({ reducedMotion: "reduce" }); await page.goto(slow.url + "/"); await page.focus("#m"); await shown(page, ".bar"); await scan(page, "4 reduced motion"); await ctx.close(); }
  // 5-7. checkbox mode: idle, busy, verified
  { const { page, ctx } = await open(); await fixture(page, slow.url, `<form method="post" action="/contact" data-toll="write" data-toll-checkbox="true"><input name="m"><button type="submit">Send</button></form>`);
    await shown(page, "button.btn"); await scan(page, "5 checkbox");
    await page.evaluate(() => (document.querySelector("toll-gate") as any).shadowRoot.querySelector("button.btn").click());
    await page.waitForFunction(() => (document.querySelector("toll-gate") as any).shadowRoot.querySelector("button.btn").getAttribute("aria-busy") === "true", null, { timeout: 5000 });
    await scan(page, "6 checkbox busy");
    await page.waitForFunction(() => (document.querySelector("toll-gate") as any).shadowRoot.querySelector("button.btn").textContent === "Verified", null, { timeout: 20000 });
    await scan(page, "7 checkbox verified"); await ctx.close(); }
  // 8. issuer unreachable
  { const { page, ctx } = await open(); await page.route("**/v1/challenge*", (r) => r.abort()); await page.goto(fast.url + "/"); await page.focus("#m"); await shown(page, '[role="alert"]'); await scan(page, "8 error"); await ctx.close(); }
  // 9. no JavaScript
  { const { page, ctx } = await open({ js: false }); await page.goto(fast.url + "/"); await scan(page, "9 no-js"); await ctx.close(); }
  // Hardened engine, while checking
  { const { page, ctx } = await open(); const redeemed = page.waitForResponse((r) => r.url().includes("/v1/redeem"), { timeout: 30000 }); await page.goto(hard.url + "/"); await redeemed; await scan(page, "hardened"); await ctx.close(); }

  assert.deepEqual(hits, []);
  assert.deepEqual(foreign, [], "no request leaves the site's origin");
  // The scan saw the states it claims to have seen.
  assert.match(seen["2 checking"], /Checking…/);
  assert.match(seen["3 verified"], /Verified/);
  assert.match(seen["5 checkbox"], /Verify before sending/);
  assert.match(seen["8 error"], /Couldn't check this form\./);
  assert.match(seen["9 no-js"], /This form needs JavaScript\./);
  // The list really is non-empty and catches a vendor name if one leaked.
  assert.ok(res.length >= 5 && res.some(({ re }) => { re.lastIndex = 0; return re.test("Protected by ALTCHA"); }));
});

// ---- Phase 2: paid requests on (local test backend, fixed test rate) ------------------------------
test("phase 2 demo: USD-only stats and owner block, live after 5 paid agent writes; no msat, coin or vendor words; '—' + Rate unavailable when the rate is down; widget flow unchanged", async () => {
  const { FixedTestRate } = await import("../packages/settlement-ln/src/index.ts");
  const { agentPay } = await import("../packages/agent/src/agent-pay.ts");
  const { PAID_ON } = await import("./helpers.ts");
  // @ts-ignore plain JS helper
  const { lintRegexes, vendorRegexes } = await import("../scripts/copy-lib.mjs");
  const fx = new FixedTestRate(100000);
  const paid = await startDemo({ work: { standard: { unit_tries: 2 } }, ...PAID_ON }, { settlement: { fx } });
  const { page, ctx, errors } = await newPage();
  try {
    const run = await agentPay({ base: paid.url, writes: 5 });
    assert.equal(run.ok, true);
    await page.goto(paid.url + "/hammer");
    await page.waitForFunction(() => document.getElementById("ag-cells")?.getAttribute("aria-label") === "5 of 20 accepted", null, { timeout: 5000 });
    // The widget's challenges carry no offers (the widget is never an agent).
    const offers: unknown[] = [];
    page.on("response", async (r) => { if (r.url().includes("/v1/challenge")) offers.push(((await r.json().catch(() => ({}))) as any).offers); });
    await page.goto(paid.url + "/");
    await page.waitForFunction(() => document.getElementById("st-paid")?.textContent === "5", null, { timeout: 5000 });
    const text = await page.evaluate(() => document.body.innerText);
    assert.match(text, /test payments on/);
    assert.match(text, /Paid requests\s+5/);
    assert.match(text, /Usage value collected\s+\$0\.05/);
    assert.match(text, /Collect usage payouts/);
    assert.match(text, /\$0\.04\s+available to withdraw · after the 10% platform fee/);
    const scanText = text + "\n" + (await page.content()).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
    for (const { re, term } of [...lintRegexes(), ...vendorRegexes()]) { re.lastIndex = 0; assert.ok(!re.test(scanText), term); }
    assert.doesNotMatch(text, /msat|invoice|preimage|stub/i);
    // The widget still protects the visitor's form.
    await page.click("#contact button[type=submit]");
    await page.waitForURL(/sent=contact/, { timeout: 15000 });
    assert.ok(offers.length > 0 && offers.every((o) => Array.isArray(o) && o.length === 0), JSON.stringify(offers));
    // Rate down: amounts hide, the ledger does not change.
    fx.setDown(true);
    await page.goto(paid.url + "/");
    assert.equal(await page.textContent("#bal-amt"), "—");
    assert.equal(await page.textContent("#st-coll"), "—");
    assert.equal(await page.isVisible("#bal-rate"), true);
    assert.equal(await page.textContent("#bal-rate"), "Rate unavailable");
    fx.setDown(false);
    await page.waitForFunction(() => document.getElementById("bal-amt")?.textContent === "$0.04", null, { timeout: 5000 });
    assert.equal(await page.isVisible("#bal-rate"), false);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
    await paid.close();
  }
});

test("owner toggle (demo-only): untick -> 'work-only' tag, balance still shown, agents fall back to work; tick -> 'test payments on', agents pay; checkbox is a live, full-contrast control", async () => {
  const { agentPay } = await import("../packages/agent/src/agent-pay.ts");
  const { PAID_ON } = await import("./helpers.ts");
  const paid = await startDemo({ work: { standard: { cost: 500 } }, ...PAID_ON });
  const { page, ctx, errors } = await newPage();
  try {
    assert.equal((await agentPay({ base: paid.url, writes: 2 })).paid, 2);
    await page.goto(paid.url + "/");
    const box = page.locator("#payouts-toggle");
    assert.equal(await box.isChecked(), true);
    assert.equal(await box.isEnabled(), true);
    const look = await page.evaluate(() => {
      const el = document.getElementById("payouts-toggle")!;
      const label = el.closest("label")!;
      return { disabled: (el as HTMLInputElement).disabled, op: getComputedStyle(el).opacity, labelOp: getComputedStyle(label).opacity, color: getComputedStyle(label).color };
    });
    assert.deepEqual({ disabled: look.disabled, op: look.op, labelOp: look.labelOp }, { disabled: false, op: "1", labelOp: "1" });
    assert.equal(await page.textContent("#mode-tag"), "test payments on");
    // Untick.
    await page.click('label:has(#payouts-toggle)');
    await page.waitForFunction(() => document.getElementById("mode-tag")?.textContent === "work-only", null, { timeout: 5000 });
    assert.equal(await box.isChecked(), false);
    assert.notEqual(await page.textContent("#mode-tag"), "test payments paused");
    assert.equal(await page.textContent("#bal-amt"), "$0.01", "balance stays visible while unticked (2 writes: 18,000 msat net)");
    assert.equal(await page.isVisible("#bal-rate"), false);
    const off = await agentPay({ base: paid.url, writes: 2 });
    assert.equal(off.ok, true);
    assert.deepEqual([off.paid, off.work], [0, 2]);
    await page.waitForTimeout(2200); // a stats refresh must not flip the box back
    assert.equal(await box.isChecked(), false);
    assert.equal(await page.textContent("#mode-tag"), "work-only");
    // Tick again.
    await page.click('label:has(#payouts-toggle)');
    await page.waitForFunction(() => document.getElementById("mode-tag")?.textContent === "test payments on", null, { timeout: 5000 });
    const on = await agentPay({ base: paid.url, writes: 1 });
    assert.deepEqual([on.paid, on.work, on.replay?.rejected], [1, 0, true]);
    await page.waitForFunction(() => document.getElementById("st-paid")?.textContent === "3", null, { timeout: 5000 });
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
    await paid.close();
  }
});
