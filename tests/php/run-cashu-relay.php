<?php
// Cashu relay shape in the PHP library: header copy and redeem fields. No mint call, no proof check.
declare(strict_types=1);
require __DIR__ . '/../../packages/server-php/vendor/autoload.php';

use Toll\Settlement;

$pass = 0;
$fail = 0;
function check(bool $ok, string $name): void
{
    global $pass, $fail;
    if ($ok) { $pass++; echo "ok   $name\n"; } else { $fail++; echo "FAIL $name\n"; }
}

$ln = ['id' => 'off_1', 'kind' => 'ln402', 'amount_msat' => 10000, 'invoice' => 'inv', 'macaroon' => 'mac', 'exp' => 10];
$cu = ['id' => 'off_1', 'kind' => 'cashu', 'amount_msat' => 10000, 'request' => 'creqAabc', 'credential' => 'cred', 'exp' => 10];

$relay = Settlement::relayPayment(['offers' => [$ln], 'www_authenticate' => 'L402 macaroon="mac", invoice="inv"']);
check($relay !== null && $relay['header'] === 'WWW-Authenticate' && $relay['offers'][0]['kind'] === 'ln402', 'lightning offer keeps WWW-Authenticate');

$cashu = Settlement::relayPayment(['offers' => [$cu], 'x_cashu' => 'creqAabc']);
check($cashu !== null && $cashu['header'] === 'X-Cashu' && $cashu['value'] === 'creqAabc' && $cashu['offers'][0]['request'] === 'creqAabc', 'cashu offer copies X-Cashu');
check(Settlement::relayPayment(['offers' => [$cu], 'x_cashu' => "creqA\r\nSet-Cookie: x"]) === null, 'a header break is refused');
check(Settlement::relayPayment(['offers' => [['id' => 1]], 'www_authenticate' => 'X']) === null, 'a non-string offer is refused');

$fwd = Settlement::forwardRedeem(['offer_id' => 'off_1', 'kind' => 'cashu', 'token' => 'cashuBabc', 'credential' => 'cred']);
check($fwd === ['offer_id' => 'off_1', 'kind' => 'cashu', 'token' => 'cashuBabc', 'credential' => 'cred'], 'cashu redeem fields are copied');
check(Settlement::forwardRedeem(['offer_id' => 'off_1', 'kind' => 'ln402', 'preimage' => 'ab', 'macaroon' => 'mac'])['preimage'] === 'ab', 'lightning redeem fields are copied');
check(Settlement::forwardRedeem(['offer_id' => 'off_1', 'kind' => 'cashu', 'token' => '', 'credential' => 'cred']) === null, 'an empty field is refused');

check(Settlement::presentedCashu('cashuBabc') === ['kind' => 'b', 'token' => 'cashuBabc'], 'V4 header');
check(Settlement::presentedCashu('cashuAabc') === ['kind' => 'a'], 'V3 header');
check(Settlement::presentedCashu('creqAabc') === null, 'a payment request is not a payment');
check(Settlement::forwardPresented('cashuBabc', 'write') === ['token' => 'cashuBabc', 'action' => 'write'], 'presented body');
check(Settlement::forwardPresented('cashuAabc', 'write') === null, 'V3 is not forwarded as a payment');

echo "\nPHP " . PHP_VERSION . " cashu relay: $pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
