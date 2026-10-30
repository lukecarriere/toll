<?php
// Paid-request helpers for PHP hosts (docs/settlement.md; vectors: docs/settlement-vectors.json).
// Pure arithmetic and display rules, so a PHP site (the future WordPress plugin) shows the same
// prices, fees and USD strings as the Node issuer. Settlement itself happens at the issuer through
// the settlement engine; PHP never verifies offer credentials or parses invoices. A settle pass is
// an ordinary Toll pass (n = 1, 60 s) and is checked with Protocol::verifyPass.
declare(strict_types=1);

namespace Toll;

final class Settlement
{
    public const BASE_MSAT = ['search' => 2000, 'write' => 10000, 'account' => 25000, 'admin' => 100000];
    public const FX_MAX_AGE_S = 900;

    /** Policy price rounded to an integer msat (JS Math.round == PHP round for positive values). */
    public static function priceMsat(string $cls, float $velocity = 1.0, float $suspicion = 1.0): int
    {
        if (!isset(self::BASE_MSAT[$cls])) throw new TollError('malformed', 'unknown class');
        return (int) round(self::BASE_MSAT[$cls] * $velocity * $suspicion);
    }

    /** Q3: offers are a whole multiple of 1,000 msat, rounded up. */
    public static function offerAmountMsat(string $cls, float $velocity = 1.0, float $suspicion = 1.0): int
    {
        return intdiv(self::priceMsat($cls, $velocity, $suspicion) + 999, 1000) * 1000;
    }

    /** Q5: the fee rounds down; returns [fee_msat, net_msat]. */
    public static function splitFee(int $gross_msat, int $fee_bps): array
    {
        if ($gross_msat < 0) throw new \InvalidArgumentException('gross must be >= 0');
        if ($fee_bps < 0 || $fee_bps > 10000) throw new \InvalidArgumentException('fee_bps must be 0..10000');
        $fee = intdiv($gross_msat * $fee_bps, 10000);
        return ['fee_msat' => $fee, 'net_msat' => $gross_msat - $fee];
    }

    /** `{fee}` in owner copy: fee_bps / 100, trailing zeros dropped (1000 -> "10", 750 -> "7.5", 25 -> "0.25"). */
    public static function feePercent(int $fee_bps): string
    {
        if ($fee_bps < 0 || $fee_bps > 10000) throw new \InvalidArgumentException('fee_bps must be 0..10000');
        $whole = intdiv($fee_bps, 100);
        $frac = $fee_bps % 100;
        if ($frac === 0) return (string) $whole;
        return $whole . '.' . rtrim(str_pad((string) $frac, 2, '0', STR_PAD_LEFT), '0');
    }

    /** Replace every `{fee}` in a docs/copy.md template (e.g. the WordPress balance line). */
    public static function fillFee(string $template, int $fee_bps): string
    {
        return str_replace('{fee}', self::feePercent($fee_bps), $template);
    }

    private static function fresh(?float $usd_per_btc, ?int $fetched_at, int $now): bool
    {
        return $usd_per_btc !== null && $usd_per_btc > 0 && $fetched_at !== null && $now - $fetched_at <= self::FX_MAX_AGE_S;
    }

    /** Owner totals: "$D.CC" rounded down, "less than $0.01", or null (hide) when the rate is unavailable. */
    public static function usdDisplay(int $msat, ?float $usd_per_btc, ?int $fetched_at, int $now): ?string
    {
        if (!self::fresh($usd_per_btc, $fetched_at, $now)) return null;
        $cents = (int) floor(($msat * $usd_per_btc) / 1e9 + 1e-6);
        if ($msat > 0 && $cents < 1) return 'less than $0.01';
        return '$' . intdiv($cents, 100) . '.' . str_pad((string) ($cents % 100), 2, '0', STR_PAD_LEFT);
    }

    /** Offer display: "D.UUUU" rounded up to $0.0001, or null when the rate is unavailable. */
    public static function offerUsd(int $msat, ?float $usd_per_btc, ?int $fetched_at, int $now): ?string
    {
        if (!self::fresh($usd_per_btc, $fetched_at, $now)) return null;
        $units = (int) ceil(($msat * $usd_per_btc) / 1e7 - 1e-6);
        return intdiv($units, 10000) . '.' . str_pad((string) ($units % 10000), 4, '0', STR_PAD_LEFT);
    }

    /** SHA-256(preimage) == payment_hash, constant time. Both lowercase hex, 32 bytes. */
    public static function preimageMatches(string $preimage_hex, string $payment_hash_hex): bool
    {
        if (!preg_match('/^[0-9a-f]{64}$/', $preimage_hex) || !preg_match('/^[0-9a-f]{64}$/', $payment_hash_hex)) return false;
        return hash_equals($payment_hash_hex, hash('sha256', (string) hex2bin($preimage_hex)));
    }

    /** Printable header value, no CR or LF, so it can be copied onto a response. */
    public static function headerValueOk(string $value, int $max = 16384): bool
    {
        return $value !== '' && strlen($value) <= $max && preg_match('/^[\x20-\x7e]+$/', $value) === 1;
    }

    /**
     * A V3 or V4 payment string, with a URI prefix removed. Null when it is not a payment.
     */
    private static function cashuPayment(string $header): ?string
    {
        $t = trim($header);
        foreach (['web+cashu://', 'cashu://', 'cashu:'] as $prefix) {
            if (str_starts_with($t, $prefix)) $t = trim(substr($t, strlen($prefix)));
        }
        if ($t === '' || strlen($t) > 16384) return null;
        if (str_starts_with($t, 'cashuA') || str_starts_with($t, 'cashuB')) return $t;
        return null;
    }

    /**
     * What a caller put in X-Cashu. `a` is a V3 string and `b` is a V4 string.
     * Anything else, including a payment request, is not a payment.
     * @return array{kind: 'a'|'b', token: string}|null
     */
    public static function presentedCashu(?string $header): ?array
    {
        if (!is_string($header)) return null;
        $t = self::cashuPayment($header);
        if ($t === null) return null;
        return ['kind' => str_starts_with($t, 'cashuA') ? 'a' : 'b', 'token' => $t];
    }

    /** One offer is safe to relay: strings of a bounded size, no parsing of the payment itself. */
    public static function offerShapeOk(mixed $o): bool
    {
        if (!is_array($o)) return false;
        $kind = $o['kind'] ?? '';
        $fields = $kind === 'cashu' ? ['id', 'kind', 'request', 'credential'] : ['id', 'kind', 'invoice', 'macaroon'];
        if ($kind !== 'cashu' && $kind !== 'ln402') return false;
        foreach ($fields as $k) {
            if (!is_string($o[$k] ?? null) || $o[$k] === '' || strlen($o[$k]) > 16384) return false;
        }
        return is_int($o['amount_msat'] ?? null) && $o['amount_msat'] > 0 && is_int($o['exp'] ?? null)
            && (!isset($o['display']) || is_array($o['display']));
    }

    /**
     * Headers and offers to copy from a payment server's offers response.
     * @return array{offers: list<array<string, mixed>>, header: string, value: string}|null
     */
    public static function relayPayment(array $body): ?array
    {
        $rows = is_array($body['offers'] ?? null) ? array_values(array_filter($body['offers'], [self::class, 'offerShapeOk'])) : [];
        if ($rows === []) return null;
        $offers = array_slice($rows, 0, 4);
        $kind = $offers[0]['kind'] ?? '';
        if ($kind === 'cashu') {
            $value = $body['x_cashu'] ?? null;
            if (!is_string($value) || !self::headerValueOk($value)) return null;
            return ['offers' => $offers, 'header' => 'X-Cashu', 'value' => $value];
        }
        $value = $body['www_authenticate'] ?? null;
        if (!is_string($value) || !self::headerValueOk($value, 4096)) return null;
        return ['offers' => $offers, 'header' => 'WWW-Authenticate', 'value' => $value];
    }

    /**
     * Fields to forward on a paid redeem. Null when the body is not a bounded string shape.
     * @return array<string, string>|null
     */
    public static function forwardRedeem(array $b): ?array
    {
        $kind = $b['kind'] ?? '';
        $fields = $kind === 'cashu' ? ['offer_id', 'kind', 'token', 'credential'] : ($kind === 'ln402' ? ['offer_id', 'kind', 'preimage', 'macaroon'] : []);
        if ($fields === []) return null;
        $fwd = [];
        foreach ($fields as $k) {
            if (!is_string($b[$k] ?? null) || $b[$k] === '' || strlen($b[$k]) > 16384) return null;
            $fwd[$k] = $b[$k];
        }
        return $fwd;
    }

    /**
     * Body for POST /v1/owner/cashu when the caller retried with X-Cashu.
     * @return array{token: string, action: string}|null
     */
    public static function forwardPresented(string $token, string $action): ?array
    {
        $token = self::cashuPayment($token) ?? '';
        if ($token === '') return null;
        if (!isset(Protocol::CLASS_MULT[$action]) || $action === 'read') return null;
        return ['token' => $token, 'action' => $action];
    }
}
