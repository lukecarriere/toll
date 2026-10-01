<?php
// Visitor network vectors (docs/net-vectors.json) on the WordPress plugin's PHP: the coarse network
// matches Node's coarseNet for every address, and the client address follows TOLL_TRUSTED_PROXIES.
// Run: php tests/php/run-net-vectors.php   (--json prints [input, output] pairs for the Node test)
declare(strict_types=1);
const ABSPATH = '/';
require __DIR__ . '/../../packages/wp-toll-gate/includes/network.php';

/** $_SERVER for a client_ip vector: xff null means no X-Forwarded-For header at all ("" is an empty one). */
function vector_server(array $c): array
{
    return ['REMOTE_ADDR' => $c['remote']] + ($c['xff'] !== null ? ['HTTP_X_FORWARDED_FOR' => $c['xff']] : []);
}

$v = json_decode(file_get_contents(__DIR__ . '/../../docs/net-vectors.json'), true, 512, JSON_THROW_ON_ERROR);
if (in_array('--json', $argv, true)) {
    $out = ['coarse_net' => [], 'client_ip' => []];
    foreach ($v['coarse_net'] as [$ip, $_]) $out['coarse_net'][] = [$ip, toll_gate_coarse_net($ip)];
    foreach ($v['client_ip'] as $c) {
        $ip = toll_gate_client_ip(vector_server($c), toll_gate_parse_proxies($c['trusted']));
        $out['client_ip'][] = [$c['name'], $ip, toll_gate_coarse_net($ip)];
    }
    echo json_encode($out, JSON_UNESCAPED_SLASHES);
    exit(0);
}

$pass = 0;
$fail = 0;
function check(bool $ok, string $name): void
{
    global $pass, $fail;
    if ($ok) { $pass++; echo "ok   $name\n"; } else { $fail++; echo "FAIL $name\n"; }
}

foreach ($v['coarse_net'] as [$ip, $want]) {
    $got = toll_gate_coarse_net($ip);
    check($got === $want, 'coarse net ' . json_encode($ip) . ' -> ' . json_encode($want) . ($got === $want ? '' : ' (got ' . json_encode($got) . ')'));
}
foreach ($v['client_ip'] as $c) {
    $got = toll_gate_client_ip(vector_server($c), toll_gate_parse_proxies($c['trusted']));
    $net = toll_gate_coarse_net($got);
    $ok = $got === $c['expect'] && $net === $c['expect_net'];
    check($ok, 'client address: ' . $c['name'] . ($ok ? '' : ' (got ' . json_encode([$got, $net]) . ')'));
}
// The constant itself: unset here, so X-Forwarded-For is never read.
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['HTTP_X_FORWARDED_FOR'] = '203.0.113.9';
check(!defined('TOLL_TRUSTED_PROXIES') && toll_gate_trusted_proxies() === [] && toll_gate_client_ip() === '127.0.0.1' && toll_gate_visitor_net() === '127.0.0.0/24', 'TOLL_TRUSTED_PROXIES unset: REMOTE_ADDR only');

echo "\nPHP " . PHP_VERSION . ": $pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
