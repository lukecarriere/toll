<?php
// The gate: puts <toll-gate> in protected forms, loads the widget, and verifies the pass on the
// server before WordPress handles the form (spec §13). Fails closed: no valid pass, no write.
// Opt-in forms: the WooCommerce classic checkout and Contact Form 7 (REST and no-JS submits). The
// WooCommerce block checkout (Store API) isn't covered yet: nothing here is registered for it, so
// people and agents get stock behavior there.
declare(strict_types=1);

if (!defined('ABSPATH')) exit;

function toll_gate_init_gate(): void
{
    $s = toll_gate_settings();
    $f = $s['forms'];
    add_action('wp_enqueue_scripts', 'toll_gate_enqueue');
    add_filter('script_loader_tag', 'toll_gate_script_tag', 10, 2);
    if ($f['comments']) {
        add_filter('comment_form_submit_field', fn ($html) => $html . toll_gate_element('write'));
        add_filter('preprocess_comment', 'toll_gate_check_comment', 1);
    }
    if ($f['login']) {
        add_action('login_form', fn () => toll_gate_print_element('account'));
        // Before the password is checked (known user), and as a catch-all after the core checks.
        add_filter('wp_authenticate_user', 'toll_gate_check_login', 1, 1);
        add_filter('authenticate', 'toll_gate_check_login', 30, 1);
    }
    if ($f['register']) {
        add_action('register_form', fn () => toll_gate_print_element('account'));
        add_filter('registration_errors', 'toll_gate_check_wp_error', 10, 1);
    }
    if ($f['lostpassword']) {
        add_action('lostpassword_form', fn () => toll_gate_print_element('account'));
        add_action('lostpassword_post', 'toll_gate_check_wp_error', 10, 1);
    }
    if ($f['login'] || $f['register'] || $f['lostpassword']) add_action('login_enqueue_scripts', 'toll_gate_enqueue');
    if ($f['woo'] && toll_gate_woo_active()) {
        add_action('woocommerce_review_order_before_submit', fn () => toll_gate_print_element('write'));
        add_action('woocommerce_after_checkout_validation', 'toll_gate_check_woo', 10, 2);
    }
    if ($f['cf7'] && toll_gate_cf7_active()) {
        add_filter('wpcf7_form_elements', fn ($html) => $html . toll_gate_element('write'));
        add_filter('wpcf7_spam', 'toll_gate_check_cf7', 10, 1);
    }
    if (toll_gate_rest_gated_routes() !== []) add_filter('rest_dispatch_request', 'toll_gate_rest_gate', 10, 2);
}

function toll_gate_widget_url(): string
{
    return plugins_url('assets/widget/toll.js', TOLL_GATE_FILE);
}

function toll_gate_enqueue(): void
{
    wp_enqueue_script('toll-gate', toll_gate_widget_url(), [], TOLL_GATE_VERSION, ['strategy' => 'defer', 'in_footer' => false]);
}

/** The widget reads its issuer, site key and time limit from data attributes on its own tag. */
function toll_gate_script_tag(string $tag, string $handle): string
{
    if ($handle !== 'toll-gate') return $tag;
    $s = toll_gate_settings();
    $attrs = sprintf(' data-issuer="%s" data-site="%s" data-max-solve-ms="%d"', esc_attr(untrailingslashit(rest_url('toll'))), esc_attr(toll_gate_site_key()), (int) $s['longest_s'] * 1000);
    return preg_replace('/<script /', '<script' . $attrs . ' ', $tag, 1) ?? $tag;
}

function toll_gate_element(string $action): string
{
    $box = toll_gate_settings()['visible_check'] ? ' data-toll-checkbox="true"' : '';
    return sprintf('<toll-gate action="%s"%s></toll-gate><noscript><p>%s</p></noscript>', esc_attr($action), $box, esc_html(toll_gate_s('no_js')));
}

/** The only markup toll_gate_element() makes, for printing it through wp_kses. */
const TOLL_GATE_ELEMENT_HTML = ['toll-gate' => ['action' => true, 'data-toll-checkbox' => true], 'noscript' => [], 'p' => []];

/** Prints the element in action hooks (login, registration, lost password, checkout). */
function toll_gate_print_element(string $action): void
{
    echo wp_kses(toll_gate_element($action), TOLL_GATE_ELEMENT_HTML);
}

/**
 * Verify the pass on this request for an action. Returns [ok, reason]. A request with no pass logs
 * pass_absent (first contact), not a rejection; a bad pass logs pass_reject with its reason. The
 * refusal itself is counted where it is sent (turned_away for a 403, offer_shown for a 402).
 * Themes can call this for their own data-toll forms.
 */
function toll_gate_verify_request(string $action): array
{
    // One check per request and action: several hooks may ask, but only one pass use is spent.
    static $done = [];
    if (isset($done[$action])) return $done[$action];
    return $done[$action] = toll_gate_verify_request_once($action);
}

function toll_gate_verify_request_once(string $action): array
{
    if (!toll_gate_lib_ok()) return [false, 'unavailable'];
    $token = toll_gate_token_from_request();
    if ($token === null) {
        toll_gate_count('pass_absent');
        return [false, 'missing'];
    }
    [$ok, $r] = toll_gate_check_pass($token, $action);
    return [$ok, $ok ? 'ok' : (string) $r];
}

/** Count one turned_away per refused request and action, however many hooks refuse it. */
function toll_gate_turned_away(string $action): void
{
    static $done = [];
    if (isset($done[$action])) return;
    $done[$action] = true;
    toll_gate_count('turned_away');
}

/** An automated client (docs/settlement.md Q2): client=agent in the query or a Toll-Client: agent header. */
function toll_gate_is_agent(?string $query = null, ?string $header = null): bool
{
    $query ??= is_string($_GET['client'] ?? null) ? $_GET['client'] : '';
    $header ??= (string) ($_SERVER['HTTP_TOLL_CLIENT'] ?? '');
    return $query === 'agent' || strtolower(trim($header)) === 'agent';
}

/** The work fallback link in a 402: this site's challenge endpoint with offers=0 (same query as Node). */
function toll_gate_challenge_url(string $action, string $path): string
{
    $u = rest_url('toll/v1/challenge');
    $rel = (string) wp_parse_url($u, PHP_URL_PATH);
    $q = (string) wp_parse_url($u, PHP_URL_QUERY);
    if ($q !== '') $rel .= '?' . $q;
    $query = http_build_query(['site' => toll_gate_site_key(), 'action' => $action, 'path' => $path, 'client' => 'agent', 'offers' => '0'], '', '&', PHP_QUERY_RFC3986);
    return $rel . (str_contains($rel, '?') ? '&' : '?') . $query;
}

/**
 * How to refuse an agent the way the Node issuer does (docs/settlement.md §4): a 402 with the offers
 * the payment server minted, the WWW-Authenticate value it gave, and a challenge_url for the work
 * instead; or, with no offers (payouts off, Test mode, no address, server down or slow), the
 * work-only 403 with an inline challenge. Over the per-IP challenge limit: 403 with no challenge.
 * Returns [status, body, headers] and counts offer_shown or turned_away; sending is up to the caller.
 */
function toll_gate_agent_refusal(string $action, string $path): array
{
    $ok = toll_gate_lib_ok() && toll_gate_allow_challenge();
    $relay = $ok ? toll_gate_relay_offers($action) : null;
    if ($relay !== null) {
        toll_gate_count('offer_shown');
        $headers = ['WWW-Authenticate' => $relay['www_authenticate'], 'Access-Control-Expose-Headers' => 'WWW-Authenticate'];
        return [402, ['error' => 'payment_required', 'challenge_url' => toll_gate_challenge_url($action, $path), 'offers' => $relay['offers']], $headers];
    }
    toll_gate_turned_away($action);
    $body = ['error' => 'toll_required'];
    if ($ok) {
        try {
            $body['challenge'] = toll_gate_mint($action, $path, isset($_SERVER['HTTP_USER_AGENT']) ? (string) $_SERVER['HTTP_USER_AGENT'] : null);
        } catch (\Throwable $e) {
            // No challenge in the 403 rather than an error page.
        }
    }
    return [403, $body, []];
}

/** Send toll_gate_agent_refusal() and stop: nothing after this runs (no comment, order or mail). */
function toll_gate_refuse_agent(string $action, string $path): never
{
    nocache_headers();
    [$status, $body, $headers] = toll_gate_agent_refusal($action, $path);
    foreach ($headers as $name => $value) header($name . ': ' . $value);
    wp_send_json($body, $status);
}

/** Path of this request, for the challenge a refusal carries ("/" when it can't be read). */
function toll_gate_request_path(): string
{
    $p = wp_parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    return is_string($p) && $p !== '' ? $p : '/';
}

/**
 * Look at the pass on this request without spending a use: true when it is valid for $action now
 * and has a use left. Used where a refusal must come before the form's own checks, and the use is
 * spent after them (toll_gate_verify_request(), atomic), so a form that fails its own validation
 * costs nothing. A missing pass counts pass_absent, a bad or used-up one pass_reject (the request is
 * refused right after); nothing counts pass_accept until the use is actually spent.
 */
function toll_gate_peek_request(string $action, ?WP_REST_Request $req = null): bool
{
    if (!toll_gate_lib_ok()) return false;
    $token = toll_gate_token_from_request($req);
    if ($token === null) {
        toll_gate_count('pass_absent');
        return false;
    }
    [$ok, $claims] = toll_gate_check_pass($token, $action, false);
    $ok = $ok && toll_gate_uses_left((string) $claims['jti'], (int) $claims['n'], (int) $claims['exp']) > 0;
    if (!$ok) toll_gate_count('pass_reject');
    return $ok;
}

/** REST routes (patterns on the request route) of opt-in forms whose agents are checked before the route runs. */
function toll_gate_rest_gated_routes(): array
{
    $f = toll_gate_settings()['forms'];
    $routes = [];
    if ($f['cf7'] && toll_gate_cf7_active()) $routes[] = '#^/contact-form-7/v1/contact-forms/\d+/feedback$#';
    return $routes;
}

/**
 * rest_dispatch_request: an agent POST to a gated route without a valid pass gets the 402 (or the
 * 403 work check) instead of the route, with nothing spent; a valid pass goes through and its use is
 * spent later, after the form's own validation. rest_request_before_callbacks can't do this: WordPress
 * still runs the route after it unless it returns a WP_Error, which has a different body. Humans go
 * through untouched (their check stays where it was, in the form's own hook).
 */
function toll_gate_rest_gate($result, $request)
{
    if ($result !== null || !($request instanceof WP_REST_Request) || $request->get_method() !== 'POST' || !toll_gate_is_agent()) return $result;
    $route = (string) $request->get_route();
    foreach (toll_gate_rest_gated_routes() as $re) {
        if (!preg_match($re, $route)) continue;
        if (toll_gate_peek_request('write', $request)) return $result;
        [$status, $body, $headers] = toll_gate_agent_refusal('write', toll_gate_request_path());
        $res = new WP_REST_Response($body, $status);
        foreach ($headers + wp_get_nocache_headers() as $name => $value) $res->header($name, (string) $value);
        return $res;
    }
    return $result;
}

function toll_gate_refuse(): never
{
    toll_gate_turned_away('write');
    wp_die(esc_html(toll_gate_s('no_js')), esc_html(get_bloginfo('name')), ['response' => 403, 'back_link' => true]);
}

function toll_gate_check_comment(array $data): array
{
    // Staff replying from the dashboard are already signed in with moderation rights.
    if (current_user_can('moderate_comments')) return $data;
    if (toll_gate_verify_request('write')[0]) return $data;
    if (toll_gate_is_agent()) toll_gate_refuse_agent('write', '/wp-comments-post.php');
    toll_gate_refuse();
}

/** Only the wp-login.php form is gated, not application passwords or XML-RPC. */
function toll_gate_check_login($user)
{
    if ($user instanceof WP_Error && $user->get_error_code() === 'toll_required') return $user;
    if (($GLOBALS['pagenow'] ?? '') !== 'wp-login.php' || ($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST' || !isset($_POST['log'])) return $user;
    if (toll_gate_verify_request('account')[0]) return $user;
    if (toll_gate_is_agent()) toll_gate_refuse_agent('account', '/wp-login.php');
    toll_gate_turned_away('account');
    return new WP_Error('toll_required', esc_html(toll_gate_s('no_js')));
}

/** Registration and lost password on wp-login.php. */
function toll_gate_check_wp_error($errors)
{
    if (toll_gate_verify_request('account')[0]) return $errors;
    if (toll_gate_is_agent()) toll_gate_refuse_agent('account', '/wp-login.php');
    toll_gate_turned_away('account');
    if ($errors instanceof WP_Error) $errors->add('toll_required', esc_html(toll_gate_s('no_js')));
    return $errors;
}

/**
 * WooCommerce classic checkout (?wc-ajax=checkout; woocommerce_after_checkout_validation runs after
 * the field and cart checks and before the order is created, stock is reserved or payment is tried).
 * Agents: nothing is spent or refused while WooCommerce has its own errors (fields, or cart notices
 * such as an item out of stock) or the post only updates totals; once there are none the use is spent
 * (atomic), and an agent without a usable pass, including one whose last use another request just
 * spent, gets the 402 or the 403 work check and the checkout stops there: no order, no stock held, no
 * payment. Humans: the form error, as before. A use spent here stays spent if the payment gateway then
 * declines the order. The block checkout (Store API) is not covered: nothing here runs for it.
 */
function toll_gate_check_woo($data, $errors): void
{
    $agent = toll_gate_is_agent();
    if ($agent && toll_gate_woo_not_ready($data, $errors)) return;
    if (toll_gate_verify_request('write')[0]) return;
    if ($agent) toll_gate_refuse_agent('write', toll_gate_request_path());
    toll_gate_turned_away('write');
    if ($errors instanceof WP_Error) $errors->add('toll_required', esc_html(toll_gate_s('no_js')));
}

/** WooCommerce will not create an order from this post anyway: its own errors, or a totals refresh. */
function toll_gate_woo_not_ready($data, $errors): bool
{
    if ($errors instanceof WP_Error && $errors->has_errors()) return true;
    if (function_exists('wc_notice_count') && wc_notice_count('error') > 0) return true;
    return is_array($data) && !empty($data['woocommerce_checkout_update_totals']);
}

/**
 * Contact Form 7 (wpcf7_spam runs after CF7's own validation and before any mail is sent). The use
 * is spent here (atomic). Agents without a usable pass get the 402 or the 403 work check and the
 * submission stops, so no mail goes out; on the REST route they were already refused before CF7 ran
 * (toll_gate_rest_gate), so this only catches a pass spent by another request meanwhile and non-JS
 * posts. Humans: marked as spam, as before. Spam already found by another filter wins.
 */
function toll_gate_check_cf7($spam): bool
{
    if ($spam) return true;
    if (toll_gate_verify_request('write')[0]) return false;
    if (toll_gate_is_agent()) toll_gate_refuse_agent('write', toll_gate_request_path());
    toll_gate_turned_away('write');
    return true;
}
