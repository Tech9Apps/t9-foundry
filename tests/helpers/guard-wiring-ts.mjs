// What the TypeScript entry points (playwright global-setup.ts, cypress.config.ts, wdio.conf.ts) rely on in prod-guard.ts: guardOptionsFromConfig(qa)
// turns the loaded qa-config.json into the guard's options, and validateNotProduction only enforces when it is given them (or QA_AUTONOMOUS=1).
// Usage: node --experimental-strip-types guard-wiring-ts.mjs <prod-guard.ts>      Prints "OK" or each problem.
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(process.argv[2]).href);
const problems = [];
const check = (what, ok) => { if (!ok) problems.push(what); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const quietly = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

delete process.env.QA_AUTONOMOUS;
const opts = mod.guardOptionsFromConfig;
check('an empty config gives warn-mode options', same(opts({}), { enforce: false, allowedUrlPatterns: [], heuristic: true, testEnvironmentBaseUrl: undefined }));
check('productionProtection.mode "enforce" turns enforce on', opts({ productionProtection: { mode: 'enforce' } }).enforce === true);
check('productionProtection.mode "warn" leaves it off', opts({ productionProtection: { mode: 'warn' } }).enforce === false);
check('allowedUrlPatterns are passed through', same(opts({ productionProtection: { allowedUrlPatterns: ['^https://partner\\.io/'] } }).allowedUrlPatterns, ['^https://partner\\.io/']));
check('blockOnSuspiciousUrls: false switches the heuristic off, and only false does', opts({ productionProtection: { blockOnSuspiciousUrls: false } }).heuristic === false && opts({ productionProtection: { blockOnSuspiciousUrls: true } }).heuristic === true);
check('environments.testEnvironmentBaseUrl is passed through', opts({ environments: { testEnvironmentBaseUrl: 'https://staging.acme.test' } }).testEnvironmentBaseUrl === 'https://staging.acme.test');
process.env.QA_AUTONOMOUS = '1';
check('QA_AUTONOMOUS=1 turns enforce on even when the config says warn', opts({ productionProtection: { mode: 'warn' } }).enforce === true);
delete process.env.QA_AUTONOMOUS;

// the call every entry point makes, with and without the options
const unknown = 'https://www.bank-of-example.net/';
const qa = { productionProtection: { mode: 'enforce', prodUrlPatterns: [], allowedUrlPatterns: ['^https://partner\\.io/'] }, environments: { testEnvironmentBaseUrl: 'https://check9.tech9app.com' } };
check('with the config options, enforce mode blocks an unrecognized host', throws(() => mod.validateNotProduction(unknown, [], opts(qa))));
check('WITHOUT the options the same host only warns (so dropping them from an entry point silently disables enforce-via-config)', !throws(() => quietly(() => mod.validateNotProduction(unknown, []))));
check('enforce mode lets the declared test environment through', !throws(() => mod.validateNotProduction('https://check9.tech9app.com/', [], opts(qa))));
check('enforce mode lets an allowed pattern through', !throws(() => mod.validateNotProduction('https://partner.io/guide', [], opts(qa))));
check('a configured production pattern blocks in either mode', throws(() => mod.validateNotProduction('https://myapp.example.com/', ['://myapp\\.example\\.com/'], opts({}))));
console.log(problems.length ? problems.map((p) => `FAIL: ${p}`).join('\n') : 'OK');
process.exit(problems.length ? 1 : 0);
