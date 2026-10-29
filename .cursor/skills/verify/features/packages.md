# npm packages

`@lessspam/server`, `@lessspam/agent`, `@lessspam/widget`, and `@lessspam/mcp` are the published Node entry points. The PHP library ships beside them and is what the plugin loads.

## Sub-features

- `pkg-server` exports version `1.0.0`.
- `pkg-agent` exports `createAgent` and `cashuPayer`.
- `pkg-widget` points `tollJs` at a built `toll.js`.
- `pkg-mcp` lists the three write tools.
- `pkg-php` loads `Toll\Protocol` and `Toll\Settlement`.

## How to get to it (user POV)

- A site owner installs the packages and imports them from the built `dist`.
- A PHP site loads the library through Composer.

## Driving it with curl and node

Preconditions:

- `npm test` has built `packages/*/dist`.
- `composer install` has written `packages/server-php/vendor/autoload.php`.

- **Node imports.** Run the package program in `SKILL.md`. Stdout is `packages ok 1.0.0 price_write_action,gate_form_write,verify_write_pass`, then `cashu payer ok`.
- **Widget file.** The same program stats `toll.js` and requires a size of at least 100 bytes.
- **PHP classes.** `php -r` with the Composer autoload prints `php ok` when both classes exist.

## Gotchas

- Import `dist`, not `src`, for this journey. `src` is the workspace TypeScript.
- Do not `npm publish`. The check is a local import.
