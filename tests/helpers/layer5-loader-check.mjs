// A TypeScript qa-config-loader must not mistake an UNREADABLE config for "no config": unattended (QA_AUTONOMOUS=1) it throws instead of
// running without the production patterns the file holds; attended it warns and carries on.
// Usage: node --experimental-strip-types tests/helpers/layer5-loader-check.mjs <path-to-qa-config-loader.ts>. Prints "OK" or each failure.
import { pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'qa-loader-'));
writeFileSync(join(dir, 'qa-config.json'), '{ not json');
process.env.QA_HARNESS_DIR = dir;
process.chdir(dir); // nothing to find by walking up from here

const { loadQAConfig } = await import(pathToFileURL(process.argv[2]).href);
const failures = [];
const expect = (name, cond) => { if (!cond) failures.push(name); };

const warnings = [];
const orig = console.warn;
console.warn = (...a) => warnings.push(a.join(' '));

delete process.env.QA_AUTONOMOUS;
let attended; let attendedError = null;
try { attended = loadQAConfig(); } catch (e) { attendedError = e; }
expect('attended: does not throw', attendedError === null);
expect('attended: returns an empty config', attended && Object.keys(attended).length === 0);
expect('attended: says the file could not be parsed', warnings.some((w) => /could not be parsed/.test(w)));

process.env.QA_AUTONOMOUS = '1';
let error = null;
try { loadQAConfig(); } catch (e) { error = e; }
expect('unattended: throws', error !== null);
expect('unattended: says BLOCKED and why', !!error && /BLOCKED/.test(error.message) && /could not be parsed/.test(error.message) && /QA_AUTONOMOUS=1/.test(error.message));

console.warn = orig;
rmSync(dir, { recursive: true, force: true });
if (failures.length) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('OK');
