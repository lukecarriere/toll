import { COPY, resultsFor } from "./strings.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface Comment { name: string; text: string; at: number }

function header(host: string, current: "forms" | "hammer") {
  const cur = (k: string) => (k === current ? ' aria-current="page"' : "");
  return `<header class="top"><div class="in"><a class="brand" href="/"><span class="mark"><i></i></span>${COPY.brand}</a>
<ul class="nav"><li><a href="/"${cur("forms")}>${COPY.navForms}</a></li><li><a href="/hammer"${cur("hammer")}>${COPY.navHammer}</a></li><li><a href="/hammer#agent">${COPY.navAgent}</a></li></ul>
<span class="tag">${esc(host)} · ${COPY.modeWorkOnly}</span></div></header>`;
}

function head(title: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/assets/demo.css"><link rel="stylesheet" href="/assets/demo-extra.css">
<script src="/toll/v1/toll.js" async></script></head><body>`;
}

/** Wraps the action class after "Gated as " in <code>, as the prototype does; the text itself is the copy.md string. */
function gatedAs(sub: string, cls: string) {
  const plain = esc(sub);
  const needle = `Gated as ${cls}`;
  if (!plain.includes(needle)) throw new Error(`demo copy: "${needle}" not found in "${sub}"`);
  return plain.replace(needle, `Gated as <code>${cls}</code>`);
}

function ago(at: number) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? "just now" : `${Math.round(s / 60)} min ago`;
}

function initials(name: string) {
  return name.split(/\s+/).map((p) => p[0] ?? "").join("").slice(0, 2).toUpperCase() || "?";
}

export function formsPage(o: { host: string; comments: Comment[]; sent?: string | null; q?: string | null; results?: string[] }) {
  const comments = o.comments.map((c) => `<li><span class="av">${esc(initials(c.name))}</span><div><b>${esc(c.name)}</b><time>${ago(c.at)}</time><p>${esc(c.text)}</p></div></li>`).join("");
  const results = o.q != null ? `<ul class="results"><li>${esc(resultsFor(o.results?.length ?? 0, o.q))}</li>${(o.results ?? []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "";
  const noscript = `<noscript><p class="nojs">${COPY.noJs}</p></noscript>`;
  return `${head(COPY.brand)}
${header(o.host, "forms")}
<main class="wrap">
<div class="intro"><h1>${COPY.introTitle}</h1><p class="lede">${COPY.introLede}</p></div>
<div class="col">
<section class="card" id="contact" aria-labelledby="c-h"><h2 id="c-h">${COPY.contact}</h2><p class="sub">${COPY.contactSub} <code>write</code>.</p>
<form method="post" action="/contact" data-toll="write"><div class="row2"><div><label for="n">${COPY.name}</label><input class="f" id="n" name="name" value="Ana Ruiz" autocomplete="name"></div><div><label for="e">${COPY.email}</label><input class="f" id="e" name="email" type="email" value="ana@example.com" autocomplete="email"></div></div>
<label for="m">${COPY.message}</label><textarea class="f" id="m" name="message">Hi, is the workshop on Saturday still on?</textarea>
<button class="b" type="submit">${COPY.send}</button>${noscript}</form>
${o.sent === "contact" ? `<p class="res"><span class="pill ok" role="status">${COPY.sentPill}</span></p>` : ""}</section>

<section class="card" id="comments" aria-labelledby="cm-h"><h2 id="cm-h">${COPY.comments}</h2><p class="sub">${gatedAs(COPY.commentsSub, "write")}</p>
<ul class="comments">${comments}</ul>
<form method="post" action="/comments" data-toll="write"><label for="cmt">${COPY.addComment}</label><textarea class="f short" id="cmt" name="comment" required></textarea><button class="b" type="submit">${COPY.postComment}</button>${noscript}</form></section>

<section class="card" id="search" aria-labelledby="s-h"><h2 id="s-h">${COPY.search}</h2><p class="sub">${gatedAs(COPY.searchSub, "search")}</p>
<form class="search" method="post" action="/search" data-toll="search" role="search"><label for="q" class="vh">${COPY.search}</label><input class="f" id="q" name="q" value="${esc(o.q ?? "workshop")}"><button class="b" type="submit">${COPY.search}</button>${noscript}</form>
${results}</section>

<section class="card" id="nopass" aria-labelledby="x-h"><h2 id="x-h">${COPY.noPassTitle}</h2><p class="sub">${COPY.noPassSub}</p>
<pre class="term"><span class="g">$</span> curl -X POST ${esc(o.host)}/contact -d "message=hi"
<span class="r">403</span> {"error":"toll_required"}</pre>
<div class="res"><button class="b sec" type="button" id="nopass-btn">${COPY.noPassButton}</button><span class="pill bad" role="status" id="nopass-out" hidden>${COPY.rejected403}</span></div></section>
</div>
${statsAside()}
</main><script src="/assets/demo.js" defer></script></body></html>`;
}

function statsAside() {
  return `<aside class="stats" aria-labelledby="st-h"><div class="card">
<h2 id="st-h"><span class="live" aria-hidden="true"></span>${COPY.liveStats}</h2>
<dl class="kv"><dt>${COPY.statAccepted}</dt><dd id="st-acc">0</dd><dt>${COPY.statRejected}</dt><dd id="st-rej">0</dd><dt>${COPY.statMeanSolve}</dt><dd id="st-mean">—</dd></dl>
</div></aside>`;
}

function cells(n: number) {
  return Array.from({ length: n }, () => `<span class="cell p" title="${COPY.legendPending}">·</span>`).join("");
}

export function hammerPage(o: { host: string }) {
  const run = (id: string, title: string, sub: string) => `<section class="card" aria-labelledby="${id}-h"><h2 id="${id}-h">${title}</h2><p class="sub">${sub}</p>
<button class="b" type="button" id="${id}-btn">${COPY.run50}</button>
<div class="cells" id="${id}-cells" role="img" aria-label="0 of 50 accepted">${cells(50)}</div>
<div class="sum"><div><b id="${id}-acc">0</b><span>${COPY.accepted}</span></div><div><b id="${id}-rej">0</b><span>${COPY.rejected}</span></div><div><b id="${id}-mean">n/a</b><span>${COPY.meanSolve}</span></div></div></section>`;
  return `${head(COPY.brand + " · " + COPY.navHammer)}
${header(o.host, "hammer")}
<main class="wrap one">
<div class="intro"><h1>${COPY.hammerTitle}</h1><p class="lede">${COPY.hammerLede}</p></div>
<div class="runs">
${run("r1", COPY.runWithout, COPY.runWithoutSub)}
${run("r2", COPY.runWith, COPY.runWithSub)}
</div>
<div class="legend"><span>${COPY.legendAccepted}</span><span>${COPY.legendRejected}</span><span class="legend-p"><span class="cell p">·</span> ${COPY.legendPending}</span></div>
<section class="card locked" id="agent" aria-labelledby="r3"><h2 id="r3">${COPY.navAgent} <span class="badge">${COPY.phase2}</span></h2><p class="sub">${COPY.agentSub}</p>
<pre class="term"><span class="g">$</span> node demo/agent-pay.mjs --writes 20</pre>
<div class="cells cells20" role="img" aria-label="0 of 20 accepted">${cells(20)}</div></section>
${statsAside()}
</main><script src="/assets/demo.js" defer></script><script src="/assets/hammer.js" defer></script></body></html>`;
}
