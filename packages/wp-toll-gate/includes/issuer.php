<?php
// The default issuer is this site (spec §13): /wp-json/toll/v1/{challenge,redeem,status,health,
// siteverify}. Same wire format as docs/protocol.md. WordPress takes no payments itself: with
// "Collect usage payouts" on and a Payment server set, offers for agents are minted by that server
// and relayed here, and a paid redeem is forwarded to it for checking (payouts.php). Otherwise
// offers are [] and agents get the work check.
declare(strict_types=1);

if (!defined('ABSPATH')) exit;

use Toll\Policy;
use Toll\Protocol;
use Toll\TollError;

const TOLL_GATE_PASS_TTL = 900;
const TOLL_GATE_PASS_USES = 20;
const TOLL_GATE_CHALLENGE_TTL = 120;
const TOLL_GATE_CHALLENGES_PER_MIN = 60;
// Paid pass (docs/settlement.md Q6): one use, 60 seconds, for the agent's Authorization header.
const TOLL_GATE_PAID_PASS_USES = 1;
const TOLL_GATE_PAID_PASS_TTL = 60;

function toll_gate_register_routes(): void
{
    $open = fn () => true; // public endpoints, like the Node issuer; each checks its own input
    register_rest_route('toll/v1', '/challenge', ['methods' => 'GET', 'callback' => 'toll_gate_rest_challenge', 'permission_callback' => $open]);
    register_rest_route('toll/v1', '/redeem', ['methods' => 'POST', 'callback' => 'toll_gate_rest_redeem', 'permission_callback' => $open]);
    register_rest_route('toll/v1', '/status', ['methods' => 'GET', 'callback' => 'toll_gate_rest_status', 'permission_callback' => $open]);
    register_rest_route('toll/v1', '/health', ['methods' => 'GET', 'callback' => 'toll_gate_rest_health', 'permission_callback' => $open]);
    register_rest_route('toll/v1', '/siteverify', ['methods' => 'POST', 'callback' => 'toll_gate_rest_siteverify', 'permission_callback' => $open]);
}

function toll_gate_json(array $body, int $status = 200, array $headers = []): WP_REST_Response
{
    $r = new WP_REST_Response($body, $status);
    $r->header('Cache-Control', 'no-store');
    foreach ($headers as $k => $v) $r->header($k, $v);
    return $r;
}

function toll_gate_ip(): string
{
    return (string) ($_SERVER['REMOTE_ADDR'] ?? '?');
}

/** Per-IP challenge rate limit (spec §16), counted per minute in a transient. */
function toll_gate_allow_challenge(): bool
{
    $key = 'toll_gate_rl_' . md5(toll_gate_ip() . '|' . gmdate('YmdHi'));
    $n = (int) get_transient($key) + 1;
    set_transient($key, $n, 120);
    return $n <= (int) apply_filters('toll_gate_challenges_per_min', TOLL_GATE_CHALLENGES_PER_MIN);
}

/** Route prefix the challenge is bound to (matches the gate's check): longest write route, else "/". */
function toll_gate_prefix(string $path): string
{
    $best = '/';
    foreach (TOLL_GATE_ROUTES as $r) {
        if ($r['class'] !== 'read' && str_starts_with($path, $r['prefix']) && strlen($r['prefix']) > strlen($best)) $best = $r['prefix'];
    }
    return $best;
}

function toll_gate_mint(string $action, string $path, ?string $ua): array
{
    $wp = Policy::workParams($action, Policy::uaClass($ua));
    $c = Protocol::mintChallenge(toll_gate_secret(), toll_gate_site_key(), $action, toll_gate_prefix($path), $wp, TOLL_GATE_CHALLENGE_TTL, time());
    toll_gate_count('challenges_minted');
    return $c;
}

function toll_gate_rest_challenge(WP_REST_Request $req): WP_REST_Response
{
    if (!toll_gate_lib_ok()) return toll_gate_json(['error' => 'unavailable'], 503);
    $action = (string) ($req->get_param('action') ?? 'write');
    if (!isset(Protocol::CLASS_MULT[$action]) || $action === 'read') return toll_gate_json(['error' => 'bad_action'], 400);
    $site = $req->get_param('site');
    if ($site !== null && $site !== '' && $site !== toll_gate_site_key()) return toll_gate_json(['error' => 'wrong_site'], 400);
    if (!toll_gate_allow_challenge()) return toll_gate_json(['error' => 'rate_limited'], 429, ['Retry-After' => '60']);
    $c = toll_gate_mint($action, (string) ($req->get_param('path') ?? '/'), $req->get_header('user-agent'));
    $offers = [];
    if ((string) $req->get_param('offers') === '0') {
        // The agent fetched a 402's challenge_url: it chose the work instead of paying.
        toll_gate_count('work_after_402');
    } elseif (toll_gate_is_agent((string) $req->get_param('client'), (string) $req->get_header('toll_client'))) {
        $offers = toll_gate_relay_offers($action)['offers'] ?? [];
    }
    return toll_gate_json(['challenge' => $c, 'offers' => $offers]);
}

function toll_gate_cookie(string $pass, int $exp): void
{
    if (headers_sent()) return;
    setcookie('toll_pass', $pass, ['expires' => $exp, 'path' => '/', 'secure' => is_ssl(), 'httponly' => true, 'samesite' => 'Lax']);
}

/** Verify a work solution and mint a human pass (900 s, 20 uses). Throws TollError. */
function toll_gate_redeem_solution(mixed $challenge, mixed $solution): array
{
    $now = time();
    $c = Protocol::checkChallenge(toll_gate_secret(), $challenge, $now, toll_gate_site_key());
    if (!toll_gate_first_use($c['id'], $c['exp'])) throw new TollError('replay');
    if (!Protocol::verifyWork(toll_gate_secret(), $c, is_array($solution) ? ($solution['work'] ?? null) : null)) throw new TollError('bad_solution');
    $claims = Protocol::newPassClaims(toll_gate_site_key(), $c['bound']['action'], TOLL_GATE_PASS_USES, TOLL_GATE_PASS_TTL, $now);
    return ['pass' => Protocol::signPass(toll_gate_secret(), $claims), 'exp' => $claims['exp'], 'cls' => $claims['cls'], 'rail' => 'work'];
}

function toll_gate_rest_redeem(WP_REST_Request $req): WP_REST_Response
{
    if (!toll_gate_lib_ok()) return toll_gate_json(['error' => 'unavailable'], 503);
    $b = $req->get_json_params() ?: $req->get_body_params();
    if (isset($b['offer_id'])) return toll_gate_redeem_paid(is_array($b) ? $b : []);
    if (!is_string($b['challenge_id'] ?? null) || !is_array($b['solution'] ?? null) || !is_array($b['challenge'] ?? null)) return toll_gate_json(['error' => 'malformed'], 400);
    if (($b['challenge']['id'] ?? null) !== $b['challenge_id']) return toll_gate_json(['error' => 'malformed'], 400);
    try {
        $r = toll_gate_redeem_solution($b['challenge'], $b['solution']);
    } catch (Toll_Gate_Store_Error $e) {
        return toll_gate_json(['error' => 'unavailable'], 503);
    } catch (TollError $e) {
        return toll_gate_json(['error' => $e->codeName], $e->codeName === 'replay' ? 401 : 400);
    }
    toll_gate_cookie($r['pass'], $r['exp']);
    return toll_gate_json($r);
}

/**
 * Paid redeem: the payment server checks and books the payment (single use there), then this site
 * mints its own short pass. No cookie: agents send it in the Authorization header.
 */
function toll_gate_redeem_paid(array $b): WP_REST_Response
{
    [$status, $body] = toll_gate_relay_redeem($b);
    if ($status !== 200) return toll_gate_json($body, $status);
    $claims = Protocol::newPassClaims(toll_gate_site_key(), $body['cls'], TOLL_GATE_PAID_PASS_USES, TOLL_GATE_PAID_PASS_TTL, time());
    toll_gate_count('paid');
    return toll_gate_json(['pass' => Protocol::signPass(toll_gate_secret(), $claims), 'exp' => $claims['exp'], 'cls' => $claims['cls'], 'rail' => 'settle']);
}

function toll_gate_token_from_request(?WP_REST_Request $req = null): ?string
{
    $auth = $req ? (string) $req->get_header('authorization') : (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? '');
    if (preg_match('/^Toll\s+(\S+)$/i', $auth, $m)) return $m[1];
    if (isset($_POST['toll-pass']) && is_string($_POST['toll-pass']) && $_POST['toll-pass'] !== '') return wp_unslash($_POST['toll-pass']);
    if (isset($_COOKIE['toll_pass']) && is_string($_COOKIE['toll_pass'])) return wp_unslash($_COOKIE['toll_pass']);
    return null;
}

/**
 * Check a pass for an action and spend one use. Returns [ok, reason]. Logs pass_accept, or
 * pass_reject with a reason (expired, exhausted, bad_sig, malformed, wrong_site, class_too_low).
 */
function toll_gate_check_pass(string $token, string $action, bool $consume = true): array
{
    try {
        $claims = Protocol::verifyPass(toll_gate_secret(), $token, time(), toll_gate_site_key(), $action);
        if ($consume) {
            $left = toll_gate_consume($claims['jti'], (int) $claims['n'], (int) $claims['exp']);
            if ($left < 0) throw new TollError('exhausted');
            toll_gate_count('pass_accept');
        }
        return [true, $claims];
    } catch (Toll_Gate_Store_Error $e) {
        return [false, 'store_unavailable'];
    } catch (TollError $e) {
        if ($consume) toll_gate_count('pass_reject');
        return [false, $e->codeName];
    }
}

function toll_gate_rest_status(WP_REST_Request $req): WP_REST_Response
{
    $t = toll_gate_token_from_request($req);
    if (!$t || !toll_gate_lib_ok()) return toll_gate_json(['ok' => false]);
    try {
        $c = Protocol::verifyPass(toll_gate_secret(), $t, time(), toll_gate_site_key(), 'search');
        return toll_gate_json(['ok' => true, 'exp' => $c['exp'], 'cls' => $c['cls'], 'n' => toll_gate_uses_left($c['jti'], (int) $c['n'], (int) $c['exp'])]);
    } catch (\Throwable $e) {
        return toll_gate_json(['ok' => false]);
    }
}

function toll_gate_rest_health(): WP_REST_Response
{
    return toll_gate_json(['ok' => toll_gate_lib_ok(), 'v' => '1.0.0', 'settlement' => 'off']);
}

/** siteverify (spec §8.5): form or JSON secret + response (pass or redeem payload) + optional action. */
function toll_gate_rest_siteverify(WP_REST_Request $req): WP_REST_Response
{
    $b = $req->get_json_params() ?: $req->get_body_params();
    $secret = is_string($b['secret'] ?? null) ? $b['secret'] : '';
    if (!hash_equals(toll_gate_secret(), $secret)) return toll_gate_json(['success' => false, 'error-codes' => ['invalid-input-secret']]);
    $response = $b['response'] ?? '';
    $action = is_string($b['action'] ?? null) && isset(Protocol::CLASS_MULT[$b['action']]) ? $b['action'] : 'search';
    try {
        if (is_string($response) && str_starts_with(trim($response), '{')) {
            $p = json_decode($response, true);
            if (!is_array($p) || ($p['challenge']['id'] ?? null) !== ($p['challenge_id'] ?? '')) throw new TollError('malformed');
            $response = toll_gate_redeem_solution($p['challenge'], $p['solution'] ?? [])['pass'];
        }
        [$ok, $c] = toll_gate_check_pass((string) $response, $action);
        if (!$ok) throw new TollError(is_string($c) ? $c : 'malformed');
        return toll_gate_json(['success' => true, 'action' => $c['cls'], 'hostname' => (string) wp_parse_url(home_url(), PHP_URL_HOST), 'challenge_ts' => gmdate('Y-m-d\TH:i:s.000\Z', (int) $c['iat'])]);
    } catch (\Throwable $e) {
        $code = $e instanceof TollError ? $e->codeName : '';
        return toll_gate_json(['success' => false, 'error-codes' => [in_array($code, ['expired', 'exhausted', 'replay'], true) ? 'timeout-or-duplicate' : 'invalid-input-response']]);
    }
}
