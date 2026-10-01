<?php
// Toll protocol v1 verifier for PHP 8.1+ (spec §12). No framework, no extensions beyond hash.
// Mirrors packages/protocol (TypeScript). Both must pass docs/vectors.json.
declare(strict_types=1);

namespace Toll;

final class TollError extends \Exception
{
    public function __construct(public readonly string $codeName, string $message = '')
    {
        parent::__construct($message !== '' ? $message : $codeName);
    }
}

final class Protocol
{
    public const CLASS_MULT = ['read' => 0, 'search' => 1, 'write' => 4, 'account' => 8, 'admin' => 16];
    public const MAX_TTL = 120;
    public const MAX_SPAN = 16777216;
    private const FIELDS = ['v', 'id', 'site', 'algo', 'cost', 'n', 'bits', 'counter_start', 'counter_end', 'targets', 'mem_kib', 'parallelism', 'salt', 'bound', 'iat', 'exp', 'sig'];

    /** Canonical JSON: sorted keys, no whitespace, slashes and unicode unescaped (same bytes as JS). */
    public static function canonicalJson(mixed $v): string
    {
        if (is_array($v)) {
            if (array_is_list($v)) {
                return '[' . implode(',', array_map([self::class, 'canonicalJson'], $v)) . ']';
            }
            $keys = array_keys($v);
            usort($keys, fn ($a, $b) => strcmp((string) $a, (string) $b));
            $parts = [];
            foreach ($keys as $k) {
                $parts[] = json_encode((string) $k, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . ':' . self::canonicalJson($v[$k]);
            }
            return '{' . implode(',', $parts) . '}';
        }
        if (is_int($v)) {
            return (string) $v;
        }
        if (is_string($v) || is_bool($v) || $v === null) {
            return json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }
        throw new TollError('malformed', 'canonical JSON allows integers, strings, booleans, null, arrays');
    }

    public static function b64urlEncode(string $bin): string
    {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    }

    public static function b64urlDecode(string $s): string|false
    {
        if (!preg_match('/^[A-Za-z0-9_-]*$/', $s)) {
            return false;
        }
        return base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4), true);
    }

    private static function isInt(mixed $x, int $lo, int $hi): bool
    {
        return is_int($x) && $x >= $lo && $x <= $hi;
    }

    /** Structural checks, in the same order as the TypeScript implementation. */
    public static function assertChallengeShape(mixed $c): void
    {
        if (!is_array($c) || array_is_list($c)) {
            throw new TollError('malformed', 'challenge must be an object');
        }
        foreach (array_keys($c) as $k) {
            if (!in_array($k, self::FIELDS, true)) {
                throw new TollError('malformed', "unknown field $k");
            }
        }
        if (($c['v'] ?? null) !== 1) throw new TollError('unsupported', 'version');
        if (($c['algo'] ?? null) !== 'pbkdf2-sha256') throw new TollError('unsupported', 'algo');
        if (!is_string($c['id'] ?? null) || !preg_match('/^[0-9a-f]{32}$/', $c['id'])) throw new TollError('malformed', 'id');
        if (!is_string($c['site'] ?? null) || strlen($c['site']) < 1 || strlen($c['site']) > 128) throw new TollError('malformed', 'site');
        if (!self::isInt($c['cost'] ?? null, 1, 10000000)) throw new TollError('malformed', 'cost');
        if (!self::isInt($c['n'] ?? null, 1, 16)) throw new TollError('malformed', 'n');
        if (!self::isInt($c['bits'] ?? null, 8, 64) || $c['bits'] % 8 !== 0) throw new TollError('malformed', 'bits');
        if (!self::isInt($c['counter_start'] ?? null, 0, PHP_INT_MAX) || !self::isInt($c['counter_end'] ?? null, 1, 9007199254740991)) throw new TollError('malformed', 'range');
        $span = $c['counter_end'] - $c['counter_start'];
        if ($span < 1 || $span > self::MAX_SPAN) throw new TollError('malformed', 'range');
        if (!is_array($c['targets'] ?? null) || !array_is_list($c['targets']) || count($c['targets']) !== $c['n']) throw new TollError('malformed', 'targets');
        $hexLen = intdiv($c['bits'], 4);
        foreach ($c['targets'] as $t) {
            if (!is_string($t) || !preg_match('/^[0-9a-f]{' . $hexLen . '}$/', $t)) throw new TollError('malformed', 'target');
        }
        if (($c['mem_kib'] ?? null) !== 0 || ($c['parallelism'] ?? null) !== 1) throw new TollError('malformed', 'mem_kib/parallelism');
        if (!is_string($c['salt'] ?? null)) throw new TollError('malformed', 'salt');
        $salt = base64_decode($c['salt'], true);
        if ($salt === false || strlen($salt) < 8 || strlen($salt) > 64) throw new TollError('malformed', 'salt');
        $b = $c['bound'] ?? null;
        if (!is_array($b) || count($b) !== 2 || !isset(self::CLASS_MULT[$b['action'] ?? '']) || $b['action'] === 'read' || !is_string($b['path_prefix'] ?? null) || !str_starts_with($b['path_prefix'], '/')) throw new TollError('malformed', 'bound');
        if (!self::isInt($c['iat'] ?? null, 0, PHP_INT_MAX) || !self::isInt($c['exp'] ?? null, 0, PHP_INT_MAX)) throw new TollError('malformed', 'times');
        $ttl = $c['exp'] - $c['iat'];
        if ($ttl <= 0 || $ttl > self::MAX_TTL) throw new TollError('malformed', 'ttl');
        if (!is_string($c['sig'] ?? null)) throw new TollError('bad_sig', 'unsigned');
    }

    public static function signingInput(array $c): string
    {
        unset($c['sig']);
        return self::canonicalJson($c);
    }

    public static function signChallenge(string $secret, array $unsigned): array
    {
        $unsigned['sig'] = base64_encode(hash_hmac('sha256', self::signingInput($unsigned), $secret, true));
        return $unsigned;
    }

    /** Signature, time and site. Cheap; run before verifyWork. */
    public static function checkChallenge(string $secret, mixed $c, int $now, ?string $site = null, int $skew = 5): array
    {
        self::assertChallengeShape($c);
        $mac = base64_decode($c['sig'], true);
        $expected = hash_hmac('sha256', self::signingInput($c), $secret, true);
        if ($mac === false || !hash_equals($expected, $mac)) throw new TollError('bad_sig');
        if ($c['iat'] > $now + $skew) throw new TollError('not_yet_valid');
        if ($now > $c['exp']) throw new TollError('expired');
        if ($site !== null && $c['site'] !== $site) throw new TollError('wrong_site');
        return $c;
    }

    public static function subSalt(string $saltB64, int $i): string
    {
        return hash('sha256', base64_decode($saltB64, true) . pack('N', $i), true);
    }

    /** One PBKDF2 call per sub-puzzle; stops at the first wrong one. */
    public static function verifyWork(array $c, mixed $nonces): bool
    {
        if (!is_array($nonces) || !array_is_list($nonces) || count($nonces) !== $c['n']) return false;
        $bytes = intdiv($c['bits'], 8);
        foreach ($nonces as $i => $nonce) {
            if (!is_string($nonce) || !preg_match('/^[0-9a-f]{16}$/', $nonce)) return false;
            $counter = hexdec($nonce);
            if (!is_int($counter) || $counter < $c['counter_start'] || $counter >= $c['counter_end']) return false;
            $dk = hash_pbkdf2('sha256', $nonce, self::subSalt($c['salt'], $i), $c['cost'], 32, true);
            if (bin2hex(substr($dk, 0, $bytes)) !== $c['targets'][$i]) return false;
        }
        return true;
    }

    /** Full redeem check: returns the challenge or throws TollError. Replay tracking is the caller's job. */
    public static function verifySolution(string $secret, mixed $challenge, mixed $nonces, int $now, ?string $site = null): array
    {
        $c = self::checkChallenge($secret, $challenge, $now, $site);
        if (!self::verifyWork($c, $nonces)) throw new TollError('bad_solution');
        return $c;
    }

    private static function passHeader(): string
    {
        return self::b64urlEncode(self::canonicalJson(['alg' => 'HS256', 'typ' => 'JWT']));
    }

    public static function signPass(string $secret, array $claims): string
    {
        $input = self::passHeader() . '.' . self::b64urlEncode(self::canonicalJson($claims));
        return $input . '.' . self::b64urlEncode(hash_hmac('sha256', $input, $secret, true));
    }

    public static function verifyPass(string $secret, mixed $token, int $now, ?string $site = null, ?string $action = null): array
    {
        if (!is_string($token) || strlen($token) > 2048) throw new TollError('malformed');
        $parts = explode('.', $token);
        if (count($parts) !== 3 || $parts[0] !== self::passHeader()) throw new TollError('malformed');
        $mac = self::b64urlDecode($parts[2]);
        $expected = hash_hmac('sha256', $parts[0] . '.' . $parts[1], $secret, true);
        if ($mac === false || !hash_equals($expected, $mac)) throw new TollError('bad_sig');
        $json = self::b64urlDecode($parts[1]);
        $claims = $json === false ? null : json_decode($json, true);
        if (!is_array($claims) || ($claims['v'] ?? null) !== 1 || !isset(self::CLASS_MULT[$claims['cls'] ?? '']) || !is_string($claims['jti'] ?? null) || !is_int($claims['exp'] ?? null) || !is_int($claims['n'] ?? null)) throw new TollError('malformed');
        if ($now >= $claims['exp']) throw new TollError('expired');
        if ($site !== null && $claims['site'] !== $site) throw new TollError('wrong_site');
        if ($action !== null && self::CLASS_MULT[$claims['cls']] < self::CLASS_MULT[$action]) throw new TollError('class_too_low');
        return $claims;
    }
}
