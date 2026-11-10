// The lists the production-URL decision depends on must be IDENTICAL in every implementation of it. The shared case table proves
// behavior on the cases written down; this proves the data behind it cannot quietly differ (a staging token present in one guard and
// missing from another). Prints "OK" or what differs.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const FILES = {
  'hooks/lib/url-guard.js': { js: true },
  'templates/e2e/playwright/support/prod-guard.ts': { js: true },
  'templates/e2e/cypress/support/prod-guard.ts': { js: true },
  'templates/e2e/webdriverio/support/prod-guard.ts': { js: true },
  'templates/e2e/pytest/support/prod_guard.py': { py: true },
  'templates/e2e/selenium/support/prod_guard.py': { py: true },
  'templates/e2e/rspec/spec/support/prod_guard.rb': { rb: true },
};
const NAMES = ['NONPROD_TOKENS', 'PROD_TOKENS', 'RESERVED_TLDS', 'DOC_HOSTS', 'BUILTIN_EXEMPT_HOSTS'];

function listOf(src, name, kind) {
  const re = kind === 'py' ? new RegExp(`(?<![A-Za-z])_${name}\\s*=\\s*[\\[{]([\\s\\S]*?)[\\]}]\\s*\\n`)
    : kind === 'rb' ? new RegExp(`(?<![A-Za-z])${name}\\s*=\\s*%w\\[([\\s\\S]*?)\\]`)
      : new RegExp(`(?<![A-Za-z])${name}\\s*=\\s*(?:new Set\\()?\\[([\\s\\S]*?)\\]`);
  const m = re.exec(src);
  if (!m) return null;
  return (kind === 'rb' ? m[1].split(/\s+/) : [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] || x[2])).filter(Boolean).sort();
}

const problems = [];
const reference = {};
const refSrc = fs.readFileSync(path.join(root, 'hooks/lib/url-guard.js'), 'utf8');
for (const n of NAMES) { reference[n] = listOf(refSrc, n, 'js'); if (!reference[n] || !reference[n].length) problems.push(`reference: cannot read ${n}`); }
for (const [file, kind] of Object.entries(FILES)) {
  const k = kind.py ? 'py' : kind.rb ? 'rb' : 'js';
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  for (const n of NAMES) {
    const got = listOf(src, n, k);
    if (!got) { problems.push(`${file}: cannot find ${n}`); continue; }
    if (JSON.stringify(got) !== JSON.stringify(reference[n])) {
      const missing = reference[n].filter((x) => !got.includes(x)); const extra = got.filter((x) => !reference[n].includes(x));
      problems.push(`${file}: ${n} differs from the reference (missing: [${missing}], extra: [${extra}])`);
    }
  }
}
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
console.log('OK');
