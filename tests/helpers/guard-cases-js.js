// Runs tests/fixtures/guard-cases.json through the reference implementation (hooks/lib/url-guard.js). Prints "OK" or each mismatch.
const path = require('path');
const { decide } = require(path.join(__dirname, '..', '..', 'hooks', 'lib', 'url-guard.js'));
const t = require(path.join(__dirname, '..', 'fixtures', 'guard-cases.json'));
let bad = 0;
for (const c of t.cases) for (const mode of ['enforce', 'warn']) {
  const r = decide(c.url, { ...t.configs[c.config], mode });
  if (r.decision !== c.expect[mode] || r.reason !== c.reason) { bad += 1; console.log('MISMATCH', mode, JSON.stringify(c.url), '->', r.decision, r.reason, '| expected', c.expect[mode], c.reason); }
}
console.log(bad ? `${bad} mismatches` : 'OK');
process.exit(bad ? 1 : 0);
