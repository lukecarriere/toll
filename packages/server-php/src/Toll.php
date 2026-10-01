<?php
// Toll protocol v1 verifier for PHP 8.1+ (spec §12, Amendment 1). Toll owns the envelope and pass;
// the puzzle is verified by the work engine's PHP library (pinned in composer.json, see
// docs/adapters.md). Argon2id (hardened mode) needs ext-sodium. Mirrors packages/protocol and
// packages/work-adapter (TypeScript). Both must pass docs/vectors.json.
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
    public const MAX_WORK_BYTES = 4096;
    /** Toll alg -> the engine's algorithm name inside the opaque payload. */
    private const ENGINE_ALG = ['pbkdf2-sha256' => 'PBKDF2/SHA-256', 'argon2id' => 'ARGON2ID'];
    private const FIELDS = ['v', 'id', 'site', 'alg', 'work', 'bound', 'iat', 'exp', 'sig'];

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
        if (!isset(self::ENGINE_ALG[$c['alg'] ?? ''])) throw new TollError('unsupported', 'alg');
        if (!is_string($c['id'] ?? null) || !preg_match('/^[0-9a-f]{32}$/', $c['id'])) throw new TollError('malformed', 'id');
        if (!is_string($c['site'] ?? null) || strlen($c['site']) < 1 || strlen($c['site']) > 128) throw new TollError('malformed', 'site');
        if (!is_array($c['work'] ?? null) || ($c['work'] !== [] && array_is_list($c['work']))) throw new TollError('malformed', 'work');
        if (strlen(self::canonicalJson($c['work'])) > self::MAX_WORK_BYTES) throw new TollError('malformed', 'work payload too large');
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

    /** Signature, time and site. Cheap; run before the work engine verifies anything. */
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

    /** Work-engine secrets, derived from the Toll secret (same derivation as packages/work-adapter). */
    public static function engineSecret(string $secret, string $label): string
    {
        return hash_hmac('sha256', 'toll/work-adapter/v1/' . $label, $secret);
    }

    /**
     * Verify the engine payload and solution with the engine's own PHP library (docs/adapters.md),
     * after binding it to this Toll challenge id. No network: the engine's online verification
     * service is never called.
     */
    public static function verifyWork(string $secret, array $c, mixed $solution): bool
    {
        $w = $c['work'];
        $params = $w['parameters'] ?? null;
        if (!is_array($params) || ($params['algorithm'] ?? null) !== self::ENGINE_ALG[$c['alg']]) throw new TollError('malformed', 'engine payload');
        if (($params['data']['tid'] ?? null) !== $c['id']) return false;
        if (!is_array($solution) || !self::isInt($solution['counter'] ?? null, 0, 0xffffffff) || !is_string($solution['derivedKey'] ?? null) || !preg_match('/^(?:[0-9a-f]{2}){1,64}$/', $solution['derivedKey'])) return false;
        $engine = new \AltchaOrg\Altcha\Altcha(self::engineSecret($secret, 'challenge'), self::engineSecret($secret, 'key'));
        $kdf = $c['alg'] === 'argon2id' ? new \AltchaOrg\Altcha\Algorithm\Argon2id() : new \AltchaOrg\Altcha\Algorithm\Pbkdf2();
        try {
            $r = $engine->verifySolution(new \AltchaOrg\Altcha\VerifySolutionOptions(['challenge' => $w, 'solution' => ['counter' => $solution['counter'], 'derivedKey' => $solution['derivedKey']]], $kdf));
        } catch (\Throwable $e) {
            throw new TollError('malformed', 'engine payload');
        }
        return $r->verified;
    }

    /** Full redeem check: returns the challenge or throws TollError. Replay tracking is the caller's job. */
    public static function verifySolution(string $secret, mixed $challenge, mixed $solution, int $now, ?string $site = null): array
    {
        $c = self::checkChallenge($secret, $challenge, $now, $site);
        if (!self::verifyWork($secret, $c, is_array($solution) ? ($solution['work'] ?? null) : null)) throw new TollError('bad_solution');
        return $c;
    }

    /**
     * Mint a signed Toll challenge whose engine payload comes from the engine's PHP library, bound to
     * the Toll id (parameters.data.tid), with the answer hidden at a counter in [0, counter_max).
     * Same envelope and payload shape as packages/protocol + packages/work-adapter (Node), so the
     * widget solves it and either side can verify it. Costs one KDF call (the secret counter).
     * $spec: alg ('pbkdf2-sha256' | 'argon2id'), cost, counter_max, optional memory_kib, parallelism.
     */
    public static function mintChallenge(string $secret, string $site, string $action, string $path_prefix, array $spec, int $ttl_s, int $now, ?int $counter = null): array
    {
        if (!isset(self::CLASS_MULT[$action]) || $action === 'read') throw new TollError('malformed', 'action');
        if ($ttl_s < 1 || $ttl_s > self::MAX_TTL) throw new TollError('malformed', 'ttl');
        $alg = $spec['alg'] ?? 'pbkdf2-sha256';
        if (!isset(self::ENGINE_ALG[$alg])) throw new TollError('unsupported', 'alg');
        $max = (int) ($spec['counter_max'] ?? 0);
        if ($max < 1 || $max > 0xffffffff) throw new TollError('malformed', 'counter_max');
        $id = bin2hex(random_bytes(16));
        $engine = new \AltchaOrg\Altcha\Altcha(self::engineSecret($secret, 'challenge'), self::engineSecret($secret, 'key'));
        $argon = $alg === 'argon2id';
        $opts = new \AltchaOrg\Altcha\CreateChallengeOptions(
            algorithm: $argon ? new \AltchaOrg\Altcha\Algorithm\Argon2id() : new \AltchaOrg\Altcha\Algorithm\Pbkdf2(),
            cost: (int) $spec['cost'],
            counter: $counter ?? random_int(0, $max - 1),
            memoryCost: $argon ? (int) ($spec['memory_kib'] ?? 19456) : null,
            parallelism: $argon ? (int) ($spec['parallelism'] ?? 1) : null,
            data: ['tid' => $id],
        );
        $work = $engine->createChallenge($opts)->toArray();
        return self::signChallenge($secret, [
            'v' => 1, 'id' => $id, 'site' => $site, 'alg' => $alg, 'work' => $work,
            'bound' => ['action' => $action, 'path_prefix' => $path_prefix],
            'iat' => $now, 'exp' => $now + $ttl_s,
        ]);
    }

    /** Fresh pass claims (same shape as packages/protocol newPassClaims). */
    public static function newPassClaims(string $site, string $cls, int $n, int $ttl_s, int $now): array
    {
        $jti = bin2hex(random_bytes(16));
        return ['v' => 1, 'site' => $site, 'sub' => 'pass_' . substr($jti, 0, 16), 'cls' => $cls, 'n' => $n, 'iat' => $now, 'exp' => $now + $ttl_s, 'jti' => $jti];
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

/**
 * Work policy for PHP hosts (mirror of packages/protocol/src/policy.ts, standard defaults from
 * docs/policy.md). Velocity and escalation are Node-issuer features for now (docs/policy.md §6).
 */
final class Policy
{
    public const STANDARD = ['alg' => 'pbkdf2-sha256', 'cost' => 5000, 'unit_tries' => 64];
    public const HARDENED = ['alg' => 'argon2id', 'cost' => 2, 'memory_kib' => 19456, 'parallelism' => 1, 'unit_tries' => 4];
    public const MAX_UNITS = 28;
    public const DEVICE_MULT = ['mobile' => 0.6, 'desktop' => 1.0];

    public static function uaClass(?string $ua): string
    {
        return $ua !== null && preg_match('/Mobi|Android|iPhone|iPad/i', $ua) ? 'mobile' : 'desktop';
    }

    /** Engine spec for a challenge: alg, cost, counter_max (+ memory for Argon2id), expected_tries. */
    public static function workParams(string $action, string $ua_class, string $mode = 'standard'): array
    {
        $cls = Protocol::CLASS_MULT[$action] ?? 0;
        if ($cls === 0) throw new TollError('malformed', 'read is free');
        $m = $mode === 'hardened' ? self::HARDENED : self::STANDARD;
        $expected = $m['unit_tries'] * $cls * (self::DEVICE_MULT[$ua_class] ?? 1.0);
        $cap = max(1, (int) floor(self::MAX_UNITS * $m['unit_tries']));
        // JS Math.round == PHP round for positive values.
        $counter_max = min($cap, max(1, (int) round(2 * $expected)));
        $out = ['mode' => $mode, 'alg' => $m['alg'], 'cost' => $m['cost'], 'counter_max' => $counter_max, 'expected_tries' => ($counter_max + 1) / 2];
        if ($m['alg'] === 'argon2id') { $out['memory_kib'] = $m['memory_kib']; $out['parallelism'] = $m['parallelism']; }
        return $out;
    }
}
