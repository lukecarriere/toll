<?php
// §19.1: the shared work (engine fixtures) and pass vectors must pass on PHP. Run: php tests/php/run-vectors.php
// Needs `composer install` in packages/server-php (the work engine's PHP library).
declare(strict_types=1);
require __DIR__ . '/../../packages/server-php/vendor/autoload.php';

use Toll\Protocol;
use Toll\TollError;

$v = json_decode(file_get_contents(__DIR__ . '/../../docs/vectors.json'), true, 512, JSON_THROW_ON_ERROR);
$secret = $v['secret'];
check(Protocol::engineSecret($secret, 'challenge') === $v['engine_secrets']['challenge'] && Protocol::engineSecret($secret, 'key') === $v['engine_secrets']['key'], 'engine secrets derive from the Toll secret');
$pass = 0;
$fail = 0;
function check(bool $ok, string $name): void
{
    global $pass, $fail;
    if ($ok) { $pass++; echo "ok   $name\n"; } else { $fail++; echo "FAIL $name\n"; }
}

foreach ($v['work'] as $w) {
    $c = $w['challenge'];
    check(Protocol::signingInput($c) === $w['signing_input'], "canonical signing input: {$w['name']}");
    $unsigned = $c; unset($unsigned['sig']);
    check(Protocol::signChallenge($secret, $unsigned)['sig'] === $c['sig'], "challenge sig reproduces: {$w['name']}");
    try {
        Protocol::verifySolution($secret, $c, $w['solution'], $w['now'], $v['site']);
        check(true, "solution accepted: {$w['name']}");
    } catch (TollError $e) {
        check(false, "solution accepted: {$w['name']} ({$e->codeName})");
    }
    check(Protocol::signPass($secret, $w['pass']['claims']) === $w['pass']['token'], "pass token reproduces: {$w['name']}");
}

foreach ($v['work_invalid'] as $w) {
    try {
        Protocol::verifySolution($secret, $w['challenge'], $w['solution'], $w['now'], $v['site']);
        check(false, "rejected ({$w['expect']}): {$w['name']} -- was accepted");
    } catch (TollError $e) {
        check($e->codeName === $w['expect'], "rejected ({$w['expect']}): {$w['name']}" . ($e->codeName === $w['expect'] ? '' : " -- got {$e->codeName}"));
    }
}

foreach ($v['pass_invalid'] as $p) {
    try {
        Protocol::verifyPass($secret, $p['token'], $p['now'], $v['site'], $p['action']);
        check(false, "pass rejected ({$p['expect']}): {$p['name']} -- was accepted");
    } catch (TollError $e) {
        check($e->codeName === $p['expect'], "pass rejected ({$p['expect']}): {$p['name']}" . ($e->codeName === $p['expect'] ? '' : " -- got {$e->codeName}"));
    }
}

foreach ($v['pass_valid_checks'] as $p) {
    try {
        Protocol::verifyPass($secret, $p['token'], $p['now'], $v['site'], $p['action']);
        check(true, "pass accepted: {$p['name']}");
    } catch (TollError $e) {
        check(false, "pass accepted: {$p['name']} -- got {$e->codeName}");
    }
}

echo "\nPHP " . PHP_VERSION . ": $pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
