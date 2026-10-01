<?php
// Loads the Toll PHP library (packages/server-php): the plugin zip bundles it under lib/server-php;
// in the repo it is read from ../server-php. Its pinned work engine verifies solutions locally.
declare(strict_types=1);

if (!defined('ABSPATH')) exit;

(function (): void {
    foreach ([TOLL_GATE_DIR . '/lib/server-php', dirname(TOLL_GATE_DIR) . '/server-php'] as $dir) {
        if (is_file($dir . '/vendor/autoload.php')) {
            require_once $dir . '/vendor/autoload.php';
            return;
        }
    }
})();

function toll_gate_lib_ok(): bool
{
    return class_exists('\\Toll\\Protocol') && class_exists('\\Toll\\Policy') && class_exists('\\Toll\\Settlement');
}
