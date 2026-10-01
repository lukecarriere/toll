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
        add_action('login_form', fn () => print(toll_gate_element('account')));
        // Before the password is checked (known user), and as a catch-all after the core checks.
        add_filter('wp_authenticate_user', 'toll_gate_check_login', 1, 1);
        add_filter('authenticate', 'toll_gate_check_login', 30, 1);
    }
    if ($f['register']) {
        add_action('register_form', fn () => print(toll_gate_element('account')));
        add_filter('registration_errors', 'toll_gate_check_wp_error', 10, 1);
    }
    if ($f['lostpassword']) {
        add_action('lostpassword_form', fn () => print(toll_gate_element('account')));
        add_action('lostpassword_post', 'toll_gate_check_wp_error', 10, 1);
    }
    if ($f['login'] || $f['register'] || $f['lostpassword']) add_action('login_enqueue_scripts', 'toll_gate_enqueue');
    if ($f['woo'] && toll_gate_woo_active()) {
        add_action('woocommerce_review_order_before_submit', fn () => print(toll_gate_element('write')));
        add_action('woocommerce_after_checkout_validation', 'toll_gate_check_woo', 10, 2);
    }
    if ($f['cf7'] && toll_gate_cf7_active()) {
        add_filter('wpcf7_form_elements', fn ($html) => $html . toll_gate_element('write'));
        add_filter('wpcf7_spam', fn ($spam) => $spam || !toll_gate_verify_request('write')[0], 10, 1);
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

/**
 * Verify the pass on this request for an action. Returns [ok, reason]. A request with no pass logs
 * pass_absent (first contact), not a rejection; a refused request also counts as turned_away.
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
    if (!toll_gate_lib_ok()) {
        toll_gate_count('turned_away');
        return [false, 'unavailable'];
    }
    $token = toll_gate_token_from_request();
    if ($token === null) {
        toll_gate_count('pass_absent');
        toll_gate_count('turned_away');
        return [false, 'missing'];
    }
    [$ok, $r] = toll_gate_check_pass($token, $action);
    if (!$ok) toll_gate_count('turned_away');
    return [$ok, $ok ? 'ok' : (string) $r];
}

function toll_gate_refuse(): never
{
    wp_die(esc_html(toll_gate_s('no_js')), esc_html(get_bloginfo('name')), ['response' => 403, 'back_link' => true]);
}

function toll_gate_check_comment(array $data): array
{
    // Staff replying from the dashboard are already signed in with moderation rights.
    if (current_user_can('moderate_comments')) return $data;
    if (!toll_gate_verify_request('write')[0]) toll_gate_refuse();
    return $data;
}

/** Only the wp-login.php form is gated, not application passwords or XML-RPC. */
function toll_gate_check_login($user)
{
    if ($user instanceof WP_Error && $user->get_error_code() === 'toll_required') return $user;
    if (($GLOBALS['pagenow'] ?? '') !== 'wp-login.php' || ($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST' || !isset($_POST['log'])) return $user;
    if (toll_gate_verify_request('account')[0]) return $user;
    return new WP_Error('toll_required', esc_html(toll_gate_s('no_js')));
}

function toll_gate_check_wp_error($errors)
{
    if (!toll_gate_verify_request('account')[0] && $errors instanceof WP_Error) $errors->add('toll_required', esc_html(toll_gate_s('no_js')));
    return $errors;
}

function toll_gate_check_woo($data, $errors): void
{
    if (!toll_gate_verify_request('write')[0] && $errors instanceof WP_Error) $errors->add('toll_required', esc_html(toll_gate_s('no_js')));
}
