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
// Agents wait at most this long for offers before they get the work check instead.
const TOLL_GATE_OFFER_TIMEOUT_S = 1.5;
// After the payment server fails to answer, agents skip it (work check only) for this long.
const TOLL_GATE_DOWN_CACHE_S = 30;

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
function toll_gate_server_call(string $method, string $path, ?array $json = null, float $timeout = TOLL_GATE_SERVER_TIMEOUT_S): ?array
{
    $base = untrailingslashit((string) toll_gate_settings()['server_url']);
    if (!preg_match('#^https?://#i', $base)) return null;
    $args = [
        'method' => $method,
        'timeout' => $timeout,
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

/** Payment server chosen and an address set: paid redeems are forwarded there. */
function toll_gate_server_configured(?array $s = null): bool
{
    $s ??= toll_gate_settings();
    return $s['connection'] === 'server' && trim((string) $s['server_url']) !== '';
}

/**
 * Agents are offered to pay only when the owner ticked "Collect usage payouts", chose Payment
 * server and set its address. Test mode has no payment server, so agents get the work check.
 */
function toll_gate_offers_configured(?array $s = null): bool
{
    $s ??= toll_gate_settings();
    return (bool) $s['payouts'] && toll_gate_server_configured($s);
}

/** Forget a recorded outage (settings saved). */
function toll_gate_server_down_reset(): void
{
    delete_transient('toll_gate_server_down');
}

/**
 * Offers for an agent request, minted by the owner's payment server (POST /v1/owner/offers).
 * Returns ['offers' => list, 'www_authenticate' => header value] to relay as they are, or null:
 * not configured, no offers, or the server is down, slow or answers wrongly. On a failure, agents
 * skip the server for TOLL_GATE_DOWN_CACHE_S. This site never builds or reads an offer itself.
 */
function toll_gate_relay_offers(string $action): ?array
{
    if (!toll_gate_offers_configured() || get_transient('toll_gate_server_down')) return null;
    $r = toll_gate_server_call('POST', '/v1/owner/offers', ['action' => $action], TOLL_GATE_OFFER_TIMEOUT_S);
    if ($r === null || $r['status'] !== 200) {
        set_transient('toll_gate_server_down', 1, TOLL_GATE_DOWN_CACHE_S);
        return null;
    }
    $offers = is_array($r['body']['offers'] ?? null) ? array_values(array_filter($r['body']['offers'], 'toll_gate_offer_shape_ok')) : [];
    $www = $r['body']['www_authenticate'] ?? null;
    // One header line of printable ASCII, so nothing can be smuggled into the response headers.
    if ($offers === [] || !is_string($www) || !preg_match('/^[\x20-\x7e]{1,4096}$/', $www)) return null;
    return ['offers' => array_slice($offers, 0, 4), 'www_authenticate' => $www];
}

/** Shape check before relaying (types and sizes only; the payment server checks the payment). */
function toll_gate_offer_shape_ok(mixed $o): bool
{
    if (!is_array($o)) return false;
    foreach (['id', 'kind', 'invoice', 'macaroon'] as $k) {
        if (!is_string($o[$k] ?? null) || $o[$k] === '' || strlen($o[$k]) > 4096) return false;
    }
    return is_int($o['amount_msat'] ?? null) && $o['amount_msat'] > 0 && is_int($o['exp'] ?? null)
        && (!isset($o['display']) || is_array($o['display']));
}

/**
 * Forward a paid redeem to the payment server (POST /v1/owner/redeem), which checks the payment
 * proof, books it, and refuses a second use. Returns [status, body]. Never a 500: a server that
 * doesn't answer is 503.
 */
function toll_gate_relay_redeem(array $b): array
{
    if (!toll_gate_server_configured()) return [400, ['error' => 'unsupported', 'detail' => 'paid redeem is not enabled on this issuer']];
    $fwd = [];
    foreach (['offer_id', 'kind', 'preimage', 'macaroon'] as $k) {
        if (!is_string($b[$k] ?? null) || $b[$k] === '' || strlen($b[$k]) > 4096) return [400, ['error' => 'malformed']];
        $fwd[$k] = $b[$k];
    }
    $r = toll_gate_server_call('POST', '/v1/owner/redeem', $fwd);
    if ($r === null || $r['status'] === 503) return [503, ['error' => 'unavailable']];
    $body = $r['body'];
    if ($r['status'] === 200) {
        $cls = $body['cls'] ?? null;
        if (!empty($body['ok']) && is_string($cls) && $cls !== 'read' && isset(\Toll\Protocol::CLASS_MULT[$cls])) return [200, ['cls' => $cls]];
        return [503, ['error' => 'unavailable']];
    }
    $err = is_string($body['error'] ?? null) && preg_match('/^[a-z_]{1,32}$/', $body['error']) ? $body['error'] : 'malformed';
    // The site's own key was refused: the site is misconfigured, not the agent's payment.
    if ($r['status'] === 401 && $err === 'unauthorized') return [503, ['error' => 'unavailable']];
    return [in_array($r['status'], [400, 401, 402, 404, 409, 410], true) ? $r['status'] : 400, ['error' => $err]];
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

/**
 * Withdraw through the owner's payment server only (POST /v1/owner/withdraw). The invoice is passed
 * on as an opaque string: this plugin never reads an invoice (Amendment 1 §F); the payment server
 * checks it and its amount against the balance before anything is sent.
 * Returns ['ok' => true, 'usd' => '$X.XX'] or ['ok' => false, 'error' => 'too_much' | 'failed' | 'down'].
 */
function toll_gate_withdraw(string $invoice): array
{
    $s = toll_gate_settings();
    $invoice = trim($invoice);
    if (!$s['payouts'] || $invoice === '' || $s['connection'] !== 'server') return ['ok' => false, 'error' => 'failed'];
    if (trim((string) $s['server_url']) === '') return ['ok' => false, 'error' => 'down'];
    $r = toll_gate_server_call('POST', '/v1/owner/withdraw', ['invoice' => $invoice]);
    if ($r === null || $r['status'] === 503) return ['ok' => false, 'error' => 'down'];
    if ($r['status'] === 200 && !empty($r['body']['ok'])) return ['ok' => true, 'usd' => (string) ($r['body']['amount_usd'] ?? '')];
    return ['ok' => false, 'error' => ($r['body']['error'] ?? '') === 'too_much' ? 'too_much' : 'failed'];
}
