<?php
// Counters with the same names as the Node issuer (docs/protocol.md §7), stored locally in one
// option and shown in admin. Exported only when the owner clicks "Export counters".
declare(strict_types=1);

if (!defined('ABSPATH')) exit;

const TOLL_GATE_COUNTERS = ['pass_accept', 'pass_reject', 'pass_absent', 'turned_away', 'offer_shown', 'paid', 'work_after_402'];

function toll_gate_counters(): array
{
    $c = get_option('toll_gate_counters', []);
    $c = is_array($c) ? $c : [];
    $out = [];
    foreach (TOLL_GATE_COUNTERS as $k) $out[$k] = (int) ($c[$k] ?? 0);
    $today = wp_date('Y-m-d');
    $out['day'] = (string) ($c['day'] ?? $today);
    $out['challenges_today'] = $out['day'] === $today ? (int) ($c['challenges_today'] ?? 0) : 0;
    $out['day'] = $today;
    return $out;
}

function toll_gate_count(string $name, int $by = 1): void
{
    $c = toll_gate_counters();
    if (!array_key_exists($name, $c)) return;
    $c[$name] += $by;
    update_option('toll_gate_counters', $c, false);
}

/** CSV with exactly the Node counter names as columns, one row of totals. */
function toll_gate_counters_csv(): string
{
    $c = toll_gate_counters();
    $row = array_map(fn ($k) => (string) $c[$k], TOLL_GATE_COUNTERS);
    return implode(',', TOLL_GATE_COUNTERS) . "\r\n" . implode(',', $row) . "\r\n";
}
