<?php
// The gate: puts <toll-gate> in protected forms, loads the widget, and verifies the pass on the
// server before WordPress handles the form (spec §13). Fails closed: no valid pass, no write.
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
 * Refuse an agent the way the Node issuer does (docs/settlement.md §4): a 402 with the offers the
 * payment server minted, the WWW-Authenticate value it gave, and a challenge_url for the work
 * instead; or, with no offers (payouts off, Test mode, no address, server down or slow), the
 * work-only 403 with an inline challenge. Over the per-IP challenge limit: 403 with no challenge.
 */
function toll_gate_refuse_agent(string $action, string $path): never
{
    nocache_headers();
    $ok = toll_gate_lib_ok() && toll_gate_allow_challenge();
    $relay = $ok ? toll_gate_relay_offers($action) : null;
    if ($relay !== null) {
        toll_gate_count('offer_shown');
        header('WWW-Authenticate: ' . $relay['www_authenticate']);
        header('Access-Control-Expose-Headers: WWW-Authenticate');
        wp_send_json(['error' => 'payment_required', 'challenge_url' => toll_gate_challenge_url($action, $path), 'offers' => $relay['offers']], 402);
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
    wp_send_json($body, 403);
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

/** WooCommerce checkout and Contact Form 7 stay work-only for agents (no 402 there yet). */
function toll_gate_check_woo($data, $errors): void
{
    if (toll_gate_verify_request('write')[0]) return;
    toll_gate_turned_away('write');
    if ($errors instanceof WP_Error) $errors->add('toll_required', esc_html(toll_gate_s('no_js')));
}

function toll_gate_check_cf7($spam): bool
{
    if ($spam) return true;
    if (toll_gate_verify_request('write')[0]) return false;
    toll_gate_turned_away('write');
    return true;
}
