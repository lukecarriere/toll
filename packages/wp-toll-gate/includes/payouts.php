<?php
// Usage payouts (option A, docs/copy.md): WordPress takes no payments itself. Test mode keeps a
// local test ledger with no money in it; Payment server reads the balance from, and sends
// withdrawals to, a Toll issuer the owner runs (owner API: GET /v1/owner/balance,
// POST /v1/owner/withdraw, docs/settlement.md §9). Nothing here runs unless the owner ticks
// "Collect usage payouts", and no request leaves this site in test mode.
declare(strict_types=1);

if (!defined('ABSPATH')) exit;

use Toll\Settlement;

const TOLL_GATE_TEST_FEE_BPS = 1000;
// Fixed test rate for test mode only, not a market price (same as demo/toll.yaml).
const TOLL_GATE_TEST_USD_RATE = 100000.0;
const TOLL_GATE_SERVER_TIMEOUT_S = 3;

/**
 * Current payouts view for the settings page.
 * state: 'off' | 'test' | 'noaddr' | 'down' | 'ok'
 * usd: available balance string or null (hide the amount); fee_bps; paused (payments paused).
 */
function toll_gate_payouts_view(?array $s = null): array
{
    $s ??= toll_gate_settings();
    $base = ['state' => 'off', 'usd' => null, 'fee_bps' => TOLL_GATE_TEST_FEE_BPS, 'paused' => false, 'available_msat' => null];
    if (!$s['payouts']) return $base;
    if ($s['connection'] !== 'server') {
        $l = toll_gate_test_ledger();
        $now = time();
        return ['state' => 'test', 'usd' => Settlement::usdDisplay($l['available_msat'], TOLL_GATE_TEST_USD_RATE, $now, $now), 'fee_bps' => TOLL_GATE_TEST_FEE_BPS, 'paused' => false, 'available_msat' => $l['available_msat']];
    }
    if (trim((string) $s['server_url']) === '') return ['state' => 'noaddr'] + $base;
    $r = toll_gate_server_call('GET', '/v1/owner/balance');
    if ($r === null || $r['status'] !== 200) return ['state' => 'down'] + $base;
    $b = $r['body'];
    $fee = is_int($b['fee_bps'] ?? null) && $b['fee_bps'] >= 0 && $b['fee_bps'] <= 10000 ? $b['fee_bps'] : TOLL_GATE_TEST_FEE_BPS;
    return [
        'state' => 'ok',
        'usd' => is_string($b['available_usd'] ?? null) ? $b['available_usd'] : null,
        'fee_bps' => $fee,
        'paused' => !empty($b['degraded']),
        'available_msat' => is_int($b['available_msat'] ?? null) ? $b['available_msat'] : null,
    ];
}

/** One call to the owner's payment server. Returns [status, body] or null when it doesn't answer. */
function toll_gate_server_call(string $method, string $path, ?array $json = null): ?array
{
    $base = untrailingslashit((string) toll_gate_settings()['server_url']);
    if (!preg_match('#^https?://#i', $base)) return null;
    $args = [
        'method' => $method,
        'timeout' => TOLL_GATE_SERVER_TIMEOUT_S,
        'redirection' => 0,
        'headers' => ['Authorization' => 'Bearer ' . toll_gate_server_key(), 'Accept' => 'application/json'],
    ];
    if ($json !== null) {
        $args['headers']['Content-Type'] = 'application/json';
        $args['body'] = wp_json_encode($json);
    }
    $r = wp_remote_request($base . $path, $args);
    if (is_wp_error($r)) return null;
    $code = (int) wp_remote_retrieve_response_code($r);
    $body = json_decode((string) wp_remote_retrieve_body($r), true);
    if ($code >= 500 && $code !== 503) return null;
    return ['status' => $code, 'body' => is_array($body) ? $body : []];
}

/** Test-mode ledger: integer msat, starts empty. Only test payments could ever credit it. */
function toll_gate_test_ledger(): array
{
    $l = get_option('toll_gate_test_ledger', []);
    $l = is_array($l) ? $l : [];
    $net = (int) ($l['net_msat'] ?? 0);
    $out = (int) ($l['withdrawn_msat'] ?? 0);
    return ['net_msat' => $net, 'withdrawn_msat' => $out, 'available_msat' => $net - $out];
}

/** Amount of a test-mode payout invoice (the local test format only), or null if it isn't one. */
function toll_gate_test_invoice_msat(string $invoice): ?int
{
    if (!preg_match('/^lnstub1([1-9]\d{0,15})m1[0-9a-f]{64}[0-9a-f]{16}$/', $invoice, $m)) return null;
    return (int) $m[1];
}

/**
 * Withdraw. Returns ['ok' => true, 'usd' => '$X.XX'] or ['ok' => false, 'error' => 'too_much' | 'failed' | 'down'].
 * The amount is checked against the balance before anything is sent.
 */
function toll_gate_withdraw(string $invoice): array
{
    $s = toll_gate_settings();
    $invoice = trim($invoice);
    if (!$s['payouts'] || $invoice === '') return ['ok' => false, 'error' => 'failed'];
    if ($s['connection'] !== 'server') {
        $amount = toll_gate_test_invoice_msat($invoice);
        if ($amount === null) return ['ok' => false, 'error' => 'failed'];
        $l = toll_gate_test_ledger();
        if ($amount > $l['available_msat']) return ['ok' => false, 'error' => 'too_much'];
        update_option('toll_gate_test_ledger', ['net_msat' => $l['net_msat'], 'withdrawn_msat' => $l['withdrawn_msat'] + $amount], false);
        $now = time();
        return ['ok' => true, 'usd' => (string) Settlement::usdDisplay($amount, TOLL_GATE_TEST_USD_RATE, $now, $now)];
    }
    if (trim((string) $s['server_url']) === '') return ['ok' => false, 'error' => 'down'];
    $r = toll_gate_server_call('POST', '/v1/owner/withdraw', ['invoice' => $invoice]);
    if ($r === null || $r['status'] === 503) return ['ok' => false, 'error' => 'down'];
    if ($r['status'] === 200 && !empty($r['body']['ok'])) return ['ok' => true, 'usd' => (string) ($r['body']['amount_usd'] ?? '')];
    return ['ok' => false, 'error' => ($r['body']['error'] ?? '') === 'too_much' ? 'too_much' : 'failed'];
}
