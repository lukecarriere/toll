#!/usr/bin/env bash
# Homepage fonts (design handoff §2). Run by hand when a source font changes; the WOFF2 files and the
# two OFL texts it writes under website/fonts/ are committed, so the website build needs no font tools.
#   Toll Slab = Arvo Bold. Arvo has a Reserved Font Name, so it is converted to WOFF2 whole (every glyph,
#     table and name record kept). Never subset it: a subset is a modified font that may not be called Arvo.
#   Toll Sans = Public Sans variable (wght 100-900). No reserved name: subset to Latin, all layout
#     features and the weight axis kept, then WOFF2.
# Needs fontTools with brotli (the `fonttools` and `pyftsubset` commands). Install them in a venv, never
# system-wide, e.g.: python3 -m venv <dir> && <dir>/bin/pip install fonttools brotli
# Usage: FONTTOOLS=<dir>/bin/fonttools PYFTSUBSET=<dir>/bin/pyftsubset scripts/website-fonts.sh [source dir]
# The source dir defaults to design/brand/fonts (gitignored, next to the repo) and must hold
# Arvo-Bold.ttf, PublicSans-VariableFont_wght.ttf, OFL-Arvo.txt and OFL-PublicSans.txt.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC=${1:-$ROOT/design/brand/fonts}
OUT=$ROOT/website/fonts
FONTTOOLS=${FONTTOOLS:-fonttools}
PYFTSUBSET=${PYFTSUBSET:-pyftsubset}
# Latin: Basic Latin, Latin-1, common punctuation and symbols (the same ranges as the usual "latin" web subset).
LATIN="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"

for f in Arvo-Bold.ttf PublicSans-VariableFont_wght.ttf OFL-Arvo.txt OFL-PublicSans.txt; do
  [ -f "$SRC/$f" ] || { echo "website-fonts: missing $SRC/$f" >&2; exit 1; }
done
mkdir -p "$OUT/arvo" "$OUT/public-sans"

"$FONTTOOLS" ttLib.woff2 compress -o "$OUT/arvo/Arvo-Bold.woff2" "$SRC/Arvo-Bold.ttf"
"$PYFTSUBSET" "$SRC/PublicSans-VariableFont_wght.ttf" --unicodes="$LATIN" --layout-features='*' \
  --flavor=woff2 --output-file="$OUT/public-sans/PublicSans-Latin.woff2"

# Licence texts ship unchanged next to each font. LICENSE.txt is the name the repo's host scan treats as a
# licence text (scripts/host-scan.ts excludedPath), since the OFL texts carry their authors' URLs.
cp "$SRC/OFL-Arvo.txt" "$OUT/arvo/LICENSE.txt"
cp "$SRC/OFL-PublicSans.txt" "$OUT/public-sans/LICENSE.txt"

ls -l "$OUT/arvo" "$OUT/public-sans"
