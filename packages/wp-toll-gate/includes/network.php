<?php
// The visitor's coarse network, for load pricing on a payment server (docs/protocol.md, owner API).
// Only the network is ever sent: "a.b.c.0/24" for IPv4 or the first three hextets plus "::/48" for
// IPv6, the same value the Node issuer keys its velocity window on (coarseKey in
// packages/protocol/src/policy.ts; docs/net-vectors.json pins the two to the same output). It is
// computed per request and never stored, logged or cached here.
//
// Which address is the visitor's: REMOTE_ADDR, unless the owner lists their reverse proxies in
// wp-config.php:
//     define('TOLL_TRUSTED_PROXIES', '10.0.0.0/8, 192.0.2.10, 2001:db8::/32');
// Then, only when REMOTE_ADDR is one of them, X-Forwarded-For is read right to left, skipping only
// listed proxies; the first entry that is not a listed proxy is the visitor's. If that entry is not a
// plain address ("unknown", empty, a port, brackets, junk), or there is no such entry (header missing,
// empty or only listed proxies), there is no visitor address and no net is sent: never the proxy's
// own address and never an entry further left. ::ffff:a.b.c.d counts as a.b.c.d everywhere. Unset or
// empty: X-Forwarded-For is never read. The challenge rate limit keeps using REMOTE_ADDR (toll_gate_ip()).
declare(strict_types=1);

if (!defined('ABSPATH')) exit;

const TOLL_GATE_OCTET = '(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)';

/** Network part of the Node coarseKey for one address, or null when it is not a plain IPv4 or IPv6 address. */
function toll_gate_coarse_net(mixed $ip): ?string
{
    if (!is_string($ip) || $ip === '' || strlen($ip) > 64) return null;
    $v4 = (string) preg_replace('/^::ffff:(?=\d+\.)/i', '', $ip);
    $o = TOLL_GATE_OCTET;
    if (preg_match("/^$o\\.$o\\.$o\\.$o\\z/", $v4)) {
        $p = explode('.', $v4);
        return $p[0] . '.' . $p[1] . '.' . $p[2] . '.0/24';
    }
    if (!preg_match('/^[0-9A-Fa-f:]+\z/', $ip)) return null;
    $halves = explode('::', $ip);
    if (count($halves) > 2) return null;
    $groups = fn(string $h): array => $h === '' ? [] : explode(':', $h);
    $head = $groups($halves[0]);
    $tail = count($halves) === 2 ? $groups($halves[1]) : [];
    foreach (array_merge($head, $tail) as $g) {
        if (!preg_match('/^[0-9A-Fa-f]{1,4}\z/', $g)) return null;
    }
    $n = count($head) + count($tail);
    if (count($halves) === 2 ? $n > 7 : $n !== 8) return null;
    $all = array_merge($head, array_fill(0, 8 - $n, '0'), $tail);
    $hex = array_map(fn(string $g): string => str_pad(strtolower($g), 4, '0', STR_PAD_LEFT), array_slice($all, 0, 3));
    return implode(':', $hex) . '::/48';
}

/** Packed address (4 or 16 bytes) for a plain IPv4 or IPv6 address; IPv4-mapped IPv6 counts as IPv4. null otherwise. */
function toll_gate_ip_bin(string $ip): ?string
{
    $ip = trim($ip);
    if (preg_match('/^::ffff:(\d+\.\d+\.\d+\.\d+)\z/i', $ip, $m)) $ip = $m[1];
    if (filter_var($ip, FILTER_VALIDATE_IP) === false) return null;
    $b = inet_pton($ip);
    return $b === false ? null : $b;
}

/** Parse a comma-separated list of addresses and CIDR ranges into [packed, prefix bits]; bad entries are dropped. */
function toll_gate_parse_proxies(string $raw): array
{
    $out = [];
    foreach (explode(',', $raw) as $e) {
        $e = trim($e);
        if ($e === '') continue;
        $parts = explode('/', $e, 2);
        $b = toll_gate_ip_bin($parts[0]);
        if ($b === null) continue;
        $max = strlen($b) * 8;
        if (!isset($parts[1])) {
            $bits = $max;
        } elseif (preg_match('/^\d{1,3}\z/', $parts[1]) && (int) $parts[1] <= $max) {
            $bits = (int) $parts[1];
        } else {
            continue;
        }
        $out[] = [$b, $bits];
    }
    return $out;
}

/** The owner's trusted proxies from the TOLL_TRUSTED_PROXIES constant ([] when unset or empty). */
function toll_gate_trusted_proxies(): array
{
    $raw = defined('TOLL_TRUSTED_PROXIES') ? constant('TOLL_TRUSTED_PROXIES') : '';
    return is_string($raw) && trim($raw) !== '' ? toll_gate_parse_proxies($raw) : [];
}

/** Whether an address falls in one of the parsed ranges. */
function toll_gate_ip_in(string $ip, array $ranges): bool
{
    $b = toll_gate_ip_bin($ip);
    if ($b === null) return false;
    foreach ($ranges as [$net, $bits]) {
        if (strlen($net) !== strlen($b)) continue;
        $whole = intdiv($bits, 8);
        if (substr($b, 0, $whole) !== substr($net, 0, $whole)) continue;
        $rest = $bits % 8;
        if ($rest === 0) return true;
        $mask = (0xff << (8 - $rest)) & 0xff;
        if ((ord($b[$whole]) & $mask) === (ord($net[$whole]) & $mask)) return true;
    }
    return false;
}

/**
 * The visitor's address for load pricing: REMOTE_ADDR, or with TOLL_TRUSTED_PROXIES set and
 * REMOTE_ADDR in it, the rightmost X-Forwarded-For entry that is not a listed proxy, as long as it is
 * a plain address. null (no net is sent) when that entry is not a plain address or there is none.
 * $server and $ranges default to $_SERVER and the constant (tests pass their own).
 */
function toll_gate_client_ip(?array $server = null, ?array $ranges = null): ?string
{
    $server ??= $_SERVER;
    $ranges ??= toll_gate_trusted_proxies();
    $remote = is_string($server['REMOTE_ADDR'] ?? null) ? trim($server['REMOTE_ADDR']) : '';
    if ($ranges === [] || !toll_gate_ip_in($remote, $ranges)) return $remote;
    $xff = $server['HTTP_X_FORWARDED_FOR'] ?? null;
    if (!is_string($xff) || strlen($xff) > 4096) return null;
    foreach (array_reverse(explode(',', $xff)) as $hop) {
        $hop = trim($hop);
        if (toll_gate_ip_in($hop, $ranges)) continue;
        return toll_gate_ip_bin($hop) === null ? null : $hop;
    }
    return null;
}

/** The visitor's coarse network to send with offers, redeems and quotes, or null (then nothing is sent). */
function toll_gate_visitor_net(): ?string
{
    return toll_gate_coarse_net(toll_gate_client_ip());
}
