// Live stats (forms and hammer pages) and the "Send without a pass" check (forms page). No form values are read here.
(function () {
  function ms(v) { return v == null ? "—" : Math.round(v) + " ms"; }
  async function stats() {
    try {
      const s = await (await fetch("/demo/stats", { cache: "no-store" })).json();
      document.getElementById("st-acc").textContent = String(s.accepted);
      document.getElementById("st-rej").textContent = String(s.rejected);
      document.getElementById("st-mean").textContent = ms(s.mean_solve_ms);
    } catch (e) { /* keep last values */ }
  }
  stats();
  setInterval(stats, 2000);
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
