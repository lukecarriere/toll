# WordPress plugin

The download page serves the Toll Gate zip built from this repo. The zip is the plugin a site owner installs. The header name is Toll Gate and the licence is GPL-2.0-or-later.

## Sub-features

- `wp-download` links a `toll-gate-*.zip` from the download page.
- `wp-checksum` matches the sibling `.sha256` file.
- `wp-header` names the plugin Toll Gate and states `GPL-2.0-or-later`.
- `wp-archive` passes `unzip -t`.

## How to get to it (user POV)

- Open Download on the site or the worker.
- Download the zip and the `.sha256` file beside it.
- Install that zip in WordPress. This journey stops at the archive. It does not open wp-admin unless a local WordPress is already on port 8888, and even then it records that the admin UI was not driven.

## Driving it with curl and node

Preconditions:

- The static site or the worker is serving `website/dist`, and `dist-release/` was copied into the download page by the build.

- **Find the zip.** Fetch `download/index.html` on the static site, or `/download` on the worker. Take the first `/download/toll-gate-` href that ends in `.zip`.
- **Checksum.** Download the zip and the `.sha256` next to it. `sha256sum -c` prints `OK`.
- **Archive.** `unzip -t` exits 0.
- **Header.** `unzip -p <zip> toll-gate/toll-gate.php` contains `Plugin Name: Toll Gate` and `GPL-2.0-or-later`.
- **Live admin.** If `http://127.0.0.1:8888/` does not answer, record `wordpress live: not running`. Do not mark the admin UI verified.

## Gotchas

- The checksum file names the zip basename. Run `sha256sum -c` from the directory that contains that basename.
- A directory inside the plugin tree is not a file. Trust `unzip -t`, not a hand-rolled copy.
- Plugin Check flags WordPress in the Plugin Name header. The header on this journey is Toll Gate.
