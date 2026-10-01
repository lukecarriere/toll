<?php
// Runs the WordPress plugin's discovery code (includes/discovery.php) under PHP-CLI with a few
// WordPress stubs, no WordPress install needed. Used by tests/site-url.test.ts and by
// tests/discovery-docs.ts to make the 23108ec golden documents.
//   php tests/php/run-discovery.php serve <plugin_dir> <autoload> <paid|work> <toll.json|agents.json> [<TOLL_SITE_URL as JSON>]
//     prints the exact body toll_gate_discovery_serve() sends for that path (it ends with exit).
//     The constant is defined only when the last argument is given (JSON, so a non-string can be tried).
//   php tests/php/run-discovery.php parse <plugin_dir>     reads a JSON array of raw values on stdin and
//     prints [[url, error], ...] from toll_gate_parse_site_url().
//   php tests/php/run-discovery.php pattern <plugin_dir>   prints TOLL_GATE_SITE_URL_RE.
declare(strict_types=1);

const ABSPATH = '/';
[$_, $mode, $plugin] = $argv + [null, null, null];
if (!in_array($mode, ['serve', 'parse', 'pattern'], true) || !is_dir((string) $plugin)) {
    fwrite(STDERR, "usage: run-discovery.php serve|parse|pattern <plugin_dir> ...\n");
    exit(2);
}

$GLOBALS['toll_test_paid'] = ($argv[4] ?? 'work') === 'paid';
$GLOBALS['toll_test_logged'] = [];
function home_url(string $path = ''): string { return 'https://wp.test/' . ltrim($path, '/'); }
function rest_url(string $path = ''): string { return 'https://wp.test/wp-json/' . ltrim($path, '/'); }
function untrailingslashit(string $s): string { return rtrim($s, '/\\'); }
function wp_parse_url(string $url, int $component = -1) { return parse_url($url, $component); }
function wp_json_encode($data, int $options = 0, int $depth = 512) { return json_encode($data, $options, $depth); }
function status_header(int $code): void {}
function toll_gate_count(string $name, int $n = 1): void {}
function toll_gate_lib_ok(): bool { return true; }
function toll_gate_offers_configured(): bool { return $GLOBALS['toll_test_paid']; }
function toll_gate_server_call(...$a) { return null; }
// The payment server's /v1/owner/price?net=1 answer, as cached by the plugin (fixed test rate, no load pricing).
function get_transient(string $k)
{
    if ($k !== 'toll_gate_price_cache') return false;
    $p = ['search' => 2000, 'write' => 10000, 'account' => 25000, 'admin' => 100000];
    return ['net_declared' => true, 'status' => 'test', 'prices' => array_map(fn($m) => ['amount_msat' => $m], $p), 'load_pricing' => array_map(fn() => false, $p), 'fx' => ['usd_per_btc' => 100000, 'fetched_at' => time()]];
}
function set_transient(...$a): bool { return true; }

if ($mode === 'serve') {
    require $argv[3];
    if (isset($argv[6])) define('TOLL_SITE_URL', json_decode($argv[6], true, 8, JSON_THROW_ON_ERROR));
    require $plugin . '/includes/discovery.php';
    $_SERVER['REQUEST_METHOD'] = 'GET';
    $_SERVER['REQUEST_URI'] = '/.well-known/' . $argv[5];
    toll_gate_discovery_serve();
    fwrite(STDERR, "not served: " . $argv[5] . "\n");
    exit(1);
}
require $plugin . '/includes/discovery.php';
if ($mode === 'pattern') {
    echo TOLL_GATE_SITE_URL_RE;
    exit(0);
}
$in = json_decode((string) stream_get_contents(STDIN), true, 8, JSON_THROW_ON_ERROR);
echo json_encode(array_map('toll_gate_parse_site_url', $in), JSON_UNESCAPED_SLASHES);
