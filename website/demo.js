const sent = document.getElementById("sent");
if (sent && new URLSearchParams(location.search).get("sent") === "contact") sent.hidden = false;

async function refresh() {
  const r = await fetch("/demo/stats", { cache: "no-store" });
  if (!r.ok) return;
  const j = await r.json();
  const acc = document.getElementById("st-acc");
  const rej = document.getElementById("st-rej");
  if (acc) acc.textContent = String(j.accepted);
  if (rej) rej.textContent = String(j.rejected);
}

refresh();

document.getElementById("nopass-btn")?.addEventListener("click", async () => {
  const r = await fetch("/demo/contact", {
    method: "POST",
    credentials: "omit",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: "message=hi",
  });
  const out = document.getElementById("nopass-out");
  if (out && r.status === 403) out.hidden = false;
  refresh();
});
