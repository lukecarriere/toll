<?php
// Remove everything the plugin stored: settings, keys, counters, the test ledger, and the
// replay and use-count rows.
declare(strict_types=1);

if (!defined('WP_UNINSTALL_PLUGIN')) exit;

foreach (['toll_gate_settings', 'toll_gate_site_key', 'toll_gate_secret', 'toll_gate_server_key', 'toll_gate_counters', 'toll_gate_test_ledger'] as $o) delete_option($o);
global $wpdb;
$wpdb->query("DELETE FROM {$wpdb->options} WHERE option_name LIKE 'toll\\_gate\\_c\\_%' OR option_name LIKE 'toll\\_gate\\_u\\_%'");
wp_clear_scheduled_hook('toll_gate_cleanup');
