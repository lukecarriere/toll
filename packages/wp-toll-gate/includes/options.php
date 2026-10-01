<?php
// Settings, keys and defaults (design/HANDOFF.md §3.2).
declare(strict_types=1);

if (!defined('ABSPATH')) exit;

const TOLL_GATE_DEFAULTS = [
    'forms' => ['comments' => 1, 'login' => 1, 'register' => 0, 'lostpassword' => 0, 'woo' => 0, 'cf7' => 0],
    'visible_check' => 0,
    'longest_s' => 8,
    'payouts' => 0,
    'connection' => 'test',
    'server_url' => '',
];

function toll_gate_settings(): array
{
    $s = get_option('toll_gate_settings', []);
    $s = is_array($s) ? $s : [];
    $out = array_merge(TOLL_GATE_DEFAULTS, $s);
    $out['forms'] = array_merge(TOLL_GATE_DEFAULTS['forms'], is_array($s['forms'] ?? null) ? $s['forms'] : []);
    return $out;
}

function toll_gate_update_settings(array $s): void
{
    update_option('toll_gate_settings', $s, true);
}

function toll_gate_ensure_keys(): void
{
    if (!get_option('toll_gate_site_key')) update_option('toll_gate_site_key', 'site_' . bin2hex(random_bytes(4)), true);
    if (!get_option('toll_gate_secret')) update_option('toll_gate_secret', bin2hex(random_bytes(24)), true);
}

function toll_gate_site_key(): string
{
    toll_gate_ensure_keys();
    return (string) get_option('toll_gate_site_key');
}

function toll_gate_secret(): string
{
    toll_gate_ensure_keys();
    return (string) get_option('toll_gate_secret');
}

function toll_gate_new_secret(): void
{
    update_option('toll_gate_secret', bin2hex(random_bytes(24)), true);
}

/** The payment server key is kept out of autoloaded options and never printed into a page. */
function toll_gate_server_key(): string
{
    return (string) get_option('toll_gate_server_key', '');
}

function toll_gate_woo_active(): bool
{
    return class_exists('WooCommerce');
}

function toll_gate_cf7_active(): bool
{
    return defined('WPCF7_VERSION');
}
