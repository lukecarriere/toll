<?php
// The WordPress plugin's gate (includes/gate.php) for WooCommerce checkout and Contact Form 7 under
// PHP-CLI, with WordPress, WooCommerce and CF7 stubbed (no install needed). Each case runs in its own
// PHP process (the gate keeps per-request state) and calls the plugin's real hooks the way WordPress,
// WooCommerce and CF7 would; the payment server's answers are canned.
//   php tests/php/run-gate.php                     all cases, prints "PHP x.y.z gate: N passed, M failed"
//   php tests/php/run-gate.php --case <name> ...   one case as JSON (used by the parent run)
// Pass uses live in a JSON file guarded by flock, so the conditional decrement is atomic like the
// options-table UPDATE in includes/store.php, and two processes can race for the last use.
declare(strict_types=1);

const GATE_CASES = __FILE__;
$plugin = dirname(__DIR__, 2) . '/packages/wp-toll-gate';

if (($argv[1] ?? '') === '--case') {
    gate_child($plugin, $argv[2], json_decode($argv[3] ?? '{}', true, 16, JSON_THROW_ON_ERROR));
    exit(0);
}

// ---------------------------------------------------------------------------------------------------
// Child: stubs, plugin, one scenario.
// ---------------------------------------------------------------------------------------------------

final class Gate_Sent extends \Exception
{
    public function __construct(public int $status, public mixed $body) { parent::__construct('sent'); }
}

function gate_child(string $plugin, string $name, array $o): void
{
    define('ABSPATH', '/');
    define('TOLL_GATE_DIR', $plugin);
    define('TOLL_GATE_FILE', $plugin . '/toll-gate.php');
    define('TOLL_GATE_VERSION', '0.1.0');
    if (!empty($o['woo'])) { eval('class WooCommerce {}'); }
    if (!empty($o['cf7'])) define('WPCF7_VERSION', '6.0');
    $GLOBALS['gate'] = [
        'hooks' => [], 'options' => [], 'transients' => [], 'calls' => [], 'store' => $o['store'] ?? null,
        'server' => $o['server'] ?? 'offers', 'events' => [], 'notices' => (int) ($o['notice_error'] ?? 0), 'ran' => [],
    ];
    gate_stubs();
    $settings = ['forms' => ['comments' => 1, 'login' => 1, 'register' => 0, 'lostpassword' => 0, 'woo' => (int) ($o['woo_on'] ?? 1), 'cf7' => (int) ($o['cf7_on'] ?? 1)]];
    $settings += ($o['mode'] ?? 'server') === 'server'
        ? ['payouts' => 1, 'connection' => 'server', 'server_url' => 'http://127.0.0.1:9']
        : ['payouts' => 0, 'connection' => 'test', 'server_url' => ''];
    $GLOBALS['gate']['options'] = ['toll_gate_settings' => $settings, 'toll_gate_site_key' => 'site_gate', 'toll_gate_secret' => str_repeat('ab', 24), 'toll_gate_server_key' => 'owner-key-for-tests'];
    $_SERVER = ['REMOTE_ADDR' => '203.0.113.7', 'REQUEST_METHOD' => 'POST', 'REQUEST_URI' => $o['uri'] ?? '/', 'HTTP_USER_AGENT' => 'gate-test'];
    $_GET = $_POST = $_COOKIE = [];
    if (!empty($o['agent'])) $_SERVER['HTTP_TOLL_CLIENT'] = 'agent';
    foreach (['lib', 'strings', 'options', 'counters', 'issuer', 'network', 'gate', 'payouts'] as $f) require $plugin . '/includes/' . $f . '.php';
    if (isset($o['pass'])) {
        $claims = \Toll\Protocol::newPassClaims('site_gate', 'write', (int) $o['pass']['n'], 900, (int) $o['pass']['iat']);
        $claims['jti'] = $o['pass']['jti'];
        $token = \Toll\Protocol::signPass(str_repeat('ab', 24), $claims);
        match ($o['pass']['via'] ?? 'header') {
            'header' => $_SERVER['HTTP_AUTHORIZATION'] = 'Toll ' . $token,
            'post' => $_POST['toll-pass'] = $token,
            'cookie' => $_COOKIE['toll_pass'] = $token,
        };
    }
    if (isset($o['start'])) { while (microtime(true) < $o['start']) usleep(500); }
    toll_gate_init_gate();
    $out = ['sent' => null, 'result' => null];
    try {
        $out['result'] = gate_scenario($name, $o);
    } catch (Gate_Sent $e) {
        $out['sent'] = ['status' => $e->status, 'body' => $e->body];
    }
    $counts = [];
    foreach (toll_gate_counter_buffer() as $row => $n) $counts[preg_replace('/^toll_gate_n_\d{8}_/', '', $row)] = $n;
    ksort($counts);
    $hooks = array_keys(array_filter($GLOBALS['gate']['hooks']));
    sort($hooks);
    echo json_encode($out + ['counts' => $counts, 'calls' => $GLOBALS['gate']['calls'], 'hooks' => $hooks, 'events' => $GLOBALS['gate']['events'], 'ran' => $GLOBALS['gate']['ran'], 'left' => gate_store_left($o['pass']['jti'] ?? null)], JSON_UNESCAPED_SLASHES);
}

/** Runs one scenario through the plugin's hooks. Returns what the hook chain returned. */
function gate_scenario(string $name, array $o): mixed
{
    switch ($o['flow']) {
        case 'none':
            return null;
        case 'classic': // WC_Checkout::process_checkout: validate_checkout -> after_checkout_validation -> create_order if no errors or error notices
            $errors = new WP_Error();
            if (!empty($o['field_error'])) $errors->add('billing_email_required', 'Billing Email is a required field.');
            $data = ['billing_email' => 'a@b.test'] + (!empty($o['update_totals']) ? ['woocommerce_checkout_update_totals' => '1'] : []);
            do_action('woocommerce_after_checkout_validation', $data, $errors);
            if (!$errors->has_errors() && $GLOBALS['gate']['notices'] === 0 && empty($o['update_totals'])) gate_event('order_created');
            return $errors->get_error_codes();
        case 'store_api': // WP_REST_Server + WooCommerce Store API POST /wc/store/v1/checkout: every hook a Toll callback could sit on
            $req = new WP_REST_Request('POST', '/wc/store/v1/checkout');
            $pre = apply_filters('rest_request_before_callbacks', null, [], $req);
            $halt = apply_filters('rest_dispatch_request', null, $req, '/wc/store/v1/checkout', []);
            if ($pre !== null || $halt !== null) return ['halted' => true];
            $order = new stdClass();
            foreach (['woocommerce_store_api_checkout_update_customer_from_request', 'woocommerce_store_api_checkout_update_order_meta', 'woocommerce_store_api_checkout_update_order_from_request', 'woocommerce_store_api_checkout_order_processed', 'woocommerce_checkout_order_processed'] as $h) do_action($h, $order, $req);
            gate_event('order_created');
            return ['halted' => false, 'after' => apply_filters('rest_request_after_callbacks', ['order_id' => 7], [], $req)];
        case 'cf7_rest': // WP_REST_Server: permission ok -> rest_dispatch_request -> callback (CF7 submit: validate -> spam -> mail)
            $req = new WP_REST_Request($o['method'] ?? 'POST', $o['route'] ?? '/contact-form-7/v1/contact-forms/12/feedback');
            $halt = apply_filters('rest_dispatch_request', null, $req, '/contact-form-7/v1/contact-forms/(?P<id>\d+)/feedback', []);
            if ($halt !== null) return ['rest' => $halt instanceof WP_REST_Response ? ['status' => $halt->status, 'body' => $halt->data, 'headers' => $halt->headers] : $halt];
            if (!empty($o['dispatch_only'])) return ['rest' => null];
            return ['rest' => null, 'cf7' => gate_cf7_submit($o)];
        case 'cf7_post': // non-JS post: CF7 submits on init, same validate -> spam -> mail
            return ['cf7' => gate_cf7_submit($o)];
        case 'comment':
            return apply_filters('preprocess_comment', ['comment_content' => 'hi']);
        case 'refusal':
            return toll_gate_agent_refusal('write', '/checkout/');
    }
    throw new \LogicException('unknown flow ' . $o['flow']);
}

function gate_cf7_submit(array $o): string
{
    if (!empty($o['invalid'])) return 'validation_failed'; // CF7 skips the spam check after a validation failure
    if (!empty($o['race'])) toll_gate_consume($o['pass']['jti'], (int) $o['pass']['n'], (int) $o['pass']['iat'] + 900); // another request spends the last use
    $spam = apply_filters('wpcf7_spam', !empty($o['already_spam']), new WPCF7_Submission());
    if ($spam) return 'spam';
    gate_event('mail_sent');
    return 'mail_sent';
}

function gate_event(string $e): void { $GLOBALS['gate']['events'][] = $e; }

function gate_store_left(?string $jti): ?int
{
    if ($jti === null || $GLOBALS['gate']['store'] === null) return null;
    $all = json_decode((string) @file_get_contents($GLOBALS['gate']['store']), true) ?: [];
    return $all[$jti] ?? null;
}

function gate_stubs(): void
{
    eval(<<<'STUBS'
    class WP_Error {
        private array $e = [];
        public function __construct(string $code = '', string $msg = '') { if ($code !== '') $this->e[$code][] = $msg; }
        public function add(string $code, string $msg): void { $this->e[$code][] = $msg; }
        public function has_errors(): bool { return $this->e !== []; }
        public function get_error_codes(): array { return array_keys($this->e); }
        public function get_error_messages(string $code): array { return $this->e[$code] ?? []; }
    }
    class WP_REST_Request {
        private array $h = [];
        public function __construct(private string $method, private string $route) {}
        public function get_method(): string { return $this->method; }
        public function get_route(): string { return $this->route; }
        public function get_header(string $k): ?string { $v = $_SERVER['HTTP_' . strtoupper(str_replace('-', '_', $k))] ?? null; return $v === null ? null : (string) $v; }
        public function get_param(string $k) { return null; }
    }
    class WP_REST_Response {
        public array $headers = [];
        public function __construct(public mixed $data = null, public int $status = 200) {}
        public function header(string $k, string $v): void { $this->headers[$k] = $v; }
    }
    class WPCF7_Submission {}
    final class Toll_Gate_Store_Error extends \RuntimeException {}
    function add_filter(string $h, $cb, int $p = 10, int $n = 1): bool { $GLOBALS['gate']['hooks'][$h][] = [$p, $cb, $n]; return true; }
    function add_action(string $h, $cb, int $p = 10, int $n = 1): bool { return add_filter($h, $cb, $p, $n); }
    function has_action(string $h, $cb = false) { foreach ($GLOBALS['gate']['hooks'][$h] ?? [] as $x) if ($cb === false || $x[1] === $cb) return $x[0]; return false; }
    function apply_filters(string $h, $v, ...$args) {
        $list = $GLOBALS['gate']['hooks'][$h] ?? [];
        usort($list, fn ($a, $b) => $a[0] <=> $b[0]);
        foreach ($list as [$p, $cb, $n]) {
            $before = $v;
            $v = $cb(...array_slice([$v, ...$args], 0, $n));
            // Every plugin callback is a toll_gate_* function or a closure in the plugin folder.
            $rf = is_string($cb) ? new ReflectionFunction($cb) : ($cb instanceof Closure ? new ReflectionFunction($cb) : null);
            if ($rf && str_starts_with((string) $rf->getFileName(), TOLL_GATE_DIR)) $GLOBALS['gate']['ran'][] = [$h, $before === $v ? 'same' : 'changed'];
        }
        return $v;
    }
    function do_action(string $h, ...$args): void { apply_filters($h, ...($args ?: [null])); }
    function get_option(string $k, $d = false) { return $GLOBALS['gate']['options'][$k] ?? $d; }
    function update_option(string $k, $v, $a = null): bool { $GLOBALS['gate']['options'][$k] = $v; return true; }
    function add_option(string $k, $v = '', $x = '', $a = null): bool { $GLOBALS['gate']['options'][$k] ??= $v; return true; }
    function delete_option(string $k): bool { unset($GLOBALS['gate']['options'][$k]); return true; }
    function get_transient(string $k) { return $GLOBALS['gate']['transients'][$k] ?? false; }
    function set_transient(string $k, $v, int $ttl = 0): bool { $GLOBALS['gate']['transients'][$k] = $v; return true; }
    function delete_transient(string $k): bool { unset($GLOBALS['gate']['transients'][$k]); return true; }
    function rest_url(string $p = ''): string { return 'http://127.0.0.1:8800/wp-json/' . ltrim($p, '/'); }
    function untrailingslashit(string $s): string { return rtrim($s, '/\\'); }
    function wp_parse_url(string $u, int $c = -1) { return parse_url($u, $c); }
    function wp_json_encode($d, int $f = 0, int $depth = 512) { return json_encode($d, $f, $depth); }
    function wp_unslash($v) { return is_string($v) ? stripslashes($v) : $v; }
    function esc_html(string $s): string { return htmlspecialchars($s, ENT_QUOTES); }
    function esc_attr(string $s): string { return htmlspecialchars($s, ENT_QUOTES); }
    function wp_kses(string $s, array $a): string { return $s; }
    function get_bloginfo(string $k = ''): string { return 'Gate test'; }
    function current_user_can(string $c): bool { return false; }
    function nocache_headers(): void {}
    function wp_get_nocache_headers(): array { return ['Cache-Control' => 'no-cache, must-revalidate, max-age=0, no-store, private']; }
    function wp_send_json($body, $status = null, int $flags = 0): void { throw new Gate_Sent((int) $status, $body); }
    function wp_die($m = '', $t = '', $a = []): void { throw new Gate_Sent((int) (($a['response'] ?? 500)), ['wp_die' => (string) $m]); }
    function is_wp_error($v): bool { return $v instanceof WP_Error; }
    function wp_remote_request(string $url, array $args) {
        $GLOBALS['gate']['calls'][] = ['url' => $url, 'method' => $args['method'], 'timeout' => $args['timeout'], 'body' => isset($args['body']) ? json_decode($args['body'], true) : null];
        $s = $GLOBALS['gate']['server'];
        if ($s === 'down') return new WP_Error('http_request_failed', 'down');
        $offer = ['id' => 'off_1', 'kind' => 'ln402', 'amount_msat' => 10000, 'invoice' => 'lnstub1test', 'macaroon' => 'mac', 'exp' => time() + 120, 'display' => ['usd' => '0.0100']];
        return ['code' => 200, 'body' => json_encode(['offers' => [$offer], 'www_authenticate' => 'L402 macaroon="mac", invoice="lnstub1test"'])];
    }
    function wp_remote_retrieve_response_code($r) { return $r['code']; }
    function wp_remote_retrieve_body($r) { return $r['body']; }
    // Pass uses: a conditional decrement under an exclusive lock (atomic, like store.php's UPDATE ... WHERE value > 0).
    function toll_gate_consume(string $jti, int $n, int $exp): int {
        $f = $GLOBALS['gate']['store'];
        $h = fopen($f, 'c+');
        flock($h, LOCK_EX);
        $all = json_decode((string) stream_get_contents($h), true) ?: [];
        $all[$jti] ??= $n;
        $left = $all[$jti] > 0 ? --$all[$jti] : -1;
        ftruncate($h, 0); rewind($h); fwrite($h, json_encode($all)); fflush($h);
        flock($h, LOCK_UN); fclose($h);
        return $left;
    }
    function toll_gate_first_use(string $id, int $exp): bool { return true; }
    function toll_gate_uses_left(string $jti, int $n, int $exp): int {
        $all = json_decode((string) @file_get_contents($GLOBALS['gate']['store']), true) ?: [];
        return $all[$jti] ?? $n;
    }
    function wc_notice_count(string $type = ''): int { return $GLOBALS['gate']['notices']; }
    STUBS);
}

// ---------------------------------------------------------------------------------------------------
// Parent: cases and checks.
// ---------------------------------------------------------------------------------------------------

$pass = 0;
$fail = 0;
$tmp = sys_get_temp_dir() . '/toll-gate-' . getmypid();
@mkdir($tmp);

/** Runs one case in a child process. $o['store'] is filled in; $o['pass'] gets a fresh jti. */
function run_case(string $flow, array $o): array
{
    global $tmp;
    $o['flow'] = $flow;
    $o['store'] ??= $tmp . '/' . bin2hex(random_bytes(6)) . '.json';
    if (isset($o['pass'])) $o['pass'] += ['jti' => bin2hex(random_bytes(16)), 'iat' => time()];
    $GLOBALS['last_pass'] = $o['pass'] ?? null;
    $cmd = [PHP_BINARY, GATE_CASES, '--case', $flow, json_encode($o)];
    $p = proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    $code = proc_close($p);
    $r = json_decode((string) $out, true);
    if ($code !== 0 || !is_array($r)) throw new \RuntimeException("case $flow exited $code: $err $out");
    return $r + ['opts' => $o];
}

function check(string $label, bool $ok, mixed $detail = null): void
{
    global $pass, $fail;
    if ($ok) { $pass++; echo "ok   $label\n"; return; }
    $fail++;
    echo "FAIL $label" . ($detail === null ? '' : ': ' . json_encode($detail, JSON_UNESCAPED_SLASHES)) . "\n";
}

$is402 = fn (array $s) => $s['status'] === 402 && $s['body']['error'] === 'payment_required' && $s['body']['offers'][0]['id'] === 'off_1'
    && str_contains($s['body']['challenge_url'], 'action=write') && str_contains($s['body']['challenge_url'], 'offers=0') && str_contains($s['body']['challenge_url'], 'client=agent');
$is403work = fn (array $s) => $s['status'] === 403 && $s['body']['error'] === 'toll_required' && ($s['body']['challenge']['bound']['action'] ?? null) === 'write';
$offerCall = fn (array $r) => count($r['calls']) === 1 && $r['calls'][0]['url'] === 'http://127.0.0.1:9/v1/owner/offers' && $r['calls'][0]['body']['action'] === 'write' && $r['calls'][0]['body']['net'] === '203.0.113.0/24';
$both = ['woo' => 1, 'cf7' => 1];

// -- hooks: registered only when the plugin is active and its form is ticked -----------------------
$r = run_case('none', ['woo' => 0, 'cf7' => 0]);
check('neither WooCommerce nor CF7 active, both ticked: no woocommerce, wpcf7 or REST hook', !array_filter($r['hooks'], fn ($h) => preg_match('/^(woocommerce_|wpcf7_|rest_)/', $h)), $r['hooks']);
$r = run_case('none', $both + ['woo_on' => 0, 'cf7_on' => 0]);
check('both active, neither ticked: no woocommerce, wpcf7 or REST hook', !array_filter($r['hooks'], fn ($h) => preg_match('/^(woocommerce_|wpcf7_|rest_)/', $h)), $r['hooks']);
$r = run_case('none', $both);
check('both active and ticked: checkout validation, CF7 spam and REST dispatch hooks', !array_diff(['woocommerce_after_checkout_validation', 'wpcf7_spam', 'rest_dispatch_request'], $r['hooks']), $r['hooks']);
$r = run_case('none', ['woo' => 1, 'cf7' => 0]);
check('WooCommerce only: no wpcf7 hook', !array_filter($r['hooks'], fn ($h) => str_starts_with($h, 'wpcf7_')), $r['hooks']);

// -- the refusal itself: same contract as comments and login ----------------------------------------
$r = run_case('refusal', $both + ['agent' => 1]);
[$st, $body, $hdr] = $r['result'];
check('refusal: 402, payment_required, relayed offers, challenge_url, WWW-Authenticate exposed', $is402(['status' => $st, 'body' => $body]) && $hdr === ['WWW-Authenticate' => 'L402 macaroon="mac", invoice="lnstub1test"', 'Access-Control-Expose-Headers' => 'WWW-Authenticate'], $r['result']);
$r = run_case('comment', $both + ['agent' => 1, 'uri' => '/wp-comments-post.php']);
check('comments still get the same 402 (shared refusal)', $r['sent'] !== null && $is402($r['sent']) && str_contains($r['sent']['body']['challenge_url'], 'path=%2Fwp-comments-post.php'), $r['sent']);

// -- WooCommerce classic checkout -------------------------------------------------------------------
$c = $both + ['uri' => '/checkout/'];
$r = run_case('classic', $c + ['agent' => 1]);
check('classic, agent, no pass: 402 relayed from the payment server', $r['sent'] !== null && $is402($r['sent']) && $offerCall($r), $r);
check('classic, agent, no pass: counts pass_absent and offer_shown, no order', $r['counts'] === ['offer_shown' => 1, 'pass_absent' => 1] && $r['events'] === [], $r['counts']);
$r = run_case('classic', $c + ['agent' => 1, 'server' => 'down']);
check('classic, agent, payment server down: 403 work check, turned_away, no order', $r['sent'] !== null && $is403work($r['sent']) && ($r['counts']['turned_away'] ?? 0) === 1 && !isset($r['counts']['offer_shown']) && $r['events'] === [], $r);
$r = run_case('classic', $c + ['agent' => 1, 'mode' => 'test']);
check('classic, agent, Test mode: 403 work check and no call to any server', $r['sent'] !== null && $is403work($r['sent']) && $r['calls'] === [], $r);
$r = run_case('classic', $c + ['agent' => 1, 'field_error' => 1]);
check('classic, agent, WooCommerce field errors: no 402, no server call, only the field error', $r['sent'] === null && $r['result'] === ['billing_email_required'] && $r['calls'] === [] && $r['counts'] === [], $r);
$r = run_case('classic', $c + ['agent' => 1, 'field_error' => 1, 'pass' => ['n' => 1]]);
check('classic, agent, valid pass but field errors: nothing spent', $r['sent'] === null && $r['left'] === null, $r);
$r = run_case('classic', $c + ['agent' => 1, 'pass' => ['n' => 1]]);
check('classic, agent, valid one-use pass: order created, exactly one use spent', $r['sent'] === null && $r['events'] === ['order_created'] && $r['left'] === 0 && $r['counts'] === ['pass_accept' => 1], $r);
$r = run_case('classic', $c + ['human' => 1]);
check('classic, human, no pass: the form error as before, no 402, no order', $r['sent'] === null && $r['result'] === ['toll_required'] && $r['events'] === [] && $r['counts'] === ['pass_absent' => 1, 'turned_away' => 1], $r);
$r = run_case('classic', $c + ['field_error' => 1]);
check('classic, human, field errors: the toll error is still added (unchanged)', $r['result'] === ['billing_email_required', 'toll_required'], $r['result']);
$r = run_case('classic', $c + ['pass' => ['n' => 20, 'via' => 'post']]);
check('classic, human, valid pass in the form: order created, one use spent', $r['events'] === ['order_created'] && $r['left'] === 19, $r);

// -- Contact Form 7 over REST -----------------------------------------------------------------------
$f = $both + ['uri' => '/wp-json/contact-form-7/v1/contact-forms/12/feedback'];
$r = run_case('cf7_rest', $f + ['agent' => 1]);
$rest = $r['result']['rest'] ?? null;
check('CF7 REST, agent, no pass: 402 instead of the route, WWW-Authenticate exposed, no mail', is_array($rest) && $is402($rest) && $rest['headers']['WWW-Authenticate'] === 'L402 macaroon="mac", invoice="lnstub1test"' && $rest['headers']['Access-Control-Expose-Headers'] === 'WWW-Authenticate' && str_contains($rest['headers']['Cache-Control'] ?? '', 'no-store') && $r['events'] === [], $r);
check('CF7 REST, agent, no pass: counts pass_absent and offer_shown', $r['counts'] === ['offer_shown' => 1, 'pass_absent' => 1], $r['counts']);
$r = run_case('cf7_rest', $f + ['agent' => 1, 'server' => 'down']);
check('CF7 REST, agent, payment server down: 403 work check', is_array($r['result']['rest'] ?? null) && $is403work($r['result']['rest']) && $r['events'] === [], $r);
$r = run_case('cf7_rest', $f + ['agent' => 1, 'pass' => ['n' => 1]]);
check('CF7 REST, agent, valid one-use pass: route runs, mail sent, exactly one use spent (in wpcf7_spam)', $r['result']['rest'] === null && $r['result']['cf7'] === 'mail_sent' && $r['left'] === 0 && $r['counts'] === ['pass_accept' => 1], $r);
$r = run_case('cf7_rest', $f + ['agent' => 1, 'pass' => ['n' => 1], 'invalid' => 1]);
check('CF7 REST, agent, valid pass, CF7 validation fails: nothing spent, no mail', $r['result']['cf7'] === 'validation_failed' && $r['left'] === null && $r['events'] === [], $r);
$r = run_case('cf7_rest', $f + ['agent' => 1, 'pass' => ['n' => 1], 'race' => 1]);
check('CF7 REST, agent, last use spent by another request after the look: 402 from wpcf7_spam, no mail', $r['sent'] !== null && $is402($r['sent']) && $r['events'] === [] && $r['left'] === 0, $r);
$r = run_case('cf7_rest', $f + ['agent' => 1, 'pass' => ['n' => 1], 'already_spam' => 1]);
check('CF7 REST, agent, already spam by another filter: stays spam, nothing spent', $r['result']['cf7'] === 'spam' && $r['left'] === null, $r);
$r = run_case('cf7_rest', $f + ['agent' => 1, 'method' => 'GET', 'dispatch_only' => 1]);
check('CF7 REST, agent, GET: not gated', $r['result']['rest'] === null && $r['calls'] === [], $r);
$r = run_case('cf7_rest', $f + ['agent' => 1, 'route' => '/wp/v2/posts', 'dispatch_only' => 1]);
check('another REST route: not gated', $r['result']['rest'] === null && $r['calls'] === [], $r);
$r = run_case('cf7_rest', $f);
check('CF7 REST, human, no pass: route runs, marked spam (unchanged), no mail', $r['result']['rest'] === null && $r['result']['cf7'] === 'spam' && $r['events'] === [] && $r['counts'] === ['pass_absent' => 1, 'turned_away' => 1], $r);
$r = run_case('cf7_rest', $f + ['pass' => ['n' => 20, 'via' => 'post']]);
check('CF7 REST, human, valid pass in the form: mail sent, one use spent', $r['result']['cf7'] === 'mail_sent' && $r['left'] === 19, $r);

// -- Contact Form 7 non-JS post ---------------------------------------------------------------------
$p = $both + ['uri' => '/contact/'];
$r = run_case('cf7_post', $p + ['agent' => 1]);
check('CF7 non-JS post, agent, no pass: 402 from wpcf7_spam, no mail', $r['sent'] !== null && $is402($r['sent']) && str_contains($r['sent']['body']['challenge_url'], 'path=%2Fcontact%2F') && $r['events'] === [], $r);
$r = run_case('cf7_post', $p + ['agent' => 1, 'mode' => 'test']);
check('CF7 non-JS post, agent, Test mode: 403 work check, no mail', $r['sent'] !== null && $is403work($r['sent']) && $r['events'] === [], $r);
$r = run_case('cf7_post', $p + ['agent' => 1, 'server' => 'down']);
check('CF7 non-JS post, agent, payment server down: 403 work check, no mail', $r['sent'] !== null && $is403work($r['sent']) && $r['events'] === [], $r);
$r = run_case('cf7_post', $p + ['agent' => 1, 'pass' => ['n' => 1]]);
check('CF7 non-JS post, agent, valid one-use pass: mail sent, exactly one use spent, one pass_accept', $r['sent'] === null && $r['events'] === ['mail_sent'] && $r['left'] === 0 && $r['counts'] === ['pass_accept' => 1], $r);
$r = run_case('cf7_post', $p);
check('CF7 non-JS post, human, no pass: spam (unchanged)', $r['result']['cf7'] === 'spam' && $r['sent'] === null, $r);

// -- criterion 2: the offers call uses the settlement timeout, so a slow server can't hold a checkout
$r = run_case('classic', $c + ['agent' => 1]);
check('classic: the payment server gets 1.5 s at most (TOLL_GATE_OFFER_TIMEOUT_S)', ($r['calls'][0]['timeout'] ?? null) === 1.5, $r['calls']);
$r = run_case('classic', $c + ['agent' => 1, 'notice_error' => 1]);
check('classic, agent, cart error notice (e.g. out of stock): no 402, nothing spent, no server call', $r['sent'] === null && $r['calls'] === [] && $r['counts'] === [] && $r['events'] === [], $r);
$r = run_case('classic', $c + ['agent' => 1, 'notice_error' => 1, 'pass' => ['n' => 1]]);
check('classic, agent, valid pass, cart error notice: pass unused', $r['left'] === null && $r['counts'] === [], $r);
$r = run_case('classic', $c + ['agent' => 1, 'update_totals' => 1, 'pass' => ['n' => 1]]);
check('classic, agent, totals refresh only: pass unused, no 402', $r['sent'] === null && $r['left'] === null && $r['counts'] === [], $r);

// -- criterion 5: one check counts once, across a rejection and a resubmit --------------------------
/** Runs the same flow several times as separate requests sharing one store and one pass; sums the counts. */
function sequence(string $flow, array $base, array $steps): array
{
    global $tmp;
    $store = $tmp . '/seq-' . bin2hex(random_bytes(6)) . '.json';
    $pass = ['n' => 1, 'jti' => bin2hex(random_bytes(16)), 'iat' => time()];
    $sum = [];
    $sent = [];
    $through = 0;
    foreach ($steps as $step) {
        $o = $base + $step + ['store' => $store];
        if (!empty($step['with_pass'])) $o['pass'] = $pass;
        unset($o['with_pass']);
        $r = run_case($flow, $o);
        foreach ($r['counts'] as $k => $n) $sum[$k] = ($sum[$k] ?? 0) + $n;
        $rest = $r['result']['rest'] ?? null;
        $sent[] = $r['sent']['status'] ?? (is_array($rest) ? $rest['status'] : null);
        if (array_intersect(['order_created', 'mail_sent'], $r['events'])) $through++;
    }
    ksort($sum);
    return ['counts' => $sum, 'statuses' => $sent, 'through' => $through, 'left' => json_decode((string) file_get_contents($store), true)[$pass['jti']] ?? null];
}
$paths = ['classic' => $c, 'cf7_rest' => $f, 'cf7_post' => $p];
$invalid = ['classic' => ['field_error' => 1], 'cf7_rest' => ['invalid' => 1], 'cf7_post' => ['invalid' => 1]];
foreach ($paths as $flow => $base) {
    $base += ['agent' => 1];
    $s = sequence($flow, $base, [[], ['with_pass' => 1]]);
    check("$flow: no pass (402), then resubmit with a paid pass: one 402, one offer_shown, one pass_accept", $s['statuses'] === [402, null] && $s['through'] === 1 && $s['counts'] === ['offer_shown' => 1, 'pass_absent' => 1, 'pass_accept' => 1] && $s['left'] === 0, $s);
    $s = sequence($flow, $base, [['with_pass' => 1], ['with_pass' => 1]]);
    check("$flow: the same one-use pass submitted twice: one goes through, the second gets one 402; one pass_accept, one pass_reject", $s['statuses'] === [null, 402] && $s['through'] === 1 && $s['counts'] === ['offer_shown' => 1, 'pass_accept' => 1, 'pass_reject' => 1] && $s['left'] === 0, $s);
    $s = sequence($flow, $base, [['with_pass' => 1] + $invalid[$flow], ['with_pass' => 1]]);
    check("$flow: validation fails, then resubmit with the same pass: it works; no 402, exactly one pass_accept", $s['statuses'] === [null, null] && $s['through'] === 1 && $s['counts'] === ['pass_accept' => 1] && $s['left'] === 0, $s);
}

// -- block checkout (Store API) is not covered: exactly stock behavior ------------------------------
foreach ([['agent' => 1], [], ['agent' => 1, 'pass' => ['n' => 1]]] as $who) {
    foreach ([['woo' => 1, 'cf7' => 1], ['woo' => 1, 'cf7' => 0, 'cf7_on' => 0]] as $plugins) {
        $label = (isset($who['agent']) ? 'declared agent' : 'browser buyer') . (isset($who['pass']) ? ' with a pass' : '') . ($plugins['cf7'] ? ', CF7 on too' : ', WooCommerce only');
        $r = run_case('store_api', $plugins + $who + ['uri' => '/wp-json/wc/store/v1/checkout']);
        $acted = array_filter($r['ran'], fn ($x) => $x[1] === 'changed' || str_starts_with($x[0], 'woocommerce_') || $x[0] === 'rest_request_before_callbacks' || $x[0] === 'rest_request_after_callbacks');
        check("block checkout, $label: order placed as stock; no 402/403, no counter, no server call, nothing spent, no Toll callback acts", $r['sent'] === null && $r['result']['halted'] === false && $r['events'] === ['order_created'] && $r['counts'] === [] && $r['calls'] === [] && $r['left'] === null && $acted === [], $r);
        if (!$plugins['cf7']) check("block checkout, $label: no Toll callback runs at all", $r['ran'] === [], $r['ran']);
    }
}
$r = run_case('none', ['woo' => 1, 'cf7' => 1]);
check('no woocommerce_store_api_* hook is registered', !array_filter($r['hooks'], fn ($h) => str_starts_with($h, 'woocommerce_store_api_')), $r['hooks']);

// -- criterion 8: the admin help line, and no doc says the block checkout is protected ---------------
$pd = dirname(__DIR__, 2) . '/packages/wp-toll-gate/';
check('admin: the WooCommerce help line is the PM\'s exact words and is shown under the option', str_contains((string) file_get_contents($pd . 'includes/strings.php'), "'woo_help' => \"Covers the classic checkout. The newer block checkout isn't covered yet.\"") && str_contains((string) file_get_contents($pd . 'includes/admin.php'), "toll_gate_s('woo_help')"));
$claims = [];
foreach (['packages/wp-toll-gate/README.md', 'docs/settlement.md', 'docs/protocol.md', 'packages/wp-toll-gate/includes/gate.php'] as $doc) {
    foreach (preg_split('/(?<=[.:;])\s+/', (string) file_get_contents(dirname(__DIR__, 2) . '/' . $doc)) as $sentence) {
        if (stripos($sentence, 'block checkout') !== false && !preg_match("/isn't covered|not covered|stock behavior|nothing here|adds nothing|no 402/i", $sentence)) $claims[] = "$doc: $sentence";
    }
}
check('docs: every sentence that names the block checkout says it isn\'t covered', $claims === [], $claims);

// -- two requests, one pass with one use left: exactly one goes through -----------------------------
foreach (['classic' => $c, 'cf7_rest' => $f] as $flow => $base) {
    $store = $tmp . '/race-' . $flow . '.json';
    $o = $base + ['agent' => 1, 'store' => $store, 'pass' => ['n' => 1, 'jti' => bin2hex(random_bytes(16)), 'iat' => time()], 'start' => microtime(true) + 0.4];
    $procs = [];
    for ($i = 0; $i < 2; $i++) {
        $procs[] = proc_open([PHP_BINARY, GATE_CASES, '--case', $flow, json_encode($o + ['flow' => $flow])], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes[$i]);
    }
    $res = [];
    foreach ($procs as $i => $pr) { $res[] = json_decode((string) stream_get_contents($pipes[$i][1]), true); proc_close($pr); }
    $through = count(array_filter($res, fn ($x) => in_array('order_created', $x['events'], true) || in_array('mail_sent', $x['events'], true)));
    // The loser is refused at the spend, or at the look if the winner already spent (both are 402s).
    $refused = count(array_filter($res, fn ($x) => ($x['sent'] !== null && $is402($x['sent'])) || (is_array($x['result']['rest'] ?? null) && $is402($x['result']['rest']))));
    check("$flow: two requests race for one pass's last use: exactly one goes through, the other gets the 402", $through === 1 && $refused === 1, $res);
}

array_map('unlink', glob($tmp . '/*') ?: []);
@rmdir($tmp);
echo "\nPHP " . PHP_VERSION . " gate: $pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
