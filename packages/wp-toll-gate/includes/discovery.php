<?php
// Agent discovery (Amendment 3): /.well-known/toll.json, the /.well-known/agents.json pointer and
// GET /wp-json/toll/v1/price. Same document as the Node issuer (packages/server-node/src/manifest.ts;
// tests/discovery.test.ts compares them). Copy is docs/copy.md "Amendment 3", verbatim. Prices are
// never hard-coded: amounts and the rate come from the owner's payment server, and the USD is
// derived here with Settlement::offerUsd, the same function and round-up as the 402 offer. Without
// a payment server (Test mode, payouts off, server down) the site makes no paid offer: prices are
// null with status "stub". Free: no pass, no challenge, no payment.
declare(strict_types=1);

if (!defined('ABSPATH')) exit;

use Toll\Settlement;

const TOLL_GATE_MANIFEST_DESCRIPTION = 'Invisible check for writes. A person does not notice. A program that fires thousands of writes pays for each one, or stops. Public pages stay free.';
const TOLL_GATE_NOT_FOR = ['page views', 'crawler blocking', 'citation licensing'];
const TOLL_GATE_PAID_CLASSES = ['write', 'search', 'account', 'admin'];
const TOLL_GATE_TOOLS = [
    'price_write_action' => 'Returns the current USD price, and the work alternative, for one write on a Toll-protected site: a comment, signup, login, form post, or state-changing API call. Use it before a write to choose between paying and doing the work. Not for page views, which are free and need no call. Does not identify the caller.',
    'gate_form_write' => 'Gets a one-use pass for one write on a Toll-protected site. With no payment it returns the payment offer and a work challenge. With proof of payment it returns the pass. Use only for writes. Does not block public reads, does not detect who the caller is, and does not license or price content.',
    'verify_write_pass' => "For the site's own server: checks that a pass sent with a write is valid, unused, and for this site and action. Returns valid or invalid with a reason. Does not score the caller or say whether it is a person or a program.",
];
// Price amounts and rate from the payment server are reused for this long.
const TOLL_GATE_PRICE_CACHE_S = 30;

/** JSON Schemas for the tool inputs (same as manifest.ts INPUT_SCHEMAS). */
function toll_gate_input_schemas(): array
{
    $site = ['type' => 'string', 'description' => 'Origin of the Toll-protected site, e.g. https://example.com'];
    $action = ['type' => 'string', 'enum' => TOLL_GATE_PAID_CLASSES, 'default' => 'write'];
    return [
        'price_write_action' => ['type' => 'object', 'properties' => ['site' => $site, 'action' => $action], 'required' => ['site'], 'additionalProperties' => false],
        'gate_form_write' => [
            'type' => 'object',
            'properties' => [
                'site' => $site,
                'action' => $action,
                'path' => ['type' => 'string', 'default' => '/'],
                'payment' => [
                    'type' => 'object',
                    'properties' => ['offer_id' => ['type' => 'string'], 'kind' => ['type' => 'string'], 'preimage' => ['type' => 'string'], 'macaroon' => ['type' => 'string']],
                    'required' => ['offer_id', 'kind', 'preimage', 'macaroon'],
                    'additionalProperties' => false,
                ],
            ],
            'required' => ['site'],
            'additionalProperties' => false,
        ],
        'verify_write_pass' => [
            'type' => 'object',
            'properties' => ['site' => $site, 'secret' => ['type' => 'string'], 'pass' => ['type' => 'string'], 'action' => $action],
            'required' => ['site', 'secret', 'pass'],
            'additionalProperties' => false,
        ],
    ];
}

/** "$0.0100 (test)"; null when there is no USD to show. */
function toll_gate_price(?int $msat, ?string $usd, string $status): array
{
    return ['amount_msat' => $msat, 'usd' => $usd, 'status' => $status, 'display' => $usd !== null ? '$' . $usd . ' (' . $status . ')' : null];
}

function toll_gate_payment(string $status, bool $paid): array
{
    return $paid
        ? ['status' => 'stub', 'protocol' => 'HTTP 402', 'methods' => [['kind' => 'ln402', 'status' => $status]], 'x402' => ['status' => 'stub']]
        : ['status' => 'stub', 'protocol' => 'none', 'methods' => [], 'x402' => ['status' => 'stub']];
}

/**
 * Price table from the payment server: ['status' => 'test'|'stub', 'prices' => [cls => [amount_msat, usd]] | null].
 * Only when the site makes paid offers (payouts on, Payment server, address set, server up).
 */
function toll_gate_price_table(): array
{
    $none = ['status' => 'stub', 'prices' => null];
    if (!toll_gate_lib_ok() || !toll_gate_offers_configured() || get_transient('toll_gate_server_down')) return $none;
    $r = get_transient('toll_gate_price_cache');
    if (!is_array($r)) {
        $res = toll_gate_server_call('GET', '/v1/owner/price', null, TOLL_GATE_OFFER_TIMEOUT_S);
        if ($res === null || $res['status'] !== 200) return $none;
        $r = $res['body'];
        set_transient('toll_gate_price_cache', $r, TOLL_GATE_PRICE_CACHE_S);
    }
    if (($r['status'] ?? null) !== 'test' || !is_array($r['prices'] ?? null)) return $none;
    $fx = is_array($r['fx'] ?? null) ? $r['fx'] : [];
    $rate = is_int($fx['usd_per_btc'] ?? null) || is_float($fx['usd_per_btc'] ?? null) ? (float) $fx['usd_per_btc'] : null;
    $at = is_int($fx['fetched_at'] ?? null) ? $fx['fetched_at'] : null;
    $out = [];
    foreach (TOLL_GATE_PAID_CLASSES as $c) {
        $m = $r['prices'][$c]['amount_msat'] ?? null;
        if (!is_int($m) || $m <= 0) return $none;
        $out[$c] = ['amount_msat' => $m, 'usd' => Settlement::offerUsd($m, $rate, $at, time())];
    }
    return ['status' => 'test', 'prices' => $out];
}

function toll_gate_api_base(): string
{
    return untrailingslashit(rest_url('toll/v1'));
}

function toll_gate_manifest(): array
{
    $t = toll_gate_price_table();
    $status = $t['status'];
    $api = toll_gate_api_base();
    $by = [];
    foreach (TOLL_GATE_PAID_CLASSES as $c) {
        $p = $t['prices'][$c] ?? null;
        $by[$c] = $p ? toll_gate_price($p['amount_msat'], $p['usd'], $status) : toll_gate_price(null, null, 'stub');
    }
    $free = toll_gate_price(0, '0.0000', $status);
    $schemas = toll_gate_input_schemas();
    $tool = fn(string $n, string $endpoint, array $price, bool $paid) => ['name' => $n, 'description' => TOLL_GATE_TOOLS[$n], 'input_schema' => $schemas[$n], 'endpoint' => $endpoint, 'price' => $price, 'payment' => toll_gate_payment($status, $paid)];
    return [
        'name' => 'Toll',
        'description' => TOLL_GATE_MANIFEST_DESCRIPTION,
        'docs' => null,
        'api' => $api,
        'reads_free' => true,
        'not_for' => TOLL_GATE_NOT_FOR,
        'tools' => [
            $tool('price_write_action', $api . '/price?action={action}', $free, false),
            $tool('gate_form_write', $api . '/challenge?action={action}&path={path}&client=agent', $by['write'] + ['by_action' => $by], $t['prices'] !== null),
            $tool('verify_write_pass', $api . '/siteverify', $free, false),
        ],
    ];
}

/** GET /wp-json/toll/v1/price?action= : the price of one paid request plus the free work alternative. */
function toll_gate_rest_price(WP_REST_Request $req): WP_REST_Response
{
    $action = (string) ($req->get_param('action') ?? 'write');
    if (!in_array($action, TOLL_GATE_PAID_CLASSES, true)) return toll_gate_json(['error' => 'bad_action'], 400);
    $t = toll_gate_price_table();
    $p = $t['prices'][$action] ?? null;
    $price = $p ? toll_gate_price($p['amount_msat'], $p['usd'], $t['status']) : toll_gate_price(null, null, 'stub');
    return toll_gate_json(['action' => $action] + $price + ['work' => ['challenge_url' => toll_gate_challenge_url($action, (string) ($req->get_param('path') ?? '/'))], 'reads_free' => true]);
}

/** Serve the two discovery documents before WordPress routes the request (any visitor, no check). */
function toll_gate_discovery_serve(): void
{
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method !== 'GET' && $method !== 'HEAD') return;
    $path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    $home = rtrim((string) parse_url(home_url('/'), PHP_URL_PATH), '/');
    if ($path === $home . '/.well-known/agents.json') {
        toll_gate_count('agents_json_fetch');
        $body = ['manifest' => home_url('/.well-known/toll.json')];
    } elseif ($path === $home . '/.well-known/toll.json') {
        toll_gate_count('manifest_fetch');
        $body = toll_gate_manifest();
    } else {
        return;
    }
    status_header(200);
    header('Content-Type: application/json; charset=utf-8');
    header('Access-Control-Allow-Origin: *');
    header('Cache-Control: public, max-age=60');
    if ($method === 'GET') echo wp_json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}
