// Bot hammer: 50 plain POSTs with no pass, then 50 POSTs that each solve in the worker first.
(function () {
  function cell(grid, i, ok) {
    const c = grid.children[i];
    c.className = "cell " + (ok ? "a" : "r");
    c.textContent = ok ? "✓" : "✕";
    c.title = ok ? "Accepted" : "Rejected";
  }
  function setup(id, runOne) {
    const btn = document.getElementById(id + "-btn");
    const grid = document.getElementById(id + "-cells");
    btn.addEventListener("click", async function () {
      btn.disabled = true;
      for (const c of grid.children) { c.className = "cell p"; c.textContent = "·"; c.title = "not sent yet"; }
      let acc = 0, rej = 0, solveSum = 0, solveN = 0;
      const show = function () {
        document.getElementById(id + "-acc").textContent = String(acc);
        document.getElementById(id + "-rej").textContent = String(rej);
        document.getElementById(id + "-mean").textContent = solveN ? Math.round(solveSum / solveN) + " ms" : "n/a";
        grid.setAttribute("aria-label", acc + " of 50 accepted");
      };
      show();
      for (let i = 0; i < 50; i++) {
        let ok = false;
        try {
          const r = await runOne();
          ok = r.ok;
          if (r.took_ms != null) { solveSum += r.took_ms; solveN++; }
        } catch (e) { ok = false; }
        ok ? acc++ : rej++;
        cell(grid, i, ok);
        show();
      }
      btn.disabled = false;
      document.body.setAttribute("data-" + id + "-done", acc + "/" + rej);
    });
  }
  function post(headers) {
    return fetch("/contact", { method: "POST", credentials: "omit", headers: Object.assign({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, headers), body: "message=hammer" });
  }
  setup("r1", async function () {
    const r = await post({});
    return { ok: r.status === 200, took_ms: null };
  });
  setup("r2", async function () {
    const p = await window.toll.getPass("write", { fresh: true });
    const r = await post({ authorization: "Toll " + p.pass });
    return { ok: r.status === 200, took_ms: p.took_ms };
  });
})();
