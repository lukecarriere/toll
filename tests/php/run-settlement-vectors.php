<?php
// §19.9 settlement vectors on PHP: the parts a PHP host computes itself (price, fee, USD display,
// preimage check, settle pass token and expiry). Offer credentials are verified only at the issuer
// (settlement engine), so paid_invalid and replay run on Node only. Run: php tests/php/run-settlement-vectors.php
declare(strict_types=1);
require __DIR__ . '/../../packages/server-php/vendor/autoload.php';

use Toll\Protocol;
use Toll\Settlement;
use Toll\TollError;

$v = json_decode(file_get_contents(__DIR__ . '/../../docs/settlement-vectors.json'), true, 512, JSON_THROW_ON_ERROR);
$pass = 0;
$fail = 0;
function check(bool $ok, string $name): void
{
    global $pass, $fail;
    if ($ok) { $pass++; echo "ok   $name\n"; } else { $fail++; echo "FAIL $name\n"; }
}

check(hash_hmac('sha256', 'toll/settlement/stub/v1', $v['secret']) === $v['engine_secret'], 'stub engine secret derives from the Toll secret');
check(Settlement::BASE_MSAT === $v['base_msat'], 'base price table');

foreach ($v['price_cases'] as $c) {
    $p = Settlement::priceMsat($c['cls'], (float) $c['velocity_mult'], (float) $c['suspicion_mult']);
    $a = Settlement::offerAmountMsat($c['cls'], (float) $c['velocity_mult'], (float) $c['suspicion_mult']);
    check($p === $c['price_msat'] && $a === $c['amount_msat'], "price {$c['cls']} x{$c['velocity_mult']} x{$c['suspicion_mult']} -> {$c['amount_msat']} msat" . ($a === $c['amount_msat'] ? '' : " (got $p/$a)"));
}
foreach ($v['fee_cases'] as $c) {
    $r = Settlement::splitFee($c['gross_msat'], $c['fee_bps']);
    check($r === ['fee_msat' => $c['fee_msat'], 'net_msat' => $c['net_msat']], "fee {$c['gross_msat']} msat at {$c['fee_bps']} bps -> {$c['fee_msat']}");
}
foreach ($v['usd_cases'] as $c) {
    $rate = $c['usd_per_btc'] === null ? null : (float) $c['usd_per_btc'];
    $o = Settlement::usdDisplay($c['msat'], $rate, $c['fetched_at'], $c['now']);
    $f = Settlement::offerUsd($c['msat'], $rate, $c['fetched_at'], $c['now']);
    $label = "usd {$c['msat']} msat @ " . var_export($c['usd_per_btc'], true) . ' -> ' . var_export($c['owner'], true) . ' / ' . var_export($c['offer'], true);
    check($o === $c['owner'] && $f === $c['offer'], $label . ($o === $c['owner'] && $f === $c['offer'] ? '' : ' (got ' . var_export($o, true) . ' / ' . var_export($f, true) . ')'));
}
foreach ($v['paid'] as $p) {
    check(Settlement::preimageMatches($p['preimage'], $p['payment_hash']), "preimage hashes to payment hash: {$p['name']}");
    check(Settlement::splitFee($p['ledger']['gross_msat'], $p['ledger']['fee_bps']) === ['fee_msat' => $p['ledger']['fee_msat'], 'net_msat' => $p['ledger']['net_msat']], "ledger split: {$p['name']}");
    $sp = $p['settle_pass'];
    check($sp['claims']['n'] === 1 && $sp['claims']['exp'] - $sp['claims']['iat'] === 60, "settle pass is one use, 60 s: {$p['name']}");
    check(Protocol::signPass($v['secret'], $sp['claims']) === $sp['token'], "settle pass token reproduces: {$p['name']}");
    try {
        Protocol::verifyPass($v['secret'], $sp['token'], $sp['valid_at'], $v['site'], $sp['claims']['cls']);
        check(true, "settle pass accepted before exp: {$p['name']}");
    } catch (TollError $e) {
        check(false, "settle pass accepted before exp: {$p['name']} -- got {$e->codeName}");
    }
    try {
        Protocol::verifyPass($v['secret'], $sp['token'], $sp['expired_at'], $v['site']);
        check(false, "settle pass expired at exp: {$p['name']} -- was accepted");
    } catch (TollError $e) {
        check($e->codeName === 'expired', "settle pass expired at exp: {$p['name']}");
    }
}
check(!Settlement::preimageMatches($v['paid_invalid'][0]['preimage'], $v['paid'][0]['payment_hash']), 'wrong preimage does not match');
check(!Settlement::preimageMatches('5e11', $v['paid'][0]['payment_hash']), 'malformed preimage does not match');

echo "\nPHP " . PHP_VERSION . " settlement: $pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
