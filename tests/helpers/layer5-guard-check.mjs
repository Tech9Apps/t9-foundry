// Exercises a Layer 5 prod-guard.ts (playwright/cypress/webdriverio — same contract).
// Usage: node --experimental-strip-types tests/helpers/layer5-guard-check.mjs <path-to-prod-guard.ts>
// Prints "OK" on success; prints each failed expectation and exits 1 otherwise.
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(process.argv[2]).href);
const { validateNotProduction, guardOptionsFromConfig } = mod;

const failures = [];
const expect = (name, cond) => { if (!cond) failures.push(name); };

function run(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  let error = null;
  try { fn(); } catch (e) { error = e; } finally { console.warn = orig; }
  return { error, warnings };
}

delete process.env.QA_AUTONOMOUS;

// 1. A configured production pattern always throws.
let r = run(() => validateNotProduction('https://myapp.example.com/', ['myapp\\.example\\.com']));
expect('configured pattern throws', r.error && r.error.message.includes('PRODUCTION GUARD'));

// 2. warn mode (default): heuristic match only warns.
r = run(() => validateNotProduction('https://otherapp.io/', []));
expect('warn mode does not throw', r.error === null);
expect('warn mode warns', r.warnings.length === 1);

// 3. The heuristic still runs when patterns ARE configured.
r = run(() => validateNotProduction('https://otherapp.io/', ['myapp\\.example\\.com']));
expect('heuristic runs alongside configured patterns', r.warnings.length === 1);

// 4. enforce via option: heuristic match throws.
r = run(() => validateNotProduction('https://otherapp.io/', ['x'], { enforce: true }));
expect('enforce option throws on heuristic match', r.error && r.error.message.includes('PRODUCTION GUARD'));

// 5. enforce via QA_AUTONOMOUS=1 with no options.
process.env.QA_AUTONOMOUS = '1';
r = run(() => validateNotProduction('https://otherapp.io/', ['x']));
expect('QA_AUTONOMOUS=1 enforces by default', r.error && r.error.message.includes('PRODUCTION GUARD'));
delete process.env.QA_AUTONOMOUS;

// 6. A staging URL passes in enforce mode when the production pattern is anchored to the production host ...
r = run(() => validateNotProduction('https://staging.myapp.example.com', ['://myapp\\.example\\.com/'], { enforce: true }));
expect('staging URL passes in enforce mode', r.error === null && r.warnings.length === 0);
// ... and an UNANCHORED pattern matches every host that merely ends in it, staging included: authors should anchor theirs.
r = run(() => validateNotProduction('https://staging.myapp.example.com', ['myapp\\.example\\.com/'], { enforce: true }));
expect('an unanchored pattern also catches the staging subdomain (documented: anchor your patterns)', r.error && r.error.message.includes('PRODUCTION GUARD'));

// 7. allowedUrlPatterns exempts a URL from the heuristic only.
r = run(() => validateNotProduction('https://partner.io/guide', [], { enforce: true, allowedUrlPatterns: ['partner\\.io/guide'] }));
expect('allowedUrlPatterns exempts the heuristic', r.error === null);
r = run(() => validateNotProduction('https://partner.io/guide', ['partner\\.io'], { enforce: true, allowedUrlPatterns: ['partner\\.io/guide'] }));
expect('allowedUrlPatterns never overrides prodUrlPatterns', r.error && r.error.message.includes('PRODUCTION GUARD'));

// 8. An invalid allowed pattern is never treated as a match.
r = run(() => validateNotProduction('https://otherapp.io/', [], { enforce: true, allowedUrlPatterns: ['('] }));
expect('invalid allowed regex does not exempt', r.error !== null);

// 9. heuristic:false disables only the heuristic.
r = run(() => validateNotProduction('https://otherapp.io/', [], { enforce: true, heuristic: false }));
expect('heuristic:false disables the heuristic', r.error === null && r.warnings.length === 0);

// 10. guardOptionsFromConfig reads the config.
let o = guardOptionsFromConfig({ productionProtection: { mode: 'enforce', allowedUrlPatterns: ['a'], blockOnSuspiciousUrls: false } });
expect('options: mode enforce', o.enforce === true);
expect('options: allowed patterns', o.allowedUrlPatterns.length === 1);
expect('options: blockOnSuspiciousUrls=false -> heuristic false', o.heuristic === false);
o = guardOptionsFromConfig({});
expect('options: defaults are warn + heuristic on', o.enforce === false && o.heuristic === true);

if (failures.length) {
  console.log('FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('OK');
