// toll.js: invisible check for forms (spec §10, design handoff §1).
// - All grinding happens in toll.worker.js. Nothing is hashed on the page's main thread.
// - Never reads or sends form field values. Only adds a hidden "toll-pass" input.
// - Renders inside a shadow root with the designer's toll-gate.css; inherits host font and colour.

import CSS from "./toll-gate.css";
import { S } from "./strings.gen.ts";

type Cls = "search" | "write" | "account" | "admin";
const RANK: Record<string, number> = { read: 0, search: 1, write: 4, account: 8, admin: 16 };
const SHOW_AFTER_MS = 500;
const MIN_VISIBLE_MS = 400;
const INPAGE_VERIFIED_HIDE_MS = 3000;

interface Pass { token: string | null; cls: string; exp: number; n: number; took_ms?: number }

// ---- configuration from the script tag ---------------------------------------------------------
const script = document.currentScript as HTMLScriptElement | null;
const scriptUrl = new URL(script?.src || location.href, location.href);
const ds = script?.dataset ?? {};
const ISSUER = (ds.issuer || scriptUrl.origin).replace(/\/$/, "");
const WORKER_URL = new URL("toll.worker.js", scriptUrl).href;
const SITE = ds.site || "";
const MAX_SOLVE_MS = Number(ds.maxSolveMs) > 0 ? Number(ds.maxSolveMs) : 8000;
const UA_CLASS = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "mobile" : "desktop";
const now = () => Math.floor(Date.now() / 1000);

// ---- passes ------------------------------------------------------------------------------------
const passes: Pass[] = [];
let cookieStatus: Promise<Pass | null> | null = null;

function covers(p: Pass, action: string) {
  return RANK[p.cls] >= RANK[action] && p.exp > now() + 5 && p.n > 0;
}

function memoryPass(action: string): Pass | undefined {
  return passes.filter((p) => covers(p, action)).sort((a, b) => RANK[a.cls] - RANK[b.cls])[0];
}

/** The first-party cookie is HttpOnly, so ask the issuer what it covers (spec §8.3). */
function statusPass(): Promise<Pass | null> {
  if (!cookieStatus) {
    cookieStatus = fetch(ISSUER + "/v1/status", { credentials: "include", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && j.ok ? { token: null, cls: j.cls, exp: j.exp, n: j.n } : null))
      .catch(() => null);
  }
  return cookieStatus;
}

async function validPass(action: string): Promise<Pass | null> {
  const m = memoryPass(action);
  if (m) return m;
  const c = await statusPass();
  return c && covers(c, action) ? c : null;
}

// ---- worker ------------------------------------------------------------------------------------
let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { ok: (v: any) => void; ko: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(WORKER_URL);
    worker.onmessage = (e) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      e.data.ok ? w.ok(e.data) : w.ko(new Error(e.data.error));
    };
    worker.onerror = () => {
      for (const w of waiting.values()) w.ko(new Error("worker failed"));
      waiting.clear();
      worker = null;
    };
  }
  return worker;
}

/** Stop any in-flight solve (used at the time cap). */
function stopWorker() {
  if (worker) worker.terminate();
  worker = null;
  for (const w of waiting.values()) w.ko(new Error("stopped"));
  waiting.clear();
}

function solveInWorker(challenge: unknown): Promise<{ nonces: string[]; took_ms: number }> {
  return new Promise((ok, ko) => {
    const id = ++seq;
    waiting.set(id, { ok, ko });
    getWorker().postMessage({ id, challenge });
  });
}

async function fetchChallenge(action: string): Promise<any> {
  const q = new URLSearchParams({ action, client: "widget", path: location.pathname });
  if (SITE) q.set("site", SITE);
  const r = await fetch(ISSUER + "/v1/challenge?" + q, { credentials: "include", cache: "no-store" });
  if (!r.ok) throw new Error("challenge " + r.status);
  return (await r.json()).challenge;
}

async function redeem(challenge: any, sol: { nonces: string[]; took_ms: number }): Promise<Pass> {
  const r = await fetch(ISSUER + "/v1/redeem", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge_id: challenge.id, challenge, solution: { nonces: sol.nonces, took_ms: sol.took_ms, ua_class: UA_CLASS } }),
  });
  if (!r.ok) throw new Error("redeem " + r.status);
  const j = await r.json();
  const p: Pass = { token: j.pass, cls: j.cls, exp: j.exp, n: 20, took_ms: sol.took_ms };
  passes.push(p);
  return p;
}

async function solveChallenge(challenge: any): Promise<Pass> {
  return redeem(challenge, await solveInWorker(challenge));
}

const inflight = new Map<string, Promise<Pass>>();

/** Get a pass for `action`, reusing a valid one or a solve already running for an equal or higher class. */
function obtainPass(action: string, fresh = false): Promise<Pass> {
  if (!fresh) {
    for (const [cls, p] of inflight) if (RANK[cls] >= RANK[action]) return p;
  }
  const job = (async () => {
    if (!fresh) {
      const v = await validPass(action);
      if (v) return v;
    }
    return solveChallenge(await fetchChallenge(action));
  })();
  if (!fresh) {
    inflight.set(action, job);
    job.then(() => inflight.delete(action), () => inflight.delete(action));
  }
  return job;
}

// ---- the <toll-gate> element -------------------------------------------------------------------
const CHECK_SVG = '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ALERT_SVG = '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4.6v4.2M8 11.2v.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

let sheet: CSSStyleSheet | null = null;
function styleInto(root: ShadowRoot) {
  try {
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
    }
    root.adoptedStyleSheets = [sheet];
  } catch {
    const st = document.createElement("style");
    st.textContent = CSS;
    root.appendChild(st);
  }
}

type View = "none" | "checking" | "verified" | "error" | "box-ready" | "box-working" | "box-verified";

class TollGate extends HTMLElement {
  private root: ShadowRoot;
  private status: HTMLSpanElement;
  private alert: HTMLSpanElement;
  private btn: HTMLButtonElement;
  private form: HTMLFormElement | null = null;
  private pass: Pass | null = null;
  private job: Promise<Pass> | null = null;
  private pending: { submitter: HTMLElement | null } | null = null;
  private resubmitting = false;
  private announcedChecking = false;
  private checkingShownAt = 0;
  private view: View = "none";
  private boxMode = false;
  private started = false;
  private runId = 0;
  onRetry: (() => void) | null = null;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    styleInto(this.root);
    this.status = document.createElement("span");
    this.status.className = "s";
    this.status.setAttribute("role", "status");
    this.alert = document.createElement("span");
    this.alert.className = "s err";
    this.alert.setAttribute("role", "alert");
    this.alert.hidden = true;
    this.btn = document.createElement("button");
    this.btn.type = "button";
    this.btn.className = "btn";
    this.btn.hidden = true;
    this.btn.addEventListener("click", () => this.onBoxClick());
    this.root.append(this.status, this.alert, this.btn);
  }

  get action(): Cls {
    const a = (this.getAttribute("action") || "write") as Cls;
    return RANK[a] > 0 ? a : "write";
  }

  connectedCallback() {
    if (this.view === "none") this.hidden = true;
    if (this.form) return;
    this.form = this.closest("form");
    const box = this.getAttribute("data-toll-checkbox") === "true" || this.form?.getAttribute("data-toll-checkbox") === "true";
    if (this.form) bindForm(this.form, this);
    if (box) this.showBox("box-ready");
  }

  // -- triggers (spec §9.3): idle, or first focus / input / pointerdown in the form
  armTriggers() {
    if (this.boxMode || !this.form) return;
    const go = () => this.start();
    const f = this.form;
    for (const ev of ["focusin", "input", "pointerdown"]) f.addEventListener(ev, go, { once: true, passive: true });
    const ric = (window as any).requestIdleCallback as ((cb: () => void, o?: object) => number) | undefined;
    ric ? ric(go, { timeout: 2000 }) : setTimeout(go, 1);
  }

  /** Begin a solve unless a valid pass exists or one is already running. */
  start(): Promise<Pass> | null {
    if (this.pass && covers(this.pass, this.action)) return null;
    if (this.job) return this.job;
    this.started = true;
    return this.run(false);
  }

  private run(fresh: boolean): Promise<Pass> {
    const id = ++this.runId;
    this.setView(this.boxMode ? "box-working" : "none");
    let shown = false;
    const showTimer = setTimeout(() => {
      if (id !== this.runId) return;
      shown = true;
      if (!this.boxMode) this.setView("checking");
    }, SHOW_AFTER_MS);
    // The cap applies to background checks only. Once the visitor presses "Verify before sending"
    // the check runs to the end (the issuer's max_iterations still bounds it).
    const capTimer = setTimeout(() => {
      if (id !== this.runId || this.boxMode) return;
      // Owner's longest check reached: stop and offer the checkbox (design handoff §1.2.6).
      this.runId++;
      this.job = null;
      stopWorker();
      clearTimeout(showTimer);
      this.boxMode = true;
      this.showBox("box-ready");
      this.form?.removeAttribute("aria-busy");
      this.pending = null;
    }, MAX_SOLVE_MS);
    const job = obtainPass(this.action, fresh);
    this.job = job;
    job.then(
      (p) => {
        if (id !== this.runId) return;
        clearTimeout(showTimer);
        clearTimeout(capTimer);
        this.job = null;
        this.pass = p;
        if (this.boxMode) {
          this.setView("box-verified");
        } else if (shown) {
          // Verified only if Checking… was shown; keep Checking… up at least 400ms (handoff §1.2).
          const wait = Math.max(0, MIN_VISIBLE_MS - (performance.now() - this.checkingShownAt));
          setTimeout(() => id === this.runId && this.setView("verified"), wait);
        }
        this.flushPending();
      },
      () => {
        if (id !== this.runId) return;
        clearTimeout(showTimer);
        clearTimeout(capTimer);
        this.job = null;
        this.pending = null;
        this.form?.removeAttribute("aria-busy");
        this.setView("error");
      }
    );
    return job;
  }

  private onBoxClick() {
    if (this.view !== "box-ready") return;
    this.boxMode = true;
    this.run(true).catch(() => {});
  }

  private retry() {
    this.alert.hidden = true;
    if (this.onRetry) return this.onRetry();
    if (this.boxMode) this.showBox("box-ready");
    this.run(true).catch(() => {});
  }

  // -- form submit gate (capture phase, so host handlers never see a submit without a pass)
  onSubmit(e: SubmitEvent) {
    if (this.resubmitting) {
      this.resubmitting = false;
      return;
    }
    if (this.pass && covers(this.pass, this.action)) {
      this.injectPass();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (this.pending) return; // swallow repeat submits: exactly one resubmit
    this.pending = { submitter: (e.submitter as HTMLElement) ?? null };
    this.form!.setAttribute("aria-busy", "true");
    if (this.view === "error") this.alert.hidden = true;
    if (this.view === "box-ready") this.boxMode = true;
    if (!this.job) this.run(false).catch(() => {});
  }

  private injectPass() {
    if (!this.form || !this.pass) return;
    this.pass.n = Math.max(0, this.pass.n - 1);
    if (!this.pass.token) return; // the first-party cookie carries it
    let input = this.form.querySelector<HTMLInputElement>('input[name="toll-pass"]');
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = "toll-pass";
      this.form.appendChild(input);
    }
    input.value = this.pass.token;
  }

  private flushPending() {
    if (!this.pending || !this.form) return;
    const { submitter } = this.pending;
    this.pending = null;
    this.injectPass();
    this.form.removeAttribute("aria-busy");
    this.resubmitting = true;
    const f = this.form;
    if (typeof f.requestSubmit === "function") {
      try {
        f.requestSubmit(submitter && (submitter as HTMLButtonElement).form === f ? (submitter as HTMLButtonElement) : undefined);
        return;
      } catch {
        /* fall through */
      }
    }
    this.resubmitting = false;
    f.submit();
  }

  // -- rendering
  private showBox(v: "box-ready" | "box-working" | "box-verified") {
    this.boxMode = true;
    this.setView(v);
  }

  setView(v: View) {
    this.view = v;
    const st = this.status;
    // Only hide what is not about to be shown, so a focused button keeps focus (handoff state 7).
    st.hidden = v !== "checking" && v !== "verified";
    this.alert.hidden = v !== "error";
    this.btn.hidden = !v.startsWith("box-");
    this.hidden = v === "none";
    if (v === "checking") {
      // Announce Checking… at most once per form per page load.
      if (this.announcedChecking) st.setAttribute("aria-live", "off");
      else st.removeAttribute("aria-live");
      this.announcedChecking = true;
      this.checkingShownAt = performance.now();
      st.innerHTML = '<span class="bar" aria-hidden="true"></span>';
      st.append(S.checking);
      st.hidden = false;
    } else if (v === "verified") {
      st.removeAttribute("aria-live");
      st.innerHTML = CHECK_SVG;
      st.append(S.verified);
      st.hidden = false;
    } else if (v === "error") {
      this.alert.innerHTML = ALERT_SVG;
      this.alert.append(S.error);
      const link = document.createElement("button");
      link.type = "button";
      link.className = "link";
      link.textContent = S.retry;
      link.addEventListener("click", () => this.retry());
      this.alert.append(link);
      this.alert.hidden = false;
    } else if (v.startsWith("box-")) {
      const b = this.btn;
      b.hidden = false;
      b.removeAttribute("aria-busy");
      b.removeAttribute("aria-disabled");
      const box = '<span class="box" aria-hidden="true">' + (v === "box-verified" ? CHECK_SVG : "") + "</span>";
      b.innerHTML = box;
      if (v === "box-ready") b.append(S.verify);
      if (v === "box-working") {
        b.setAttribute("aria-busy", "true");
        b.setAttribute("aria-disabled", "true");
        b.append(S.checking);
      }
      if (v === "box-verified") {
        b.setAttribute("aria-disabled", "true");
        b.append(S.verified);
      }
    }
  }

  /** Used by toll.fetch to drive this element's states for in-page actions. */
  async runFor(challenge: any): Promise<Pass> {
    const id = ++this.runId;
    let shown = false;
    const t = setTimeout(() => {
      if (id === this.runId) {
        shown = true;
        this.setView("checking");
      }
    }, SHOW_AFTER_MS);
    try {
      const p = await solveChallenge(challenge);
      clearTimeout(t);
      if (shown) {
        const wait = Math.max(0, MIN_VISIBLE_MS - (performance.now() - this.checkingShownAt));
        setTimeout(() => this.setView("verified"), wait);
        setTimeout(() => this.view === "verified" && this.setView("none"), wait + INPAGE_VERIFIED_HIDE_MS);
      }
      return p;
    } catch (e) {
      clearTimeout(t);
      this.setView("error");
      throw e;
    }
  }

  get isStarted() {
    return this.started;
  }
}

// ---- auto-bind -----------------------------------------------------------------------------------
const bound = new WeakSet<HTMLFormElement>();

function bindForm(form: HTMLFormElement, gate?: TollGate) {
  if (bound.has(form)) return;
  bound.add(form);
  let g = gate ?? form.querySelector<TollGate>("toll-gate") ?? undefined;
  if (!g) {
    g = document.createElement("toll-gate") as TollGate;
    const action = form.getAttribute("data-toll") || form.getAttribute("data-toll-action") || "write";
    g.setAttribute("action", RANK[action] > 0 ? action : "write");
    if (form.getAttribute("data-toll-checkbox") === "true") g.setAttribute("data-toll-checkbox", "true");
    // Right after the last submit button; at the end of the form if there is none (handoff §1.1).
    const submits = form.querySelectorAll('button:not([type]), button[type="submit"], input[type="submit"]');
    const last = submits[submits.length - 1];
    if (last) last.insertAdjacentElement("afterend", g);
    else form.appendChild(g);
  }
  const gateEl = g;
  form.addEventListener("submit", (e) => gateEl.onSubmit(e as SubmitEvent), { capture: true });
  if (form.getAttribute("data-toll-checkbox") !== "true" && gateEl.getAttribute("data-toll-checkbox") !== "true") gateEl.armTriggers();
}

function scan(root: ParentNode = document) {
  root.querySelectorAll<HTMLFormElement>("form[data-toll], form[data-toll-action]").forEach((f) => bindForm(f));
}

// ---- toll.fetch ------------------------------------------------------------------------------------
async function tollFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const best = passes.filter((p) => p.token && p.exp > now() + 5 && p.n > 0).sort((a, b) => RANK[b.cls] - RANK[a.cls])[0];
  if (best && !headers.has("authorization")) headers.set("authorization", "Toll " + best.token);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  let res = await fetch(input, { ...init, headers });
  if (res.status !== 403) return res;
  const body = await res.clone().json().catch(() => null);
  if (!body || body.error !== "toll_required" || !body.challenge) return res;
  const action = body.challenge?.bound?.action;
  const gate = document.querySelector<TollGate>(`toll-gate[action="${action}"]`);
  const p = gate && !gate.closest("form") ? await gate.runFor(body.challenge) : await solveChallenge(body.challenge);
  if (p.token) headers.set("authorization", "Toll " + p.token);
  p.n = Math.max(0, p.n - 1);
  res = await fetch(input, { ...init, headers });
  return res;
}

// ---- public API ------------------------------------------------------------------------------------
async function getPass(action: Cls = "write", o: { fresh?: boolean } = {}) {
  const p = await obtainPass(action, !!o.fresh);
  return { pass: p.token, cls: p.cls, exp: p.exp, took_ms: p.took_ms ?? null };
}

if (!customElements.get("toll-gate")) customElements.define("toll-gate", TollGate);
const api = { fetch: tollFetch, getPass, version: "1.0.0" };
(window as any).toll = api;
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => scan());
else scan();
new MutationObserver((muts) => {
  for (const m of muts) for (const n of m.addedNodes) if (n instanceof HTMLElement) {
    if (n.matches("form[data-toll], form[data-toll-action]")) bindForm(n as HTMLFormElement);
    else scan(n);
  }
}).observe(document.documentElement, { childList: true, subtree: true });
