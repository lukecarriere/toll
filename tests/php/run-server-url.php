<?php
// Payment server address from the settings form. esc_url_raw keeps a percent-encoded path.
// sanitize_text_field would delete %xx, which is why toll_gate_clean_server_url must not call it.
// Run: php tests/php/run-server-url.php
declare(strict_types=1);

$pass = 0;
$fail = 0;
function check(bool $ok, string $name, $info = null): void
{
    global $pass, $fail;
    $ok ? $pass++ : $fail++;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . ($ok || $info === null ? '' : "\n     " . json_encode($info, JSON_UNESCAPED_SLASHES)) . "\n";
}

define('ABSPATH', '/');
$sanitized = 0;
function wp_unslash($v) { return is_string($v) ? stripslashes($v) : $v; }
function sanitize_text_field($s): string
{
    global $sanitized;
    $sanitized++;
    $s = (string) $s;
    while (preg_match('/%[a-f0-9]{2}/i', $s, $m)) $s = str_replace($m[0], '', $s);
    return trim($s);
}
// WordPress 7.1.4 esc_url_raw, for the cases this file cares about. A schemeless string is
// rewritten to http:// (a space becomes %20): "not a url" becomes "http://not%20a%20url".
// toll_gate_clean_server_url rejects that before calling this, which is why the stored value
// stays empty. tests/wp-server-url.test.ts checks the same strings against core esc_url_raw.
function esc_url_raw(string $url, ?array $protocols = null): string
{
    if ($url === '') return '';
    $url = str_replace(' ', '%20', ltrim($url));
    $url = preg_replace('|[^a-z0-9-~+_.?#=!&;,/:%@$\|*\'()\[\]\\x80-\\xff]|i', '', $url) ?? '';
    if ($url === '') return '';
    if (!str_contains($url, ':') && !in_array($url[0], ['/', '#', '?'], true) && !preg_match('/^[a-z0-9-]+?\.php/i', $url)) {
        $url = 'http://' . $url;
    }
    if (!preg_match('#^([a-z0-9+.-]+):#i', $url, $m)) return '';
    $allowed = $protocols ?? ['http', 'https'];
    return in_array(strtolower($m[1]), array_map('strtolower', $allowed), true) ? $url : '';
}

require dirname(__DIR__, 2) . '/packages/wp-toll-gate/includes/admin.php';

$kept = 'https://pay.example.com/owner%2Fapi';
check(toll_gate_clean_server_url($kept) === $kept, 'percent-encoded path is kept', toll_gate_clean_server_url($kept));
check($sanitized === 0, 'sanitize_text_field is not used on the payment server URL', $sanitized);
check(toll_gate_clean_server_url('https://pay.example.com/a%20b') === 'https://pay.example.com/a%20b', 'percent-encoded space is kept');
check(toll_gate_clean_server_url('http://127.0.0.1:8787') === 'http://127.0.0.1:8787', 'plain loopback URL is kept');
check(toll_gate_clean_server_url('  https://pay.example.com/v1  ') === 'https://pay.example.com/v1', 'surrounding whitespace is trimmed');
check(toll_gate_clean_server_url('javascript:alert(1)') === '', 'a non-http scheme is dropped');
check(esc_url_raw('not a url', ['http', 'https']) === 'http://not%20a%20url', 'WordPress rewrites a schemeless string to http://not%20a%20url');
check(toll_gate_clean_server_url('not a url') === '', 'the scheme check drops that rewritten URL');
check(esc_url_raw('pay.example.com', ['http', 'https']) === 'http://pay.example.com', 'WordPress prepends http:// to a schemeless host');
check(toll_gate_clean_server_url('pay.example.com') === '', 'a schemeless address is dropped before that rewrite');
check(toll_gate_clean_server_url('') === '', 'empty stays empty');
check(sanitize_text_field($kept) === 'https://pay.example.com/ownerapi', 'the text-field sanitizer would have changed this URL');

$src = file_get_contents(dirname(__DIR__, 2) . '/packages/wp-toll-gate/includes/admin.php');
check(is_string($src) && str_contains($src, "\$s['server_url'] = toll_gate_clean_server_url(\$posted_url);"), 'settings save stores the URL from toll_gate_clean_server_url');

echo "\nPHP " . PHP_VERSION . " server url: $pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
