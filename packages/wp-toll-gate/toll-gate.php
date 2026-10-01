<?php
/**
 * Plugin Name: Toll
 * Description: Invisible checks for forms, logins, and write APIs.
 * Version: 0.1.0
 * Requires at least: 6.5
 * Requires PHP: 8.1
 * License: GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: toll-gate
 */
// toll-gate (spec §13). Protects comments, login and any form with data-toll using an invisible
// background check, verified on this server. The default issuer is this site
// (/wp-json/toll/v1/*): no calls to any outside service unless the owner sets a payment server
// address for usage payouts. Fails closed: a protected form without a valid pass is rejected.
declare(strict_types=1);

if (!defined('ABSPATH')) exit;

define('TOLL_GATE_VERSION', '0.1.0');
define('TOLL_GATE_FILE', __FILE__);
define('TOLL_GATE_DIR', __DIR__);

require_once __DIR__ . '/includes/lib.php';
require_once __DIR__ . '/includes/strings.php';
require_once __DIR__ . '/includes/options.php';
require_once __DIR__ . '/includes/counters.php';
require_once __DIR__ . '/includes/store.php';
require_once __DIR__ . '/includes/issuer.php';
require_once __DIR__ . '/includes/gate.php';
require_once __DIR__ . '/includes/payouts.php';
require_once __DIR__ . '/includes/discovery.php';
require_once __DIR__ . '/includes/admin.php';

register_activation_hook(__FILE__, 'toll_gate_activate');
register_deactivation_hook(__FILE__, 'toll_gate_deactivate');

function toll_gate_activate(): void
{
    toll_gate_ensure_keys();
    toll_gate_counting_since();
    if (!wp_next_scheduled('toll_gate_cleanup')) wp_schedule_event(time() + 3600, 'hourly', 'toll_gate_cleanup');
}

function toll_gate_deactivate(): void
{
    wp_clear_scheduled_hook('toll_gate_cleanup');
}

add_action('toll_gate_cleanup', 'toll_gate_store_cleanup');
add_action('toll_gate_cleanup', 'toll_gate_counters_cleanup');
add_action('rest_api_init', 'toll_gate_register_routes');
add_action('init', 'toll_gate_init_gate');
add_action('init', 'toll_gate_discovery_serve', 0);
if (is_admin()) toll_gate_admin_init();
