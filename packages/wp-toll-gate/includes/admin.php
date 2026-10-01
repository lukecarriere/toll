<?php
// Settings → Toll (design/HANDOFF.md §3, design/proto/wp-settings.html). Core WordPress markup;
// the only plugin CSS is the balance box, the Advanced panel and the show/hide rules.
declare(strict_types=1);

if (!defined('ABSPATH')) exit;

use Toll\Settlement;

function toll_gate_admin_init(): void
{
    add_action('admin_menu', fn () => add_options_page(toll_gate_s('title'), toll_gate_s('menu'), 'manage_options', 'toll-gate', 'toll_gate_render_settings'));
    add_action('admin_enqueue_scripts', 'toll_gate_admin_assets');
    add_action('admin_post_toll_gate_save', 'toll_gate_handle_save');
    add_action('admin_post_toll_gate_export', 'toll_gate_handle_export');
    add_filter('plugin_action_links_' . plugin_basename(TOLL_GATE_FILE), fn ($links) => array_merge(['<a href="' . esc_url(admin_url('options-general.php?page=toll-gate')) . '">Settings</a>'], $links));
}

function toll_gate_admin_assets(string $hook): void
{
    if ($hook !== 'settings_page_toll-gate') return;
    wp_enqueue_style('toll-gate-admin', plugins_url('assets/admin.css', TOLL_GATE_FILE), [], TOLL_GATE_VERSION);
    wp_enqueue_script('toll-gate-admin', plugins_url('assets/admin.js', TOLL_GATE_FILE), [], TOLL_GATE_VERSION, ['in_footer' => true]);
}

function toll_gate_page_url(array $args = []): string
{
    return add_query_arg($args, admin_url('options-general.php?page=toll-gate'));
}

function toll_gate_set_notice(string $kind, string $text): void
{
    set_transient('toll_gate_notice_' . get_current_user_id(), ['kind' => $kind, 'text' => $text], 60);
}

function toll_gate_take_notice(): ?array
{
    $key = 'toll_gate_notice_' . get_current_user_id();
    $n = get_transient($key);
    if ($n) delete_transient($key);
    return is_array($n) ? $n : null;
}

function toll_gate_handle_save(): void
{
    if (!current_user_can('manage_options')) wp_die('', '', ['response' => 403]);
    check_admin_referer('toll_gate_save');
    $do = sanitize_key((string) ($_POST['toll_gate_do'] ?? 'save'));
    if ($do === 'new_secret') {
        toll_gate_new_secret();
        toll_gate_set_notice('success', toll_gate_s('n_saved'));
    } elseif ($do === 'withdraw') {
        $r = toll_gate_withdraw(sanitize_textarea_field(wp_unslash((string) ($_POST['toll_gate_invoice'] ?? ''))));
        if ($r['ok']) toll_gate_set_notice('success', sprintf(toll_gate_s('n_withdrawn'), $r['usd']));
        elseif ($r['error'] === 'too_much') toll_gate_set_notice('error', toll_gate_s('n_wd_too_much'));
        elseif ($r['error'] === 'down') toll_gate_set_notice('warning', toll_gate_s('n_down'));
        else toll_gate_set_notice('error', toll_gate_s('n_wd_failed'));
    } else {
        $in = wp_unslash($_POST['toll_gate'] ?? []);
        $in = is_array($in) ? $in : [];
        $s = toll_gate_settings();
        foreach (array_keys(TOLL_GATE_DEFAULTS['forms']) as $f) $s['forms'][$f] = empty($in['forms'][$f]) ? 0 : 1;
        $s['visible_check'] = empty($in['visible_check']) ? 0 : 1;
        $s['longest_s'] = in_array((int) ($in['longest_s'] ?? 8), [4, 8, 12], true) ? (int) $in['longest_s'] : 8;
        $s['payouts'] = empty($in['payouts']) ? 0 : 1;
        $s['connection'] = ($in['connection'] ?? 'test') === 'server' ? 'server' : 'test';
        $url = trim((string) ($in['server_url'] ?? ''));
        $s['server_url'] = $url !== '' && preg_match('#^https?://#i', $url) ? esc_url_raw($url, ['http', 'https']) : '';
        toll_gate_update_settings($s);
        $key = trim((string) ($in['server_key'] ?? ''));
        if ($key !== '') update_option('toll_gate_server_key', sanitize_text_field($key), false);
        toll_gate_set_notice('success', toll_gate_s('n_saved'));
    }
    wp_safe_redirect(toll_gate_page_url());
    exit;
}

/** Owner-initiated download of the counters. Nothing is sent anywhere. */
function toll_gate_handle_export(): void
{
    if (!current_user_can('manage_options')) wp_die('', '', ['response' => 403]);
    check_admin_referer('toll_gate_export');
    nocache_headers();
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="toll-counters.csv"');
    echo toll_gate_counters_csv(); // plain integers and fixed column names
    exit;
}

function toll_gate_render_settings(): void
{
    if (!current_user_can('manage_options')) return;
    $s = toll_gate_settings();
    $p = toll_gate_payouts_view($s);
    $c = toll_gate_counters();
    $server = $s['connection'] === 'server';
    $noaddr = $server && trim((string) $s['server_url']) === '';
    $down = $p['state'] === 'down';
    $classes = array_filter(['toll-root', $s['payouts'] ? 'payouts' : '', $server ? 'server' : '', $noaddr ? 'noaddr' : '', $down ? 'down' : '']);
    $fee = Settlement::feePercent((int) $p['fee_bps']);
    $usd = $p['usd'];
    $wd_off = $noaddr || $down;
    $notice = toll_gate_take_notice();
    $export = wp_nonce_url(admin_url('admin-post.php?action=toll_gate_export'), 'toll_gate_export');
    $chk = fn ($on) => $on ? ' checked' : '';
    ?>
<div class="wrap">
<div class="<?php echo esc_attr(implode(' ', $classes)); ?>" id="toll-gate-settings">
<h1><?php echo esc_html(toll_gate_s('title')); ?></h1>
<?php if ($notice) : ?>
<div class="notice notice-<?php echo esc_attr($notice['kind']); ?>" role="status"><p><?php echo esc_html($notice['text']); ?></p></div>
<?php endif; ?>
<div class="notice notice-warning toll-top needs-down" role="status"><p><?php echo esc_html(toll_gate_s('n_down')); ?></p></div>
<?php if ($p['state'] === 'ok' && $p['paused']) : ?>
<div class="notice notice-warning toll-top" role="status"><p><?php echo esc_html(toll_gate_s('n_paused')); ?></p></div>
<?php endif; ?>
<p class="toll-stat"><?php echo esc_html(sprintf(toll_gate_s('issued_today'), number_format_i18n($c['challenges_today']))); ?> · <a href="<?php echo esc_url($export); ?>" id="toll-export"><?php echo esc_html(toll_gate_s('export')); ?></a></p>
<p class="description toll-export-help"><?php echo esc_html(toll_gate_s('export_help')); ?></p>

<form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
<input type="hidden" name="action" value="toll_gate_save">
<?php wp_nonce_field('toll_gate_save'); ?>

<h2 class="title"><?php echo esc_html(toll_gate_s('protect_h')); ?></h2>
<p class="description"><?php echo esc_html(toll_gate_s('protect_desc')); ?></p>
<table class="form-table" role="presentation"><tbody>
<tr><th scope="row"><?php echo esc_html(toll_gate_s('forms')); ?></th><td><fieldset><legend class="screen-reader-text"><?php echo esc_html(toll_gate_s('forms')); ?></legend>
<?php foreach (['comments', 'login', 'register', 'lostpassword'] as $f) : ?>
<label><input type="checkbox" name="toll_gate[forms][<?php echo esc_attr($f); ?>]" value="1"<?php echo $chk($s['forms'][$f]); ?>> <?php echo esc_html(toll_gate_s($f)); ?></label><br>
<?php endforeach; ?>
<?php if (toll_gate_woo_active()) : ?>
<label><input type="checkbox" name="toll_gate[forms][woo]" value="1"<?php echo $chk($s['forms']['woo']); ?>> <?php echo esc_html(toll_gate_s('woo')); ?> <span class="toll-muted"><?php echo esc_html(toll_gate_s('woo_active')); ?></span></label><br>
<?php endif; ?>
<?php if (toll_gate_cf7_active()) : ?>
<label><input type="checkbox" name="toll_gate[forms][cf7]" value="1"<?php echo $chk($s['forms']['cf7']); ?>> <?php echo esc_html(toll_gate_s('cf7')); ?> <span class="toll-muted"><?php echo esc_html(toll_gate_s('cf7_active')); ?></span></label><br>
<?php endif; ?>
<label><input type="checkbox" checked disabled> <?php echo wp_kses(toll_gate_s('any_form'), ['code' => []]); ?></label><br>
<p class="description"><?php echo wp_kses(toll_gate_s('any_form_help'), ['code' => []]); ?></p>
</fieldset></td></tr>
<tr><th scope="row"><?php echo esc_html(toll_gate_s('visible_h')); ?></th><td><label><input type="checkbox" name="toll_gate[visible_check]" value="1"<?php echo $chk($s['visible_check']); ?>> <?php echo esc_html(toll_gate_s('visible_label')); ?></label>
<p class="description"><?php echo esc_html(toll_gate_s('visible_help')); ?></p></td></tr>
<tr><th scope="row"><label for="toll-longest"><?php echo esc_html(toll_gate_s('longest_h')); ?></label></th><td><select id="toll-longest" name="toll_gate[longest_s]">
<?php foreach ([4, 8, 12] as $n) : ?><option value="<?php echo $n; ?>"<?php selected($s['longest_s'], $n); ?>><?php echo esc_html(sprintf(toll_gate_s('seconds'), $n)); ?></option><?php endforeach; ?>
</select>
<p class="description"><?php echo esc_html(toll_gate_s('longest_help')); ?></p></td></tr>
</tbody></table>

<h2 class="title"><?php echo esc_html(toll_gate_s('keys_h')); ?></h2>
<table class="form-table" role="presentation"><tbody>
<tr><th scope="row"><label for="toll-site-key"><?php echo esc_html(toll_gate_s('site_key')); ?></label></th><td><input id="toll-site-key" class="regular-text code" value="<?php echo esc_attr(toll_gate_site_key()); ?>" readonly>
<p class="description"><?php echo esc_html(toll_gate_s('site_key_help')); ?></p></td></tr>
<tr><th scope="row"><label for="toll-secret"><?php echo esc_html(toll_gate_s('secret')); ?></label></th><td><input id="toll-secret" type="password" class="regular-text code" value="<?php echo esc_attr(toll_gate_secret()); ?>" readonly autocomplete="off"> <button class="button" type="button" id="toll-show" data-show="<?php echo esc_attr(toll_gate_s('show')); ?>" data-hide="<?php echo esc_attr(toll_gate_s('hide')); ?>"><?php echo esc_html(toll_gate_s('show')); ?></button> <button class="button" type="submit" name="toll_gate_do" value="new_secret"><?php echo esc_html(toll_gate_s('new_secret')); ?></button>
<p class="description"><?php echo esc_html(toll_gate_s('secret_help')); ?></p></td></tr>
</tbody></table>

<h2 class="title"><?php echo esc_html(toll_gate_s('payouts_h')); ?></h2>
<table class="form-table" role="presentation"><tbody>
<tr><th scope="row"><?php echo esc_html(toll_gate_s('payouts')); ?></th><td><label><input type="checkbox" class="pay-toggle" id="toll-payouts" name="toll_gate[payouts]" value="1"<?php echo $chk($s['payouts']); ?>> <?php echo esc_html(toll_gate_s('collect')); ?></label>
<p class="description"><?php echo esc_html(toll_gate_s('collect_help')); ?></p></td></tr>
<tr class="needs-payouts needs-noaddr"><th scope="row"><?php echo esc_html(toll_gate_s('balance')); ?></th><td><div class="notice notice-warning inline"><p><?php echo esc_html(toll_gate_s('no_addr')); ?></p></div></td></tr>
<tr class="needs-payouts has-addr"><th scope="row"><?php echo esc_html(toll_gate_s('balance')); ?></th><td><?php if ($usd !== null) : ?><div class="toll-bal not-down"><strong><?php echo esc_html($usd); ?></strong><span><?php echo esc_html(Settlement::fillFee(toll_gate_s('balance_line'), (int) $p['fee_bps'])); ?></span></div><?php else : ?><div class="toll-bal not-down"><strong>—</strong><span><?php echo esc_html(toll_gate_s('balance_later')); ?></span></div><?php endif; ?><div class="toll-bal needs-down"><strong>—</strong><span><?php echo esc_html(toll_gate_s('balance_later')); ?></span></div>
<p class="description"><?php echo esc_html(toll_gate_s('to_withdraw')); ?></p></td></tr>
</tbody></table>

<details class="toll-adv"><summary><?php echo esc_html(toll_gate_s('adv')); ?> <span class="toll-muted"><?php echo esc_html(toll_gate_s('adv_note')); ?></span></summary><div class="toll-in">
<table class="form-table" role="presentation"><tbody>
<tr><th scope="row"><label for="toll-connection"><?php echo esc_html(toll_gate_s('connection')); ?></label></th><td><select id="toll-connection" name="toll_gate[connection]"><option value="test"<?php selected(!$server); ?>><?php echo esc_html(toll_gate_s('conn_test')); ?></option><option value="server"<?php selected($server); ?>><?php echo esc_html(toll_gate_s('conn_server')); ?></option></select>
<p class="description test-only"><?php echo esc_html(toll_gate_s('test_help')); ?></p></td></tr>
<tr class="needs-server"><th scope="row"><label for="toll-server-url"><?php echo esc_html(toll_gate_s('server_addr')); ?></label></th><td><input id="toll-server-url" name="toll_gate[server_url]" type="url" class="regular-text code" placeholder="<?php echo esc_attr(toll_gate_s('server_addr_ph')); ?>" inputmode="url" autocomplete="off" value="<?php echo esc_attr((string) $s['server_url']); ?>">
<p class="description"><?php echo esc_html(toll_gate_s('server_addr_help')); ?></p></td></tr>
<tr class="needs-server"><th scope="row"><label for="toll-server-key"><?php echo esc_html(toll_gate_s('server_key')); ?></label></th><td><input id="toll-server-key" name="toll_gate[server_key]" type="password" class="regular-text code" autocomplete="off" value=""<?php echo toll_gate_server_key() !== '' ? ' placeholder="••••••••••••••••"' : ''; ?>>
<p class="description"><?php echo esc_html(toll_gate_s('server_key_help')); ?></p></td></tr>
<tr><th scope="row"><?php echo esc_html(toll_gate_s('fee_h')); ?></th><td><?php echo esc_html(Settlement::fillFee(toll_gate_s('fee_line'), (int) $p['fee_bps'])); ?> <span class="toll-muted"><?php echo esc_html(toll_gate_s('fee_note')); ?></span></td></tr>
<tr><th scope="row"><label for="toll-invoice"><?php echo esc_html(toll_gate_s('withdraw')); ?></label></th><td><textarea id="toll-invoice" name="toll_gate_invoice" class="large-text code" rows="3"<?php echo $usd !== null && !$wd_off ? ' placeholder="' . esc_attr(sprintf(toll_gate_s('withdraw_ph'), $usd)) . '"' : ''; ?><?php echo $wd_off ? ' disabled' : ''; ?>></textarea><br>
<button id="toll-withdraw" class="button" type="submit" name="toll_gate_do" value="withdraw"<?php echo $wd_off ? ' disabled' : ''; ?>><?php echo esc_html(toll_gate_s('withdraw')); ?></button>
<p class="description"><?php echo esc_html(toll_gate_s('withdraw_help')); ?></p></td></tr>
</tbody></table></div></details>

<p class="submit"><button class="button button-primary" type="submit" name="toll_gate_do" value="save"><?php echo esc_html(toll_gate_s('save')); ?></button></p>
</form>
</div>
</div>
    <?php
}
