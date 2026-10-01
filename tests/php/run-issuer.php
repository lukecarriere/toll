<?php
// PHP issuer pieces used by the WordPress plugin (packages/server-php): mintChallenge, newPassClaims
// and Policy. Run: php tests/php/run-issuer.php        (self-checks)
//                  php tests/php/run-issuer.php --json (fixtures for tests/php-issuer.test.ts,
//                                                       which checks them against the Node side)
//                  php tests/php/run-issuer.php --verify < {challenge, solution, now}
declare(strict_types=1);
require __DIR__ . '/../../packages/server-php/vendor/autoload.php';

use Toll\Policy;
use Toll\Protocol;
use Toll\TollError;

$secret = 'php-issuer-test-secret-0123456789';
$site = 'site_test';
$now = time();

if (in_array('--verify', $argv, true)) {
    // {challenge, solution, now} on stdin -> {"ok": bool, "code": string|null}
    $in = json_decode((string) stream_get_contents(STDIN), true);
    try {
        Protocol::verifySolution($secret, $in['challenge'], $in['solution'], (int) $in['now'], $site);
        echo json_encode(['ok' => true, 'code' => null]);
    } catch (TollError $e) {
        echo json_encode(['ok' => false, 'code' => $e->codeName]);
    }
    exit(0);
}

if (in_array('--json', $argv, true)) {
    $table = [];
    foreach (['search', 'write', 'account', 'admin'] as $a) foreach (['desktop', 'mobile'] as $d) foreach (['standard', 'hardened'] as $m) $table["$a|$d|$m"] = Policy::workParams($a, $d, $m);
    $c = Protocol::mintChallenge($secret, $site, 'write', '/wp-comments-post.php', ['alg' => 'pbkdf2-sha256', 'cost' => 500, 'counter_max' => 64], 120, $now);
    $claims = Protocol::newPassClaims($site, 'write', 20, 900, $now);
    echo json_encode(['secret' => $secret, 'site' => $site, 'now' => $now, 'policy' => $table, 'challenge' => $c, 'pass' => Protocol::signPass($secret, $claims), 'claims' => $claims]);
    exit(0);
}

$pass = 0;
$fail = 0;
function check(bool $ok, string $name): void
{
    global $pass, $fail;
    if ($ok) { $pass++; echo "ok   $name\n"; } else { $fail++; echo "FAIL $name\n"; }
}
function throws(callable $f, string $code): bool
{
    try { $f(); return false; } catch (TollError $e) { return $e->codeName === $code; }
}

/** Find the hidden counter the way a client would, with the engine's own solver. */
function solve(array $work): array
{
    $alg = $work['parameters']['algorithm'] === 'ARGON2ID' ? new \AltchaOrg\Altcha\Algorithm\Argon2id() : new \AltchaOrg\Altcha\Algorithm\Pbkdf2();
    $engine = new \AltchaOrg\Altcha\Altcha('unused-for-solving');
    $sol = $engine->solveChallenge(new \AltchaOrg\Altcha\SolveChallengeOptions(\AltchaOrg\Altcha\Challenge::fromArray($work), $alg));
    if ($sol === null) throw new RuntimeException('no solution');
    return ['counter' => $sol->counter, 'derivedKey' => $sol->derivedKey];
}

// Policy: same numbers as packages/protocol workParams (adaptive off) and docs/policy.md.
$w = Policy::workParams('write', 'desktop');
check($w['alg'] === 'pbkdf2-sha256' && $w['cost'] === 5000 && $w['counter_max'] === 512 && $w['expected_tries'] === 256.5, 'policy: standard desktop write = 512 tries max');
check(Policy::workParams('write', 'mobile')['counter_max'] === 307, 'policy: mobile write is 0.6x');
check(Policy::workParams('admin', 'desktop')['counter_max'] === 1792, 'policy: admin is capped at max_units');
$h = Policy::workParams('write', 'desktop', 'hardened');
check($h['alg'] === 'argon2id' && $h['counter_max'] === 32 && $h['memory_kib'] === 19456, 'policy: hardened write');
check(throws(fn () => Policy::workParams('read', 'desktop'), 'malformed'), 'policy: read is free');
check(Policy::uaClass('Mozilla/5.0 (Linux; Android 14) Mobile') === 'mobile' && Policy::uaClass('Mozilla/5.0 (X11; Linux x86_64)') === 'desktop' && Policy::uaClass(null) === 'desktop', 'policy: device class from the user agent');

// mint -> solve -> verify, and the envelope binds what the plugin relies on.
$c = Protocol::mintChallenge($secret, $site, 'write', '/wp-comments-post.php', ['alg' => 'pbkdf2-sha256', 'cost' => 500, 'counter_max' => 64], 120, $now);
check($c['v'] === 1 && preg_match('/^[0-9a-f]{32}$/', $c['id']) === 1 && $c['exp'] === $now + 120 && $c['bound'] === ['action' => 'write', 'path_prefix' => '/wp-comments-post.php'], 'mint: envelope shape');
check($c['work']['parameters']['data']['tid'] === $c['id'], 'mint: engine payload bound to the Toll id');
$sol = solve($c['work']);
check($sol['counter'] < 64, 'mint: answer hidden below counter_max');
check(Protocol::verifySolution($secret, $c, ['work' => $sol], $now, $site)['id'] === $c['id'], 'verify: a PHP-minted challenge verifies');
check(throws(fn () => Protocol::verifySolution($secret, $c, ['work' => ['counter' => $sol['counter'], 'derivedKey' => str_repeat('0', strlen($sol['derivedKey']))]], $now, $site), 'bad_solution'), 'verify: wrong derived key rejected');
check(throws(fn () => Protocol::verifySolution($secret, $c, ['work' => $sol], $now + 121, $site), 'expired'), 'verify: expired after 120 s');
check(throws(fn () => Protocol::verifySolution($secret, $c, ['work' => $sol], $now, 'site_other'), 'wrong_site'), 'verify: other site rejected');
check(throws(fn () => Protocol::verifySolution('another-secret-0123456789abcdef', $c, ['work' => $sol], $now, $site), 'bad_sig'), 'verify: other secret rejected');
$t = $c; $t['bound']['action'] = 'search';
check(throws(fn () => Protocol::verifySolution($secret, $t, ['work' => $sol], $now, $site), 'bad_sig'), 'verify: changing the bound action breaks the signature');
$other = Protocol::mintChallenge($secret, $site, 'write', '/', ['alg' => 'pbkdf2-sha256', 'cost' => 500, 'counter_max' => 64], 120, $now);
$swap = $other; $swap['work'] = $c['work'];
check(throws(fn () => Protocol::verifySolution($secret, $swap, ['work' => $sol], $now, $site), 'bad_sig') || throws(fn () => Protocol::verifySolution($secret, $swap, ['work' => $sol], $now, $site), 'bad_solution'), 'verify: engine payload from another challenge rejected');
check(throws(fn () => Protocol::mintChallenge($secret, $site, 'read', '/', ['counter_max' => 8, 'cost' => 1], 60, $now), 'malformed'), 'mint: read is never challenged');
check(throws(fn () => Protocol::mintChallenge($secret, $site, 'write', '/', ['counter_max' => 8, 'cost' => 1], 121, $now), 'malformed'), 'mint: ttl at most 120 s');

// Hardened engine round trip (small counter so it stays quick).
$a = Protocol::mintChallenge($secret, $site, 'admin', '/', ['alg' => 'argon2id', 'cost' => 2, 'memory_kib' => 19456, 'parallelism' => 1, 'counter_max' => 1], 120, $now, 0);
check(Protocol::verifySolution($secret, $a, ['work' => solve($a['work'])], $now, $site)['alg'] === 'argon2id', 'mint: hardened challenge verifies');

// Human pass: 900 s, 20 uses (spec §18 phase 3, docs/protocol.md).
$claims = Protocol::newPassClaims($site, 'write', 20, 900, $now);
$tok = Protocol::signPass($secret, $claims);
$v = Protocol::verifyPass($secret, $tok, $now + 899, $site, 'write');
check($v['n'] === 20 && $v['exp'] - $v['iat'] === 900 && preg_match('/^[0-9a-f]{32}$/', $v['jti']) === 1, 'pass: 900 s, 20 uses');
check(throws(fn () => Protocol::verifyPass($secret, $tok, $now + 900, $site, 'write'), 'expired'), 'pass: expired at 900 s');
check(throws(fn () => Protocol::verifyPass($secret, $tok, $now, $site, 'account'), 'class_too_low'), 'pass: a write pass does not cover login');

echo "\nPHP " . PHP_VERSION . " issuer: $pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
