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
}
