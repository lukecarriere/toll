<?php
// Replay cache and pass use counts in the options table, using plain INSERT and conditional UPDATE
// so first use and decrements are atomic in the database (spec §9.4). Fail-safe (spec §16): any
// database error throws, and the caller rejects the write.
declare(strict_types=1);

if (!defined('ABSPATH')) exit;

final class Toll_Gate_Store_Error extends \RuntimeException {}

/** True the first time a challenge id is seen; false on a replay. */
function toll_gate_first_use(string $id, int $exp): bool
{
    global $wpdb;
    if (!preg_match('/^[0-9a-f]{32}$/', $id)) return false;
    $name = 'toll_gate_c_' . ($exp + 60) . '_' . $id;
    $wpdb->suppress_errors(true);
    $ok = $wpdb->query($wpdb->prepare("INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'off')", $name, '1'));
    $err = $wpdb->last_error;
    $wpdb->suppress_errors(false);
    if ($ok === 1) return true;
    // A duplicate key is a replay; anything else is a store failure.
    $exists = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name = %s", $name));
    if ($exists === null) throw new Toll_Gate_Store_Error(esc_html($err ?: 'store unavailable')); // never shown; the caller answers 'unavailable'
    return false;
}

/** Spend one use of a pass. Returns uses left after this one, or -1 when none were left. */
function toll_gate_consume(string $jti, int $n, int $exp): int
{
    global $wpdb;
    if (!preg_match('/^[0-9a-f]{32}$/', $jti)) return -1;
    $name = 'toll_gate_u_' . ($exp + 60) . '_' . $jti;
    $wpdb->suppress_errors(true);
    $wpdb->query($wpdb->prepare("INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'off')", $name, (string) $n));
    $wpdb->suppress_errors(false);
    $changed = $wpdb->query($wpdb->prepare("UPDATE {$wpdb->options} SET option_value = option_value - 1 WHERE option_name = %s AND (option_value + 0) > 0", $name));
    if ($changed === false) throw new Toll_Gate_Store_Error('store unavailable');
    $left = $wpdb->get_var($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $name));
    if ($left === null) throw new Toll_Gate_Store_Error('store unavailable');
    return $changed === 1 ? (int) $left : -1;
}

function toll_gate_uses_left(string $jti, int $n, int $exp): int
{
    global $wpdb;
    $v = $wpdb->get_var($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", 'toll_gate_u_' . ($exp + 60) . '_' . $jti));
    return $v === null ? $n : (int) $v;
}

/** Hourly: drop expired replay and use-count rows (the expiry is part of the row name). */
function toll_gate_store_cleanup(): void
{
    global $wpdb;
    $rows = $wpdb->get_col("SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE 'toll\\_gate\\_c\\_%' OR option_name LIKE 'toll\\_gate\\_u\\_%' LIMIT 5000");
    $now = time();
    foreach ((array) $rows as $name) {
        if (preg_match('/^toll_gate_[cu]_(\d+)_/', (string) $name, $m) && (int) $m[1] < $now) {
            $wpdb->delete($wpdb->options, ['option_name' => $name]);
        }
    }
}
