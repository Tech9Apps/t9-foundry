// Runs tests/fixtures/guard-cases.json through a TypeScript runtime guard. Usage: node --experimental-strip-types guard-cases-ts.mjs <prod-guard.ts>
// Prints "OK" or each mismatch.
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const mod = await import(pathToFileURL(process.argv[2]).href);
const t = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'guard-cases.json'), 'utf8'));
let bad = 0;
for (const c of t.cases) for (const mode of ['enforce', 'warn']) {
  const r = mod.decideUrl(c.url, { ...t.configs[c.config], mode });
  if (r.decision !== c.expect[mode] || r.reason !== c.reason) { bad += 1; console.log('MISMATCH', mode, JSON.stringify(c.url), '->', r.decision, r.reason, '| expected', c.expect[mode], c.reason); }
}
console.log(bad ? `${bad} mismatches` : 'OK');
process.exit(bad ? 1 : 0);
