"""Runs tests/fixtures/guard-cases.json through a Python runtime guard. Usage: python3 guard-cases-py.py <template dir (pytest|selenium)>
Prints "OK" or each mismatch."""
import json, os, sys
sys.path.insert(0, sys.argv[1])
from support.prod_guard import decide_url
t = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fixtures', 'guard-cases.json')))
bad = 0
for c in t['cases']:
    for mode in ('enforce', 'warn'):
        r = decide_url(c['url'], {**t['configs'][c['config']], 'mode': mode})
        if r['decision'] != c['expect'][mode] or r['reason'] != c['reason']:
            bad += 1
            print('MISMATCH', mode, json.dumps(c['url']), '->', r['decision'], r['reason'], '| expected', c['expect'][mode], c['reason'])
print('OK' if not bad else '%d mismatches' % bad)
sys.exit(1 if bad else 0)
