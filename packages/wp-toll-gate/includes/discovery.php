<?php
// Agent discovery (Amendment 3): /.well-known/toll.json, the /.well-known/agents.json pointer and
// GET /wp-json/toll/v1/price. Same document as the Node issuer (packages/server-node/src/manifest.ts;
// tests/discovery.test.ts compares them), except that WordPress lists no search class (see
// TOLL_GATE_PAID_CLASSES). Copy is docs/copy.md "Amendment 3", verbatim. Prices are never
// hard-coded: amounts and the rate come from the owner's payment server, and the USD is derived
// here with Settlement::offerUsd, the same function and round-up as the 402 offer. Without a
// payment server (Test mode, payouts off, server down) the site makes no paid offer: prices are
// null with status "stub". Free: no pass, no challenge, no payment.
declare(strict_types=1);

if (!defined('ABSPATH')) exit;

use Toll\Settlement;

const TOLL_GATE_MANIFEST_DESCRIPTION = 'A small check for writes. Heavy clients do work on each write, or pay in test mode. Page views stay free. Does not identify the caller.';
const TOLL_GATE_NOT_FOR = ['page views', 'crawler blocking', 'citation licensing'];
// No search: on WordPress search is a page load (/?s=) and stays a free read (Amendment 2 / M10), so
// the manifest, its tool schemas and /price list no search price or action (docs/copy.md, PM Oct 1).
// Node and the edge check a search sent as a form post and keep it (packages/server-node manifest.ts).
const TOLL_GATE_PAID_CLASSES = ['write', 'account', 'admin'];
const TOLL_GATE_TOOLS = [
    'price_write_action' => 'Returns the current USD price, and the work alternative, for one write on a Toll-protected site: a comment, signup, login, form post, or state-changing API call. Use it before a write to choose between paying and doing the work. Not for page views, which are free and need no call. Does not identify the caller.',
    'gate_form_write' => 'Gets a one-use pass for one write on a Toll-protected site. With no payment it returns the payment offer and a work challenge. With proof of payment it returns the pass. Use only for writes. Does not block public reads, does not detect who the caller is, and does not license or price content.',
    'verify_write_pass' => "For the site's own server: checks that a pass sent with a write is valid, unused, and for this site and action. Returns valid or invalid with a reason. Does not score the caller or say whether it is a person or a program.",
];
// Price amounts and rate from the payment server are reused for this long.
const TOLL_GATE_PRICE_CACHE_S = 30;

/** JSON Schemas for the tool inputs (same as manifest.ts INPUT_SCHEMAS, minus search in the action enum). */
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

/**
 * docs/copy.md "Base price label" (PM, verbatim): every manifest price is basis "base". The note is
 * shown only when this site's offers can rise: the payment server reports load_pricing true for a
 * priced class. This plugin sends each visitor's coarse network with relayed offers and redeems and
 * says so (GET /v1/owner/price?net=1); the server reports true only then, and only when it applies
 * a load multiplier (velocity on). Otherwise the note is omitted.
 */
const TOLL_GATE_BASE_PRICE_NOTE = 'Base price. The 402 offer is the price that applies, and it can go up while the site is under load.';

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
 * Price table from the payment server: ['status' => 'test'|'stub', 'prices' => [cls => [amount_msat, usd]] | null,
 * 'load' => [cls => bool]] (load: the server's load_pricing, true only when it says so for that class).
 * Only when the site makes paid offers (payouts on, Payment server, address set, server up).
 * The answer is cached site-wide (one key, no visitor data). It is always asked for with net=1, and
 * a cached answer without the net_declared mark (from an older plugin that did not send networks)
 * is fetched again, so a declared and an undeclared answer are never mixed.
 */
function toll_gate_price_table(): array
{
    $none = ['status' => 'stub', 'prices' => null, 'load' => []];
    if (!toll_gate_lib_ok() || !toll_gate_offers_configured() || get_transient('toll_gate_server_down')) return $none;
    $r = get_transient('toll_gate_price_cache');
    if (!is_array($r) || ($r['net_declared'] ?? null) !== true) {
        $res = toll_gate_server_call('GET', '/v1/owner/price?net=1', null, TOLL_GATE_OFFER_TIMEOUT_S);
        if ($res === null || $res['status'] !== 200) return $none;
        $r = ['net_declared' => true] + $res['body'];
        set_transient('toll_gate_price_cache', $r, TOLL_GATE_PRICE_CACHE_S);
    }
    if (($r['status'] ?? null) !== 'test' || !is_array($r['prices'] ?? null)) return $none;
    [$rate, $at] = toll_gate_fx($r['fx'] ?? null);
    $out = [];
    $load = [];
    foreach (TOLL_GATE_PAID_CLASSES as $c) {
        $m = $r['prices'][$c]['amount_msat'] ?? null;
        if (!is_int($m) || $m <= 0) return $none;
        $out[$c] = ['amount_msat' => $m, 'usd' => Settlement::offerUsd($m, $rate, $at, time())];
        $load[$c] = ($r['load_pricing'][$c] ?? false) === true;
    }
    return ['status' => 'test', 'prices' => $out, 'load' => $load];
}

/** [usd_per_btc, fetched_at] from a payment server's fx object, nulls when absent. */
function toll_gate_fx(mixed $fx): array
{
    $fx = is_array($fx) ? $fx : [];
    $rate = is_int($fx['usd_per_btc'] ?? null) || is_float($fx['usd_per_btc'] ?? null) ? (float) $fx['usd_per_btc'] : null;
    $at = is_int($fx['fetched_at'] ?? null) ? $fx['fetched_at'] : null;
    return [$rate, $at];
}

/**
 * The price that applies now for this visitor, from the payment server (POST /v1/owner/quote with
 * the visitor's network): ['amount_msat', 'usd', 'load_multiplier'], or null when the server does
 * not answer or answers wrongly. Read-only on the server: it mints and counts nothing.
 */
function toll_gate_quote(string $action): ?array
{
    $r = toll_gate_server_call('POST', '/v1/owner/quote', toll_gate_with_net(['action' => $action]), TOLL_GATE_OFFER_TIMEOUT_S);
    if ($r === null || $r['status'] !== 200) return null;
    $b = $r['body'];
    $m = $b['amount_msat'] ?? null;
    $mult = $b['load_multiplier'] ?? null;
    if (($b['status'] ?? null) !== 'test' || !is_int($m) || $m <= 0 || !(is_int($mult) || is_float($mult)) || $mult < 1) return null;
    [$rate, $at] = toll_gate_fx($b['fx'] ?? null);
    return ['amount_msat' => $m, 'usd' => Settlement::offerUsd($m, $rate, $at, time()), 'load_multiplier' => $mult];
}

function toll_gate_api_base(): string
{
    return untrailingslashit(rest_url('toll/v1'));
}

/**
 * TOLL_SITE_URL: the root URL of Toll's own public site, for the manifest's `docs` field only. The site
 * owner defines it in wp-config.php: define('TOLL_SITE_URL', 'https://...');. A PHP constant only, no
 * getenv() fallback: the plugin reads no environment variables anywhere else. Same rules as
 * packages/protocol/src/site-url.ts (TOLL_GATE_SITE_URL_RE is its SITE_URL_PATTERN; tests compare
 * them): lowercase https://, a host name whose last label starts with a letter, optional port and
 * path, no user info, query or fragment, trailing slashes removed. Unset or empty: null, the
 * manifest is unchanged. Invalid: treated as unset, so the site never fails on a typo in wp-config.php,
 * and logged at most once an hour (never the value itself): a per-request flag, plus the
 * toll_gate_site_url_warned transient set for HOUR_IN_SECONDS once the line is written. The check and
 * the set are not atomic, so two requests that start at the same moment may both log; that duplicate
 * is accepted (no lock for a log line).
 */
const TOLL_GATE_SITE_URL_RE = '#^https://(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?::([0-9]{1,5}))?(/[A-Za-z0-9._~!$&\'()*+,;=:@%/-]*)?$#D';

/** [url, null] for an accepted or unset (url null) value, [null, error] for a value that is not accepted. */
function toll_gate_parse_site_url($raw): array
{
    if ($raw === null) return [null, null];
    if (!is_string($raw)) return [null, 'TOLL_SITE_URL must be a string'];
    $v = trim($raw, " \t\r\n");
    if ($v === '') return [null, null];
    if (!preg_match(TOLL_GATE_SITE_URL_RE, $v, $m)) return [null, 'TOLL_SITE_URL must be an absolute https:// URL with a host name (no user info, query or fragment)'];
    if (isset($m[1]) && $m[1] !== '' && ((int) $m[1] < 1 || (int) $m[1] > 65535)) return [null, 'TOLL_SITE_URL has a port outside 1-65535'];
    return [rtrim($v, '/'), null];
}

/** The Toll site root from the TOLL_SITE_URL constant, or null when it is not defined, empty or invalid. */
function toll_gate_site_url(): ?string
{
    static $warned = false;
    [$url, $error] = toll_gate_parse_site_url(defined('TOLL_SITE_URL') ? constant('TOLL_SITE_URL') : null);
    if ($error !== null && !$warned) {
        $warned = true;
        if (get_transient('toll_gate_site_url_warned') === false) {
            set_transient('toll_gate_site_url_warned', 1, HOUR_IN_SECONDS);
            // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
            error_log('Toll: ' . $error . "; ignored, so the manifest's docs field stays as if it were unset");
        }
    }
    return $url;
}

function toll_gate_manifest(): array
{
    $t = toll_gate_price_table();
    $status = $t['status'];
    $api = toll_gate_api_base();
    $by = [];
    foreach (TOLL_GATE_PAID_CLASSES as $c) {
        $p = $t['prices'][$c] ?? null;
        $by[$c] = ($p ? toll_gate_price($p['amount_msat'], $p['usd'], $status) : toll_gate_price(null, null, 'stub')) + ['basis' => 'base'];
    }
    $free = toll_gate_price(0, '0.0000', $status) + ['basis' => 'base'];
    $paid = $t['prices'] !== null;
    $canRise = $paid && in_array(true, $t['load'], true);
    $schemas = toll_gate_input_schemas();
    $tool = fn(string $n, string $endpoint, array $price, bool $paid) => ['name' => $n, 'description' => TOLL_GATE_TOOLS[$n], 'input_schema' => $schemas[$n], 'endpoint' => $endpoint, 'price' => $price, 'payment' => toll_gate_payment($status, $paid)];
    return [
        'name' => 'Toll',
        'description' => TOLL_GATE_MANIFEST_DESCRIPTION,
        'docs' => toll_gate_site_url(),
        'api' => $api,
        'reads_free' => true,
        'not_for' => TOLL_GATE_NOT_FOR,
        'tools' => [
            $tool('price_write_action', $api . '/price?action={action}', $free, false),
            $tool('gate_form_write', $api . '/challenge?action={action}&path={path}&client=agent', $by['write'] + ($canRise ? ['note' => TOLL_GATE_BASE_PRICE_NOTE] : []) + ['by_action' => $by], $paid),
            $tool('verify_write_pass', $api . '/siteverify', $free, false),
        ],
    ];
}

/**
 * GET /wp-json/toll/v1/price?action= : the price of one paid request that applies now (basis "current")
 * plus the free work alternative. This site's 402 relays the payment server's offer. While the server
 * reports no load pricing for the class, that offer is the base amount: load_multiplier 1. When it
 * does, the server quotes the price for this visitor's network (the same amount its relayed 402 offer
 * would carry) with the real load_multiplier; if that quote fails, the base amount is shown with
 * load_multiplier null (unknown).
 */
function toll_gate_rest_price(WP_REST_Request $req): WP_REST_Response
{
    $action = (string) ($req->get_param('action') ?? 'write');
    if (!in_array($action, TOLL_GATE_PAID_CLASSES, true)) return toll_gate_json(['error' => 'bad_action'], 400);
    $t = toll_gate_price_table();
    $p = $t['prices'][$action] ?? null;
    $mult = $p ? 1 : null;
    if ($p && ($t['load'][$action] ?? false)) {
        $q = toll_gate_quote($action);
        $p = $q ?? $p;
        $mult = $q['load_multiplier'] ?? null;
    }
    $price = $p ? toll_gate_price($p['amount_msat'], $p['usd'], $t['status']) : toll_gate_price(null, null, 'stub');
    return toll_gate_json(['action' => $action] + $price + ['basis' => 'current', 'load_multiplier' => $mult, 'work' => ['challenge_url' => toll_gate_challenge_url($action, (string) ($req->get_param('path') ?? '/'))], 'reads_free' => true]);
}

/** Serve the two discovery documents before WordPress routes the request (any visitor, no check). */
function toll_gate_discovery_serve(): void
{
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method !== 'GET' && $method !== 'HEAD') return;
    $path = (string) wp_parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    $home = rtrim((string) wp_parse_url(home_url('/'), PHP_URL_PATH), '/');
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
