// Live stats (forms and hammer pages) and the "Send without a pass" check (forms page). No form values are read here.
(function () {
  let busy = false; // a toggle request is in flight: don't let a stats refresh flip the box back
  function ms(v) { return v == null ? "—" : Math.round(v) + " ms"; }
  function set(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
  function agentRow(n) {
    const grid = document.getElementById("ag-cells");
    if (!grid) return;
    for (let i = 0; i < grid.children.length; i++) {
      const c = grid.children[i];
      const ok = i < n;
      c.className = "cell " + (ok ? "a" : "p");
      c.textContent = ok ? "✓" : "·";
      c.title = ok ? "✓ accepted" : "not sent yet";
    }
    grid.setAttribute("aria-label", n + " of 20 accepted");
  }
  async function stats() {
    try {
      const s = await (await fetch("/demo/stats", { cache: "no-store" })).json();
      document.getElementById("st-acc").textContent = String(s.accepted);
      document.getElementById("st-rej").textContent = String(s.rejected);
      document.getElementById("st-mean").textContent = ms(s.mean_solve_ms);
      const tag = document.getElementById("mode-tag");
      if (tag && s.mode) tag.textContent = s.mode;
      if (s.paid) {
        // USD strings only; a missing rate shows "—" and the "Rate unavailable" line.
        set("st-paid", String(s.paid.requests));
        set("st-coll", s.paid.collected || "—");
        set("ag-paid", String(s.paid.requests));
        set("ag-replay", s.paid.replayRejected + " ✕");
        set("ag-replay-l", s.paid.replayRejected === 1 ? "replayed payment rejected" : "replayed payments rejected");
        const tg = document.getElementById("payouts-toggle");
        if (tg && !busy) tg.checked = !!s.paid.collecting;
        set("ag-coll", s.paid.collected || "—");
        set("bal-amt", s.paid.available || "—");
        const rate = document.getElementById("bal-rate");
        if (rate) rate.hidden = s.paid.available != null;
        agentRow(Math.min(20, s.paid.agentAccepted));
      }
    } catch (e) { /* keep last values */ }
  }
  stats();
  setInterval(stats, 2000);
  // Demo-only: the owner block's "Collect usage payouts" switches offers for agents on and off.
  const toggle = document.getElementById("payouts-toggle");
  if (toggle) toggle.addEventListener("change", async function () {
    busy = true;
    try {
      const r = await fetch("/demo/payouts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ collect: toggle.checked }) });
      const j = await r.json();
      toggle.checked = !!j.collect;
    } catch (e) { /* keep the box as the server last reported it */ }
    busy = false;
    stats();
  });
  const btn = document.getElementById("nopass-btn");
  const out = document.getElementById("nopass-out");
  if (btn && out) btn.addEventListener("click", async function () {
    const r = await fetch("/contact", { method: "POST", credentials: "omit", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: "message=hi" });
    out.hidden = false;
    if (r.status === 403) { out.className = "pill bad"; out.textContent = "✕ Rejected · 403"; }
    else { out.className = "pill ok"; out.textContent = "✓ Accepted · " + r.status; }
    stats();
  });
})();
