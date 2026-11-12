'use strict';
// scripts/triage/lib/documents.js: reading the two documents the triage scripts pass to each other. Both may arrive bare or wrapped in
// { ok, data } (run.js, normalize.js and orchestrate.js write the wrapped form), and a file of the wrong kind must say so, not crash later.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readReport, readRunResult } = require('../../scripts/triage/lib/documents');

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-docs-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body)); return f; };
const unreadable = (fn, re) => assert.throws(fn, (e) => e.code === 'UNREADABLE' && re.test(e.message));

test('readReport returns the triage report, bare or wrapped', () => {
  const report = { verdicts: [{ key: 'a' }] };
  assert.deepEqual(readReport(file('bare.json', report)), report);
  assert.deepEqual(readReport(file('wrapped.json', { ok: true, data: report })), report);
});

test('readReport accepts a report with no verdicts yet, but not one without the array', () => {
  assert.deepEqual(readReport(file('empty.json', { verdicts: [] })), { verdicts: [] });
  const f = file('no-verdicts.json', { ok: true, data: { tests: [] } });
  unreadable(() => readReport(f), new RegExp(`^${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not a triage report \\(no "verdicts" array\\)$`));
  unreadable(() => readReport(file('verdicts-not-list.json', { verdicts: {} })), /is not a triage report/);
  unreadable(() => readReport(file('null.json', 'null')), /is not a triage report/);
});

test('readReport names a file that is missing or is not JSON', () => {
  unreadable(() => readReport(path.join(dir, 'missing.json')), /^cannot read .*missing\.json: /);
  unreadable(() => readReport(file('bad.json', '{nope')), /^cannot read .*bad\.json: /);
});

test('readRunResult returns the normalized run, bare or wrapped', () => {
  const run = { format: 'tap', tests: [{ name: 'x', status: 'passed' }] };
  assert.deepEqual(readRunResult(file('run-bare.json', run)), run);
  assert.deepEqual(readRunResult(file('run-wrapped.json', { ok: true, exitCode: 1, data: run })), run);
});

test('readRunResult refuses a document with no tests array, naming the file', () => {
  const f = file('not-a-run.json', { ok: true, data: { verdicts: [] } });
  unreadable(() => readRunResult(f), /is not a normalized run result \(no "tests" array\)$/);
  assert.throws(() => readRunResult(f), (e) => e.message.startsWith(f));
  unreadable(() => readRunResult(file('tests-not-list.json', { tests: 'x' })), /is not a normalized run result/);
});

test('readRunResult names a file that is missing', () => {
  unreadable(() => readRunResult(path.join(dir, 'nope.json')), /^cannot read .*nope\.json: /);
});
