#!/usr/bin/env python3
# Summarize a redacted wrangler tail capture: per event version, entrypoint, rpc/url, status, log events (shape only), exceptions.
#   python3 scripts/tail-summary.py out/tail-raw.jsonl out/tail-summary.json
import sys, json
raw = open(sys.argv[1]).read(); dec = json.JSONDecoder(); i = 0; out = []
while True:
    while i < len(raw) and raw[i] not in '{': i += 1
    if i >= len(raw): break
    try: o, j = dec.raw_decode(raw, i)
    except Exception: i += 1; continue
    i = j; ev = o.get('event') or {}
    logs = []
    for l in o.get('logs', []):
        for m in l.get('message', []):
            try: mo = json.loads(m) if isinstance(m, str) else m
            except Exception: mo = str(m)[:160]
            logs.append(mo)
    out.append({'t': o.get('eventTimestamp'), 'ver': (o.get('scriptVersion') or {}).get('id', '')[:8], 'ep': o.get('entrypoint'),
                'rpc': ev.get('rpcMethod'), 'req': (ev.get('request') or {}).get('method', '') + ' ' + str((ev.get('request') or {}).get('url', ''))[:80],
                'status': (ev.get('response') or {}).get('status'), 'outcome': o.get('outcome'), 'logs': logs, 'exceptions': [str(x)[:200] for x in o.get('exceptions', [])]})
json.dump(out, open(sys.argv[2], 'w'), indent=1)
mi = [e for e in out if any(isinstance(l, dict) and l.get('event') == 'mint_inconclusive' for l in e['logs'])]
s5 = [e for e in out if (e['status'] or 0) >= 500]
print(json.dumps({'events': len(out), 'versions': sorted({e['ver'] for e in out}), 'rpcs': sorted({e['rpc'] for e in out if e['rpc']}),
  'mint_inconclusive': [l for e in mi for l in e['logs'] if isinstance(l, dict) and l.get('event') == 'mint_inconclusive'],
  'status5xx': len(s5), 'exceptions': sum(len(e['exceptions']) for e in out),
  'logEvents': sorted({l.get('event') for e in out for l in e['logs'] if isinstance(l, dict) and l.get('event')})}))
