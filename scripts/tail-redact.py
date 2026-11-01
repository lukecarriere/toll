#!/usr/bin/env python3
# stdin: wrangler tail --format json; stdout: same with payment and pass values redacted. Line-buffered.
#   npx wrangler tail toll-site --format json | python3 scripts/tail-redact.py > out/tail-raw.jsonl
import sys, re
pat = re.compile(r'(cashu[AB]|creqA|eyJ)[A-Za-z0-9_\-+/=.]{20,}|((?:Toll|Bearer|L402)\s+)[A-Za-z0-9_\-+/=.:]{20,}')
for line in sys.stdin:
    sys.stdout.write(pat.sub(lambda m: f'<{(m.group(1) or m.group(2).strip())} redacted {len(m.group(0))}>', line)); sys.stdout.flush()
