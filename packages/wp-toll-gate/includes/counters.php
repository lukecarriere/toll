<?php
// Counters with the same names as the Node issuer (docs/protocol.md §7), plus challenges_minted.
// One row per UTC day and counter in the options table (toll_gate_n_<YYYYMMDD>_<name>), bumped
// with a plain INSERT and a conditional UPDATE so concurrent requests never lose a count. Shown in
// admin and exported only when the owner clicks "Export counters". Nothing is sent anywhere.
declare(strict_types=1);

if (!defined('ABSPATH')) exit;

const TOLL_GATE_COUNTERS = ['pass_accept', 'pass_reject', 'pass_absent', 'turned_away', 'offer_shown', 'paid', 'work_after_402', 'challenges_minted'];
const TOLL_GATE_COUNTER_DAYS = 30;   // rows in the export
const TOLL_GATE_COUNTER_KEEP = 90;   // days kept before the hourly cleanup drops them

function toll_gate_counter_day(?int $t = null): string
{
    return gmdate('Ymd', $t ?? time());
}

/**
 * When counting started on this site (ISO 8601, UTC). Set on activation or on the first count.
 * Stored as a Unix time so no database layer reformats it.
 */
function toll_gate_counting_since(): string
{
    $v = get_option('toll_gate_counting_since');
    if (!is_numeric($v)) {
        if ($v !== false) delete_option('toll_gate_counting_since');
        add_option('toll_gate_counting_since', (string) time(), '', false);
        $v = get_option('toll_gate_counting_since');
    }
    return gmdate('Y-m-d\TH:i:s\Z', (int) $v);
}

function toll_gate_count(string $name, int $by = 1): void
{
    global $wpdb;
    if (!in_array($name, TOLL_GATE_COUNTERS, true) || $by < 1) return;
    toll_gate_counting_since();
    $row = 'toll_gate_n_' . toll_gate_counter_day() . '_' . $name;
    $wpdb->suppress_errors(true);
    $wpdb->query($wpdb->prepare("INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'off')", $row, '0'));
    $wpdb->query($wpdb->prepare("UPDATE {$wpdb->options} SET option_value = option_value + %d WHERE option_name = %s", $by, $row));
    $wpdb->suppress_errors(false);
}

/**
 * Counts per UTC day for the last $days days, oldest first: ['YYYY-MM-DD' => [name => int]].
 * Days with no rows are present with zeros.
 */
function toll_gate_counters_by_day(int $days = TOLL_GATE_COUNTER_DAYS, ?int $now = null): array
{
    global $wpdb;
    $now ??= time();
    $out = [];
    for ($i = $days - 1; $i >= 0; $i--) {
        $out[gmdate('Y-m-d', $now - $i * 86400)] = array_fill_keys(TOLL_GATE_COUNTERS, 0);
    }
    $first = 'toll_gate_n_' . gmdate('Ymd', $now - ($days - 1) * 86400) . '_';
    $rows = $wpdb->get_results($wpdb->prepare("SELECT option_name, option_value FROM {$wpdb->options} WHERE option_name >= %s AND option_name < %s", $first, 'toll_gate_n_99999999'), ARRAY_A);
    foreach ((array) $rows as $r) {
        if (!preg_match('/^toll_gate_n_(\d{4})(\d{2})(\d{2})_([a-z_0-9]+)$/', (string) $r['option_name'], $m)) continue;
        $d = "$m[1]-$m[2]-$m[3]";
        if (isset($out[$d]) && in_array($m[4], TOLL_GATE_COUNTERS, true)) $out[$d][$m[4]] = (int) $r['option_value'];
    }
    return $out;
}

/** Today's counts (UTC day), for the settings page. */
function toll_gate_counters_today(): array
{
    $d = toll_gate_counters_by_day(1);
    return reset($d);
}

/**
 * CSV for the owner: one row per UTC day for the last 30 days, oldest first. Columns: date,
 * timezone (always UTC), the Node counter names, challenges_minted, since (when counting started)
 * and exported_at, both ISO 8601 in UTC.
 */
function toll_gate_counters_csv(?int $now = null): string
{
    $now ??= time();
    $since = toll_gate_counting_since();
    $at = gmdate('Y-m-d\TH:i:s\Z', $now);
    $lines = [implode(',', array_merge(['date', 'timezone'], TOLL_GATE_COUNTERS, ['since', 'exported_at']))];
    foreach (toll_gate_counters_by_day(TOLL_GATE_COUNTER_DAYS, $now) as $day => $c) {
        $lines[] = implode(',', array_merge([$day, 'UTC'], array_map('strval', array_values($c)), [$since, $at]));
    }
    return implode("\r\n", $lines) . "\r\n";
}

/** Hourly: drop day rows older than the keep window. */
function toll_gate_counters_cleanup(): void
{
    global $wpdb;
    $cut = 'toll_gate_n_' . gmdate('Ymd', time() - TOLL_GATE_COUNTER_KEEP * 86400) . '_';
    $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name LIKE %s AND option_name < %s", 'toll\\_gate\\_n\\_%', $cut));
}
