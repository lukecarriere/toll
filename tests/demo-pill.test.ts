// The demo result pills carry the HTML hidden attribute and appear only after their action.
// website/demo.css sets .pill { display: inline-block }, which beats the user-agent
// [hidden] { display: none } rule, so both pills painted on load. Visitors of /demo
// depend on them staying hidden until demo.js clears the attribute.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

const SITE = new URL("../website/", import.meta.url);
const FILES: Record<string, { file: string; type: string }> = {
  "/demo": { file: "demo.html", type: "text/html; charset=utf-8" },
  "/site.css": { file: "site.css", type: "text/css" },
  "/demo.css": { file: "demo.css", type: "text/css" },
  "/demo.js": { file: "demo.js", type: "text/javascript" },
};

let server: Server;
let base = "";
let browser: Browser;

function send(res: import("node:http").ServerResponse, status: number, body: string, headers: Record<string, string>) {
  res.writeHead(status, headers).end(body);
}

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/demo/stats") {
      send(res, 200, JSON.stringify({ accepted: 0, rejected: 0 }), { "content-type": "application/json", "cache-control": "no-store" });
      return;
    }
    if (req.method === "POST" && path === "/demo/contact") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        void Buffer.concat(chunks);
        const accept = req.headers.accept ?? "";
        if (accept.includes("application/json")) {
          send(res, 403, JSON.stringify({ error: "toll_required" }), { "content-type": "application/json" });
          return;
        }
        res.writeHead(303, { location: "/demo?sent=contact" }).end();
      });
      return;
    }
    const hit = req.method === "GET" ? FILES[path] : undefined;
    if (!hit) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": hit.type }).end(readFileSync(new URL(hit.file, SITE)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Layout box of a result pill. display:none (the hidden attribute, when it wins) has no box. */
function pillBox(page: Page, id: string) {
  return page.locator("#" + id).evaluate((el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      hidden: (el as HTMLElement).hidden,
      display: style.display,
      width: rect.width,
      height: rect.height,
      text: el.textContent,
    };
  });
}

test("demo result pills stay hidden on load and show only after their action", async () => {
  const page = await browser.newPage();
  const loaded = await page.goto(base + "/demo", { waitUntil: "networkidle" });
  assert.equal(loaded?.status(), 200);

  const sent = await pillBox(page, "sent");
  const rejected = await pillBox(page, "nopass-out");
  assert.equal(sent.hidden, true, "accepted pill keeps the hidden attribute before a submit");
  assert.equal(rejected.hidden, true, "rejected pill keeps the hidden attribute before the click");
  assert.equal(sent.display, "none", "accepted pill is painted on load: " + JSON.stringify(sent));
  assert.equal(rejected.display, "none", "rejected pill is painted on load: " + JSON.stringify(rejected));
  assert.equal(sent.width, 0);
  assert.equal(rejected.width, 0);

  await page.locator("#nopass-btn").click();
  await page.waitForFunction(() => {
    const el = document.getElementById("nopass-out");
    return !!el && !el.hidden && getComputedStyle(el).display !== "none";
  });
  const afterClick = await pillBox(page, "nopass-out");
  const stillSent = await pillBox(page, "sent");
  assert.equal(afterClick.text, "✕ Rejected · 403");
  assert.equal(afterClick.display, "inline-block");
  assert.ok(afterClick.width > 0);
  assert.equal(stillSent.display, "none");

  await page.locator('#contact button[type="submit"]').click();
  await page.waitForURL(/[?&]sent=contact(?:&|$)/);
  const accepted = await pillBox(page, "sent");
  const rejectedAgain = await pillBox(page, "nopass-out");
  assert.equal(accepted.text, "✓ Accepted · 200");
  assert.equal(accepted.hidden, false);
  assert.equal(accepted.display, "inline-block");
  assert.ok(accepted.width > 0);
  assert.equal(rejectedAgain.display, "none");
  await page.close();
});
