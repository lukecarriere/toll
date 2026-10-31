// The payment-server address is emptied before WordPress's esc_url_raw can rewrite a
// schemeless string. Core on this site must do that rewrite, and toll_gate_clean_server_url
// must still return empty. Needs the local site from packages/wp-toll-gate/dev/setup-local-wp.sh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const WP = (process.env.WP_URL ?? "http://127.0.0.1:8888").replace(/\/$/, "");
const WPCLI = process.env.WP_CLI ?? "/workspace/wp-local/wp-cli.phar";
const WPPATH = process.env.WP_PATH ?? "/workspace/wp-local/site";

async function up(url: string) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    await r.arrayBuffer();
    return r.ok;
  } catch {
    return false;
  }
}
const skip = (await up(WP + "/wp-json/toll/v1/health")) && existsSync(WPCLI) ? false : `local WordPress not running at ${WP}`;

test("core esc_url_raw rewrites a schemeless string; the settings URL stays empty", { skip }, () => {
  const out = execFileSync("php", [WPCLI, "--path=" + WPPATH, "eval", `
    $cases = ["not a url", "pay.example.com", "https://pay.example.com/owner%2Fapi"];
    $rows = [];
    foreach ($cases as $s) {
      $rows[] = [esc_url_raw($s, ["http", "https"]), toll_gate_clean_server_url($s)];
    }
    echo wp_json_encode($rows);
  `], { encoding: "utf8" }).trim();
  assert.deepEqual(JSON.parse(out), [
    ["http://not%20a%20url", ""],
    ["http://pay.example.com", ""],
    ["https://pay.example.com/owner%2Fapi", "https://pay.example.com/owner%2Fapi"],
  ]);
});
