<?php
// Router for PHP's built-in web server (local development only): serve real files as-is, send
// everything else to WordPress so pretty permalinks and /wp-json/ work.
$root = $_SERVER['DOCUMENT_ROOT'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$file = realpath($root . $path);
if ($path !== '/' && $file !== false && is_file($file) && !str_ends_with($file, '.php')) return false;
if ($file !== false && is_file($file) && str_ends_with($file, '.php')) {
    $_SERVER['SCRIPT_NAME'] = $path;
    $_SERVER['SCRIPT_FILENAME'] = $file;
    $_SERVER['PHP_SELF'] = $path;
    chdir(dirname($file));
    require $file;
    return true;
}
if ($file !== false && is_dir($file) && is_file($file . '/index.php')) {
    $_SERVER['SCRIPT_NAME'] = rtrim($path, '/') . '/index.php';
    $_SERVER['SCRIPT_FILENAME'] = $file . '/index.php';
    chdir($file);
    require $file . '/index.php';
    return true;
}
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = $root . '/index.php';
require $root . '/index.php';
