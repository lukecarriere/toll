<?php
// The WordPress plugin's uninstall.php under PHP-CLI with a stubbed options table and transient
// store: every option, counter row and transient the plugin writes is gone afterwards, and nothing
// else is touched. The transients to seed are read from the plugin's own set_transient() calls, so
// a new transient that uninstall.php misses fails here. Run: php tests/php/run-uninstall.php
declare(strict_types=1);

const PLUGIN = __DIR__ . '/../../packages/wp-toll-gate';
define('WP_UNINSTALL_PLUGIN', 'toll-gate/toll-gate.php');

$pass = 0;
$fail = 0;
function check(bool $ok, string $name, $info = null): void
{
    global $pass, $fail;
    $ok ? $pass++ : $fail++;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . ($ok || $info === null ? '' : "\n     " . json_encode($info, JSON_UNESCAPED_SLASHES)) . "\n";
}

// ---- stubs: the options table, WordPress's transient API on top of it, an optional object cache --
$GLOBALS['opts'] = [];
$GLOBALS['cache'] = null; // array when a persistent object cache holds the transients
$GLOBALS['calls'] = [];
function delete_option(string $o): bool { $GLOBALS['calls'][] = "delete_option:$o"; $had = array_key_exists($o, $GLOBALS['opts']); unset($GLOBALS['opts'][$o]); return $had; }
function set_transient(string $k, $v, int $ttl = 0): bool
{
    if (is_array($GLOBALS['cache'])) { $GLOBALS['cache'][$k] = $v; return true; }
    $GLOBALS['opts']['_transient_' . $k] = $v;
    if ($ttl) $GLOBALS['opts']['_transient_timeout_' . $k] = time() + $ttl;
    return true;
}
function delete_transient(string $k): bool
{
    $GLOBALS['calls'][] = "delete_transient:$k";
    if (is_array($GLOBALS['cache'])) { $had = array_key_exists($k, $GLOBALS['cache']); unset($GLOBALS['cache'][$k]); return $had; }
    $had = array_key_exists('_transient_' . $k, $GLOBALS['opts']);
    unset($GLOBALS['opts']['_transient_' . $k], $GLOBALS['opts']['_transient_timeout_' . $k]);
    return $had;
}
function wp_clear_scheduled_hook(string $h): int { $GLOBALS['calls'][] = "clear_hook:$h"; return 1; }
/** Only what uninstall.php sends: DELETE FROM <options> WHERE option_name LIKE '…' [OR …]. */
final class StubWpdb
{
    public string $options = 'wp_options';
    public array $queries = [];
    public function query(string $sql)
    {
        $this->queries[] = $sql;
        if (!preg_match('/^DELETE FROM wp_options WHERE (.+)$/s', $sql, $m)) throw new RuntimeException("unexpected SQL: $sql");
        $res = [];
        foreach (preg_split('/\s+OR\s+/', trim($m[1])) as $cond) {
            if (!preg_match("/^option_name LIKE '((?:[^'\\\\]|\\\\.)*)'$/", $cond, $c)) throw new RuntimeException("unexpected condition: $cond");
            $res[] = '/^' . preg_replace_callback('/\\\\(.)|%|_|[^\\\\%_]+/s', fn ($t) => isset($t[1]) && $t[1] !== '' ? preg_quote($t[1], '/') : ($t[0] === '%' ? '.*' : ($t[0] === '_' ? '.' : preg_quote($t[0], '/'))), $c[1]) . '$/s';
        }
        $n = 0;
        foreach (array_keys($GLOBALS['opts']) as $o) {
            foreach ($res as $re) if (preg_match($re, (string) $o)) { unset($GLOBALS['opts'][$o]); $n++; break; }
        }
        return $n;
    }
}

// ---- the plugin's transients, read from its code -------------------------------------------------
$fixed = [];
$prefixes = [];
foreach (glob(PLUGIN . '/includes/*.php') as $f) {
    $src = (string) file_get_contents($f);
    preg_match_all("/set_(?:site_)?transient\(\s*'([a-z0-9_]+)'\s*(\.)?/", $src, $m, PREG_SET_ORDER);
    foreach ($m as $x) empty($x[2]) ? $fixed[$x[1]] = true : $prefixes[$x[1]] = true;
    // A key built in a variable first: $key = 'prefix' . …; set_transient($key, …)
    if (preg_match_all("/\\\$key = '([a-z0-9_]+)' \./", $src, $k) && str_contains($src, 'set_transient($key')) foreach ($k[1] as $p) $prefixes[$p] = true;
}
// On be/site-url-followups only until it merges; uninstall.php deletes it by name regardless.
$fixed['toll_gate_site_url_warned'] = true;
$fixed = array_keys($fixed);
$prefixes = array_keys($prefixes);
sort($fixed);
sort($prefixes);
check($fixed === ['toll_gate_price_cache', 'toll_gate_server_down', 'toll_gate_site_url_warned'], 'transients with fixed names found in the plugin code', $fixed);
check($prefixes === ['toll_gate_notice_', 'toll_gate_rl_'], 'transients with per-key names found (rate limit per IP and minute, admin notice per user)', $prefixes);
check(!preg_match('/set_site_transient\(/', implode('', array_map('file_get_contents', glob(PLUGIN . '/includes/*.php')))), 'no site transients (nothing network-wide to delete on multisite)');

$options = ['toll_gate_settings', 'toll_gate_site_key', 'toll_gate_secret', 'toll_gate_server_key', 'toll_gate_counters', 'toll_gate_counting_since', 'toll_gate_test_ledger'];
$rows = ['toll_gate_c_20261002', 'toll_gate_u_' . md5('jti'), 'toll_gate_n_' . md5('nonce')];
$others = ['blogname' => 'Site', '_transient_doing_cron' => '1', '_transient_timeout_doing_cron' => time() + 60, '_transient_other_rl_x' => 1, '_transient_toll_gatekeeper_rl_x' => 1, 'my_toll_gate_c_1' => 1, 'toll_gate_c' => 1];

/** Seeds every option, row and transient, runs uninstall.php, returns what is left. */
function run_uninstall(array $options, array $rows, array $others, array $fixed, array $prefixes, bool $objectCache): array
{
    $GLOBALS['opts'] = $others;
    $GLOBALS['cache'] = $objectCache ? [] : null;
    $GLOBALS['calls'] = [];
    $GLOBALS['wpdb'] = new StubWpdb();
    foreach ($options as $o) $GLOBALS['opts'][$o] = 'x';
    foreach ($rows as $o) $GLOBALS['opts'][$o] = 1;
    foreach ($fixed as $t) set_transient($t, 1, 3600);
    foreach ($prefixes as $p) {
        set_transient($p . md5('a'), 1, 120);
        set_transient($p . '7', ['kind' => 'ok'], 60);
    }
    // An expired rate-limit row that WordPress hasn't swept yet.
    if (!$objectCache) { $GLOBALS['opts']['_transient_toll_gate_rl_' . md5('old')] = 9; $GLOBALS['opts']['_transient_timeout_toll_gate_rl_' . md5('old')] = time() - 600; }
    include PLUGIN . '/uninstall.php';
    return ['opts' => $GLOBALS['opts'], 'cache' => $GLOBALS['cache'], 'calls' => $GLOBALS['calls']];
}

$r = run_uninstall($options, $rows, $others, $fixed, $prefixes, false);
$left = array_keys($r['opts']);
check(array_intersect($options, $left) === [], 'options deleted as before', $left);
check(array_intersect($rows, $left) === [], 'counter, use-count and replay rows deleted as before', $left);
check(in_array('clear_hook:toll_gate_cleanup', $r['calls'], true), 'the cleanup event is unscheduled as before');
$t = array_values(array_filter($left, fn ($o) => str_starts_with($o, '_transient_toll_gate_') || str_starts_with($o, '_transient_timeout_toll_gate_')));
check($t === [], 'options table: every toll_gate transient and timeout row is gone, expired ones included', $t);
foreach ($fixed as $name) check(in_array("delete_transient:$name", $r['calls'], true), "delete_transient('$name') is called");
check($r['opts'] === $others, 'nothing else is touched (other plugins, look-alike names, WordPress)', $r['opts']);

$r = run_uninstall($options, $rows, $others, $fixed, $prefixes, true);
$gone = array_values(array_intersect($fixed, array_keys($r['cache'])));
check($gone === [], 'persistent object cache: the fixed-name transients are gone', $gone);
check(array_intersect($options, array_keys($r['opts'])) === [] && $r['opts'] === $others, 'persistent object cache: options deleted, nothing else touched', $r['opts']);

echo "\nPHP " . PHP_VERSION . " uninstall: $pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
