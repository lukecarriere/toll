// Live checks for the public Toll site.
// Default is free and read-only: health, price, the 403 and 402 gates, and /demo/stats.
// --spend <cap> adds the real-ecash checks. Those need --proofs and --wallet (or TOLL_PROOFS
// and TOLL_WALLET). Paths are never built in. Tokens, proofs, and secrets are not printed.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { decodeBolt11 } from "../packages/settlement-ln/src/bolt11.ts";

const SECRET_KEY = /^(secret|C|c|dleq|proofs|pass|token|macaroon|invoice|preimage|credential|sig|signature|request)$/i;
const SECRET_TEXT = /(cashu[AB]|creqA|eyJ)[A-Za-z0-9_\-+/=.]{12,}|((?:Toll|Bearer|L402)\s+)[A-Za-z0-9_\-+/=.:]{12,}/g;

export function redact(value) {
  const json = JSON.stringify(value, (key, item) => {
    if (key && SECRET_KEY.test(key) && item != null && typeof item !== "number" && typeof item !== "boolean") {
      const rendered = typeof item === "string" ? item : JSON.stringify(item);
      return `<${key} redacted ${rendered.length} chars>`;
    }
    return item;
  });
  return json.replace(SECRET_TEXT, (match, prefix) => `<${(prefix || match.slice(0, 6)).trim()} redacted ${match.length}>`);
}

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return fallback;
}

function has(name) {
  return process.argv.includes(name);
}

const HELP = `Usage: scripts/live-checks.sh [--base URL] [--out dir] [--expect off|cashu] [--l402 on|off] [--spend <cap>] [--proofs file] [--wallet module] [--src checkout] [--steps a,b,c,d,e,f]

Free read-only checks (the default): health, price, POST /demo/contact 403 without an agent header and 402 with one, the L402 offer, and GET /demo/stats with exactly {accepted, rejected, reversals, reversed_sats}. Nothing is paid.

--expect cashu (the default, or EXPECT_PAYMENT): payments are on. The agent POST is a 402 with a creqA, and with --l402 on (the default) WWW-Authenticate is an L402 challenge whose invoice amount equals the write price.
--expect off: payments are off. Health and price report no settlement, the agent POST is the same 403 work check, and there is no X-Cashu, no WWW-Authenticate and no offer.

--spend <cap> also runs the real-ecash checks and will not spend more than <cap>. It reads proofs from --proofs or TOLL_PROOFS and the wallet module from --wallet or TOLL_WALLET. The module exports wallet(), norm, and MINT. Nothing secret is printed. A spend run's .state.json is mode 0600 and stays in the out dir.
`;

function schemeOf(value) {
  if (typeof value !== "string") return null;
  if (value.startsWith("cashuB")) return "cashuB";
  if (value.startsWith("cashuA")) return "cashuA";
  if (value.startsWith("creqA")) return "creqA";
  return "other";
}

async function main() {
  if (has("--help") || has("-h")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const here = path.dirname(new URL(import.meta.url).pathname);
  const repo = path.resolve(here, "..");
  const base = (arg("--base", process.env.TOLL_BASE || "https://lessspam.dev")).replace(/\/$/, "");
  const expect = arg("--expect", process.env.EXPECT_PAYMENT || "cashu");
  const l402 = arg("--l402", "on");
  if (!EXPECT_MODES.includes(expect) || !["on", "off"].includes(l402)) {
    console.error("--expect must be off or cashu, and --l402 on or off");
    process.exit(64);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.resolve(arg("--out", path.join(repo, ".verify-toll", `live-${stamp}`)));
  const spend = arg("--spend", "");
  mkdirSync(out, { recursive: true });
  const results = {};
  const lines = [];
  const note = (check, status, detail) => {
    results[check] = status;
    lines.push(`check ${check}: ${status}`);
    writeFileSync(path.join(out, `${check}.json`), redact({ check, status, ...detail }) + "\n");
  };

  await freeChecks({ base, expect, l402: l402 === "on", note });

  if (spend !== "") {
    if (!/^[0-9]+$/.test(spend)) {
      console.error("spend cap must be a whole number");
      process.exit(64);
    }
    const failedFree = Object.values(results).some((status) => status !== "PASS");
    if (failedFree) {
      finish(out, base, results, lines, "free checks failed; spend was not started");
      return;
    }
    await spendChecks({
      base,
      cap: Number(spend),
      out,
      src: path.resolve(arg("--src", repo)),
      proofs: arg("--proofs", process.env.TOLL_PROOFS || ""),
      walletModule: arg("--wallet", process.env.TOLL_WALLET || ""),
      steps: (arg("--steps", "a,b,c,d,e,f")).split(",").map((step) => step.trim()).filter(Boolean),
      note,
      line: (text) => lines.push(text),
    });
  }

  finish(out, base, results, lines, "");
}

function finish(out, base, results, lines, extra) {
  const values = Object.values(results);
  const pass = values.length > 0 && values.every((status) => status === "PASS" || status === "PASS_INDIRECT") && !extra;
  const overall = pass ? "PASS" : "FAIL";
  const summary = [
    "# Toll live checks",
    "",
    `- base: ${base}`,
    `- overall: ${overall}`,
    extra ? `- note: ${extra}` : "",
    "",
    "| Check | Result |",
    "| --- | --- |",
    ...Object.entries(results).map(([name, status]) => `| ${name} | ${status} |`),
    "",
  ].filter((line) => line !== undefined).join("\n");
  writeFileSync(path.join(out, "SUMMARY.md"), summary);
  for (const line of lines) console.log(line);
  if (extra) console.log(extra);
  console.log(`OVERALL: ${overall}`);
  console.log(`evidence: ${out}`);
  process.exit(pass ? 0 : 1);
}

async function readBody(response) {
  return response.text();
}

export const EXPECT_MODES = ["off", "cashu"];

/** Amount and scheme of an L402 challenge. The macaroon and invoice values are not returned. */
export function l402Challenge(header) {
  if (typeof header !== "string" || !/^L402\s/i.test(header.trim())) return { scheme: header ? header.trim().split(/\s/)[0] : null, amount_msat: null };
  const m = /invoice="([^"]+)"/i.exec(header);
  let amount = null;
  try { amount = m ? decodeBolt11(m[1].trim()).amountMsat : null; } catch { amount = null; }
  return { scheme: "L402", amount_msat: amount, macaroon: /macaroon="[^"]+"/i.test(header) };
}

/**
 * The free checks. Read-only: GETs, and POSTs that carry no payment header. `fetchImpl` is for tests.
 * `expect` is "cashu" (payments on) or "off".
 */
export async function freeChecks({ base, expect, l402 = true, note, fetchImpl = globalThis.fetch }) {
  const fetch = fetchImpl;
  const on = expect === "cashu";
  const healthRes = await fetch(base + "/v1/health", { signal: AbortSignal.timeout(20000) });
  const healthText = await readBody(healthRes);
  let health;
  try { health = JSON.parse(healthText); } catch { health = null; }
  const healthOk = healthRes.status === 200 && health && health.ok === true && typeof health.v === "string" && health.v !== "" && health.settlement === expect && health.edge === true;
  note("health", healthOk ? "PASS" : "FAIL", { http: healthRes.status, ok: health?.ok ?? null, v: health?.v ?? null, settlement: health?.settlement ?? null, edge: health?.edge ?? null });

  const priceRes = await fetch(base + "/v1/price?action=write", { signal: AbortSignal.timeout(20000) });
  const priceText = await readBody(priceRes);
  let price;
  try { price = JSON.parse(priceText); } catch { price = null; }
  const priceOk = priceRes.status === 200 && price && price.action === "write" && (on
    ? price.status === "cashu" && Number.isSafeInteger(price.amount_msat) && price.amount_msat > 0
    : price.status !== "cashu" && price.amount_msat === null);
  note("price", priceOk ? "PASS" : "FAIL", { http: priceRes.status, action: price?.action ?? null, status: price?.status ?? null, amount_msat: price?.amount_msat ?? null });

  const headers = { accept: "application/json", "content-type": "application/json", "toll-test": "1" };
  const human = await fetch(base + "/demo/contact", { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(20000) });
  const humanText = await readBody(human);
  let humanBody;
  try { humanBody = JSON.parse(humanText); } catch { humanBody = null; }
  const humanOk = human.status === 403 && humanBody && humanBody.error === "toll_required" && humanBody.challenge && typeof humanBody.challenge === "object" && humanBody.pass === undefined;
  note("gate403", humanOk ? "PASS" : "FAIL", { http: human.status, error: humanBody?.error ?? null, hasChallenge: Boolean(humanBody?.challenge) });

  const agent = await fetch(base + "/demo/contact", { method: "POST", headers: { ...headers, "toll-client": "agent" }, body: "{}", signal: AbortSignal.timeout(20000) });
  const agentText = await readBody(agent);
  let agentBody;
  try { agentBody = JSON.parse(agentText); } catch { agentBody = null; }
  const offers = Array.isArray(agentBody?.offers) ? agentBody.offers : [];
  const cashu = offers.find((offer) => offer && offer.kind === "cashu");
  const headerScheme = schemeOf(agent.headers.get("x-cashu") || "");
  const auth = agent.headers.get("www-authenticate");
  const agentOk = on
    ? agent.status === 402 && agentBody && agentBody.error === "payment_required" && headerScheme === "creqA" && cashu && Number.isSafeInteger(cashu.amount) && typeof cashu.mint === "string" && agentBody.pass === undefined
    : agent.status === 403 && agentBody && agentBody.error === "toll_required" && Boolean(agentBody.challenge) && agent.headers.get("x-cashu") === null && auth === null && offers.length === 0 && agentBody.pass === undefined;
  note("gate402", agentOk ? "PASS" : "FAIL", { expect, http: agent.status, error: agentBody?.error ?? null, xCashu: headerScheme, offerKind: cashu?.kind ?? null, offerAmount: cashu?.amount ?? null, offerMint: cashu?.mint ?? null });

  // L402: free. The challenge is read, never paid.
  const challenge = l402Challenge(auth);
  const quoteOffer = offers.find((offer) => offer && offer.kind === "l402");
  const priceMsat = Number.isSafeInteger(price?.amount_msat) ? price.amount_msat : null;
  const l402Ok = on && l402
    ? challenge.scheme === "L402" && challenge.macaroon === true && priceMsat !== null && challenge.amount_msat === priceMsat && (!quoteOffer || quoteOffer.amount_msat === priceMsat)
    : auth === null && !quoteOffer;
  note("l402", l402Ok ? "PASS" : "FAIL", { expect, l402: on && l402 ? "on" : "off", scheme: challenge.scheme, invoiceMsat: challenge.amount_msat, priceMsat, offerMsat: quoteOffer?.amount_msat ?? null });

  const statsRes = await fetch(base + "/demo/stats", { signal: AbortSignal.timeout(20000) });
  const statsText = await readBody(statsRes);
  let stats;
  try { stats = JSON.parse(statsText); } catch { stats = null; }
  const keys = stats && typeof stats === "object" ? Object.keys(stats).sort() : [];
  const want = ["accepted", "rejected", "reversals", "reversed_sats"];
  const statsOk = statsRes.status === 200 && JSON.stringify(keys) === JSON.stringify(want) && want.every((key) => Number.isSafeInteger(stats[key]) && stats[key] >= 0);
  note("stats", statsOk ? "PASS" : "FAIL", { http: statsRes.status, keys, accepted: stats?.accepted ?? null, rejected: stats?.rejected ?? null, reversals: stats?.reversals ?? null, reversed_sats: stats?.reversed_sats ?? null });
}

async function spendChecks({ base, cap, out, src, proofs, walletModule, steps, note, line }) {
  if (!proofs || !walletModule) {
    console.error("spend mode needs --proofs and --wallet (or TOLL_PROOFS and TOLL_WALLET)");
    process.exit(64);
  }
  process.umask(0o077);
  const walletDir = path.dirname(path.resolve(walletModule));
  process.chdir(walletDir);
  const mod = await import(pathToFileURL(path.resolve(walletModule)).href);
  const norm = mod.norm;
  const MINT = mod.MINT;
  if (typeof mod.wallet !== "function" || typeof norm !== "function" || typeof MINT !== "string") {
    console.error("wallet module must export wallet(), norm, and MINT");
    process.exit(64);
  }
  let cashuTs;
  try {
    cashuTs = await import(pathToFileURL(path.join(walletDir, "node_modules/@cashu/cashu-ts/lib/cashu-ts.es.js")).href);
  } catch {
    cashuTs = await import("@cashu/cashu-ts");
  }
  const { getDecodedToken } = cashuTs;
  const toll = path.join(src, "packages");
  const { createAgent } = await import(pathToFileURL(path.join(toll, "agent/src/index.ts")).href);
  const { cashuPayer } = await import(pathToFileURL(path.join(toll, "agent/src/cashu-payer.ts")).href);
  const cashu = await import(pathToFileURL(path.join(toll, "settlement-ln/src/cashu.ts")).href);
  const { decodePaymentRequest, encodeTokenV4, encodeTokenV3 } = cashu;

  const proofsPath = path.resolve(proofs);
  const readProofFile = () => {
    const data = JSON.parse(readFileSync(proofsPath, "utf8"));
    const list = Array.isArray(data) ? data : data.proofs;
    if (!Array.isArray(list)) throw new Error("proofs file has no proof list");
    return { data, list: list.map(norm) };
  };
  const loadProofs = () => readProofFile().list;
  const saveProofs = (items) => {
    const { data } = readProofFile();
    const body = Array.isArray(data) ? items : { ...data, proofs: items };
    writeFileSync(proofsPath, JSON.stringify(body), { mode: 0o600 });
  };
  const statePath = path.join(out, ".state.json");
  const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const save = () => writeFileSync(statePath, JSON.stringify(st), { mode: 0o600 });
  const log = (file, obj) => appendFileSync(path.join(out, file), redact(obj) + "\n");
  const w = await mod.wallet();
  const ids = w.keyChain.getAllKeysetIds();
  const states = async (ps) => (await w.checkProofsStates(ps)).map((row) => row.state);
  const decode = (token) => getDecodedToken(token, ids).proofs.map(norm);
  const encA = (ps) => "cashuA" + Buffer.from(JSON.stringify({ token: [{ mint: MINT, proofs: ps.map((p) => ({ id: p.id, amount: p.amount, secret: p.secret, C: p.C })) }], unit: "sat" })).toString("base64url");
  const postHeaders = { "toll-client": "agent", accept: "application/json", "content-type": "application/x-www-form-urlencoded", "toll-test": "1" };
  const pathW = "/demo/contact";
  async function post(extra = {}) {
    const response = await fetch(base + pathW, { method: "POST", headers: { ...postHeaders, ...extra }, body: "message=toll-live-check", signal: AbortSignal.timeout(30000) });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { rawLength: text.length }; }
    return { status: response.status, xcashu: response.headers.get("x-cashu"), json };
  }
  async function split(amount) {
    const sent = await w.send(amount, loadProofs(), { includeFees: false });
    saveProofs([...sent.keep.map(norm), ...sent.send.map(norm)]);
    return sent.send.map(norm);
  }
  async function unspent() {
    const ps = loadProofs();
    const s = await states(ps);
    return ps.reduce((sum, proof, i) => sum + (s[i] === "UNSPENT" ? proof.amount : 0), 0);
  }
  const fivexx = [];
  const note5 = (where, status) => { if (status >= 500) fivexx.push({ where, http: status }); };
  st.walletStart ??= await unspent();
  save();
  const spent = async () => st.walletStart - await unspent();
  const capOk = async (n) => (await spent()) + n <= cap;
  log("wallet.log", { step: "start", base, cap, walletStartUnspent: st.walletStart });

  if (steps.includes("a")) {
    const response = await post();
    note5("a", response.status);
    const creq = response.xcashu || "";
    let pr = null;
    try { pr = decodePaymentRequest(creq); } catch { /* refusal is a failed check */ }
    const pass = response.status === 402 && schemeOf(creq) === "creqA" && pr?.m?.length === 1 && pr.m[0] === MINT && pr.u === "sat" && pr.a === 10 && response.json.offers?.[0]?.mint === MINT;
    note("a", pass ? "PASS" : "FAIL", { http: response.status, xCashu: schemeOf(creq), amount: pr?.a ?? null, unit: pr?.u ?? null, mint: pr?.m?.[0] ?? null });
    log("a-creqA.log", { check: "a", http: response.status, xCashu: schemeOf(creq), amount: pr?.a ?? null, result: pass ? "PASS" : "FAIL" });
  }
  if (steps.includes("b")) {
    if (!(await capOk(10))) {
      note("b", "FAIL", { reason: "cap would be exceeded" });
      log("b-cashuB-pay.log", { check: "b", result: "cap" });
    } else {
      const source = await split(12);
      st.s12 = source.map((proof) => proof.amount);
      save();
      const offerRes = await post();
      note5("b-402", offerRes.status);
      const offer = offerRes.json.offers?.[0];
      let change = null;
      const payB = await cashuPayer({ token: encA(source) }, { onChange: (token) => { change = token; } })(offer);
      const payP = decode(payB);
      const chP = change ? decode(change) : [];
      saveProofs([...loadProofs(), ...payP, ...chP].filter((proof, index, list) => list.findIndex((other) => other.secret === proof.secret) === index));
      const drop = new Set(source.map((proof) => proof.secret));
      saveProofs(loadProofs().filter((proof) => !drop.has(proof.secret)));
      st.payB = payB;
      save();
      const response = await post({ "x-cashu": payB });
      note5("b", response.status);
      let used = null;
      if (response.json.pass) {
        const use = await post({ authorization: "Toll " + response.json.pass });
        note5("b-use", use.status);
        used = use.status;
      }
      const inputStates = await states(payP);
      if (inputStates.every((state) => state === "SPENT")) saveProofs(loadProofs().filter((proof) => !payP.some((paid) => paid.secret === proof.secret)));
      const changeStates = chP.length ? await states(chP) : [];
      const changeBooked = chP.length > 0 && changeStates.every((state) => state === "UNSPENT") && loadProofs().some((proof) => chP.some((changeProof) => changeProof.secret === proof.secret));
      const pass = response.status === 200 && typeof response.json.pass === "string" && used === 200 && inputStates.every((state) => state === "SPENT") && schemeOf(change) === "cashuB" && changeBooked;
      note("b", pass ? "PASS" : "FAIL", { http: response.status, useHttp: used, inputStates, changeScheme: schemeOf(change), changeBooked });
      log("b-cashuB-pay.log", { check: "b", http: response.status, useHttp: used, payment: schemeOf(payB), change: schemeOf(change), inputStates, changeBooked, result: pass ? "PASS" : "FAIL" });
    }
  }
  if (steps.includes("c")) {
    if (!st.payB) note("c", "FAIL", { reason: "check b did not leave a payment" });
    else {
      const replay = await post({ "x-cashu": st.payB });
      note5("c-xcashu", replay.status);
      const fresh = await post();
      const offer = fresh.json.offers?.[0];
      const redeem = await fetch(base + "/v1/redeem", {
        method: "POST",
        headers: { "content-type": "application/json", "toll-client": "agent" },
        body: JSON.stringify({ offer_id: offer?.id, kind: "cashu", token: st.payB, credential: offer?.credential }),
        signal: AbortSignal.timeout(30000),
      });
      const redeemText = await redeem.text();
      let redeemBody;
      try { redeemBody = JSON.parse(redeemText); } catch { redeemBody = {}; }
      note5("c-redeem", redeem.status);
      const pass = replay.status >= 400 && replay.status < 500 && !replay.json.pass && redeem.status >= 400 && redeem.status < 500 && !redeemBody.pass;
      note("c", pass ? "PASS" : "FAIL", { xcashuHttp: replay.status, redeemHttp: redeem.status });
      log("c-replay.log", { check: "c", xcashuHttp: replay.status, redeemHttp: redeem.status, result: pass ? "PASS" : "FAIL" });
    }
  }
  if (steps.includes("e")) {
    const fake = { amount: 8, secret: "toll-live-unlisted-" + Date.now(), id: Buffer.from("00ad268c4d1f5826", "hex"), C: Buffer.from("02" + "11".repeat(32), "hex") };
    const outRows = [];
    for (const mint of ["https://testnut.cashu.space", "https://mint.minibits.cash/Other", "http://mint.minibits.cash/Bitcoin"]) {
      for (const [format, enc] of [["cashuB", encodeTokenV4], ["cashuA", encodeTokenV3]]) {
        const token = enc({ mint, unit: "sat", proofs: [fake, { ...fake, amount: 2, secret: fake.secret + "b" }] });
        const response = await post({ "x-cashu": token });
        note5("e", response.status);
        outRows.push({ mint, format, http: response.status, pass: Boolean(response.json.pass) });
      }
    }
    const control = [];
    for (const [format, enc] of [["cashuB", encodeTokenV4], ["cashuA", encodeTokenV3]]) {
      const token = enc({ mint: MINT, unit: "sat", proofs: [{ ...fake, secret: fake.secret + "c" + format }, { ...fake, amount: 2, secret: fake.secret + "d" + format }] });
      const response = await post({ "x-cashu": token });
      note5("e-control", response.status);
      control.push({ format, http: response.status, pass: Boolean(response.json.pass) });
    }
    const pass = outRows.every((row) => row.http >= 400 && row.http < 500 && !row.pass) && control.every((row) => row.http >= 400 && row.http < 500 && !row.pass);
    note("e", pass ? "PASS" : "FAIL", { unlisted: outRows, control });
    log("e-unlisted.log", { check: "e", unlisted: outRows, control, result: pass ? "PASS" : "FAIL" });
  }
  if (steps.includes("f")) {
    if (!(await capOk(10))) note("f", "FAIL", { reason: "cap would be exceeded" });
    else {
      const source = await split(10);
      const before = await states(source);
      const tokA = encA(source);
      let clientChange = null;
      const agent = createAgent({ base, pay: cashuPayer({ token: tokA }, { onChange: (token) => { clientChange = token; } }), work: false });
      const res = await agent.fetch(pathW, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "message=toll-live-cashuA" });
      note5("f", res.response.status);
      await res.response.text();
      const inputStates = await states(source);
      if (inputStates.every((state) => state === "SPENT")) saveProofs(loadProofs().filter((proof) => !source.some((item) => item.secret === proof.secret)));
      const pass = res.via === "paid" && res.response.status === 200 && res.token === tokA && inputStates.every((state) => state === "SPENT");
      note("f", pass ? "PASS" : "FAIL", { via: res.via, http: res.response.status, sentScheme: schemeOf(res.token), inputStates, change: schemeOf(clientChange) });
      log("f-cashuA-pay.log", { check: "f", via: res.via, http: res.response.status, inputsBefore: before, inputStates, change: schemeOf(clientChange), result: pass ? "PASS" : "FAIL" });
    }
  }
  if (steps.includes("d")) {
    const paid = ["b", "f"].filter((key) => steps.includes(key));
    const paidOk = paid.length > 0 && paid.every((key) => {
      try { return JSON.parse(readFileSync(path.join(out, `${key}.json`), "utf8")).status === "PASS"; } catch { return false; }
    });
    note("d", paidOk ? "PASS_INDIRECT" : "FAIL", { method: "a pass is granted only after commit and a durable read-back", paid });
    log("d-store.log", { check: "d", paidOk, result: paidOk ? "PASS_INDIRECT" : "FAIL" });
  }
  const walletEnd = await unspent();
  const sp = st.walletStart - walletEnd;
  line(`sats spent ${sp}/${cap}, 5xx ${fivexx.length}`);
  log("results.log", { cap, fivexx, walletStart: st.walletStart, walletEnd, satsSpent: sp });
  if (sp > cap || fivexx.length > 0) {
    note("cap", "FAIL", { satsSpent: sp, cap, fivexx: fivexx.length });
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "live checks failed");
    process.exit(1);
  });
}
