<?php
// Remove everything the plugin stored: settings, keys, daily counter rows, the test ledger,
// the replay and use-count rows, and its transients.
declare(strict_types=1);

if (!defined('WP_UNINSTALL_PLUGIN')) exit;

foreach (['toll_gate_settings', 'toll_gate_site_key', 'toll_gate_secret', 'toll_gate_server_key', 'toll_gate_counters', 'toll_gate_counting_since', 'toll_gate_test_ledger'] as $toll_gate_option) delete_option($toll_gate_option);
global $wpdb;
$wpdb->query("DELETE FROM {$wpdb->options} WHERE option_name LIKE 'toll\\_gate\\_c\\_%' OR option_name LIKE 'toll\\_gate\\_u\\_%' OR option_name LIKE 'toll\\_gate\\_n\\_%'"); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- bulk delete by name prefix on uninstall; no API lists these rows

// Transients with fixed names, by name, so a persistent object cache drops them too:
// the payment server's price cache, the server-down flag, and the once-an-hour invalid
// TOLL_SITE_URL warning (deleting one that was never set is harmless).
foreach (['toll_gate_price_cache', 'toll_gate_server_down', 'toll_gate_site_url_warned'] as $toll_gate_transient) delete_transient($toll_gate_transient);
// Transients with per-key names: the per-IP, per-minute challenge rate limit
// (toll_gate_rl_<md5>) and the per-user admin notice (toll_gate_notice_<user id>). Stored in
// the options table, they stay there after they expire, so their rows (and timeout rows) are
// deleted by prefix. With a persistent object cache they can't be listed, but they last at
// most 120 and 60 seconds.
$wpdb->query("DELETE FROM {$wpdb->options} WHERE option_name LIKE '\\_transient\\_toll\\_gate\\_rl\\_%' OR option_name LIKE '\\_transient\\_timeout\\_toll\\_gate\\_rl\\_%' OR option_name LIKE '\\_transient\\_toll\\_gate\\_notice\\_%' OR option_name LIKE '\\_transient\\_timeout\\_toll\\_gate\\_notice\\_%'"); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- bulk delete by name prefix on uninstall; no API lists these rows

wp_clear_scheduled_hook('toll_gate_cleanup');
