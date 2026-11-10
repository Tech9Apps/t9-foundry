'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizePath, parseText, detect, main } = require('../../scripts/results/normalize');
const Ajv = require('../node_modules/ajv');
const { parseXml: xml } = require('../../scripts/results/lib/xml');
const { extractIds } = require('../../scripts/results/lib/shared');

const FIX = path.join(__dirname, '..', 'fixtures', 'results');
const norm = (name, opts) => normalizePath(path.join(FIX, name), opts);
const byName = (r, frag) => r.tests.find((t) => t.name.includes(frag));
const failedIds = (r) => r.tests.filter((t) => t.status === 'failed').map((t) => `${t.ticket || ''}/${t.caseId || ''}`);

test('real node:test TAP: 22 tests, the two planted failures, with ids and locations', () => {
  const r = norm('node-test.tap');
  assert.equal(r.format, 'tap');
  assert.deepEqual(r.totals, { total: 22, passed: 20, failed: 2, skipped: 0 });
  assert.deepEqual(failedIds(r), ['DEMO-101/TC-005', 'DEMO-102/TC-006']);
  const f = byName(r, 'TC-005');
  assert.equal(f.error.message, 'a second application of the code should be rejected');
  assert.equal(f.error.kind, 'failure');
  assert.match(f.error.details, /200 !== 400/);
  assert.equal(f.line, 40);
  assert.match(f.file, /discount-codes\.test\.js$/);
  assert.ok(f.durationMs > 0);
});

test('real node:test JUnit: same run, same answer — and the two formats agree', () => {
  const j = norm('node-test.junit.xml');
  const t = norm('node-test.tap');
  assert.equal(j.format, 'junit');
  assert.deepEqual(j.totals, t.totals);
  assert.deepEqual(failedIds(j), failedIds(t));
  assert.deepEqual(j.tests.map((x) => x.name), t.tests.map((x) => x.name));
});

test('real node:test JUnit: the root has no <testsuite>, and entity-encoded details are decoded', () => {
  const f = byName(norm('node-test.junit.xml'), 'TC-005');
  // node:test drops the newline inside the failure="" attribute itself, so the message runs on…
  assert.equal(f.error.message, 'a second application of the code should be rejected200 !== 400');
  // …but the element body keeps it, and `&lt;anonymous>` is decoded
  assert.match(f.error.details, /rejected\n\n200 !== 400/);
  assert.match(f.error.details, /TestContext\.<anonymous>/);
});

test('pytest JUnit: failure vs error vs skipped, and TC_002-style names give a case id', () => {
  const r = norm('pytest.junit.xml');
  assert.deepEqual(r.totals, { total: 4, passed: 1, failed: 2, skipped: 1 });
  const fail = byName(r, 'TC_002');
  assert.equal(fail.caseId, 'TC-002');
  assert.equal(fail.error.kind, 'failure');
  assert.equal(fail.error.message, 'assert 0 == 1');
  assert.match(fail.error.details, />\s+assert len\(cart\.items\) == 1/); // &gt; decoded
  assert.equal(fail.file, 'tests/test_checkout.py');
  assert.equal(fail.line, 25);
  const err = byName(r, 'TC_004');
  assert.equal(err.status, 'failed');
  assert.equal(err.error.kind, 'error');
  assert.equal(err.error.message, 'failed on setup with "ConnectionError: db down"');
  assert.equal(byName(r, 'TC_003').status, 'skipped');
});

test('Cypress JUnit: CDATA bodies, empty root suite, a timeout is recognised', () => {
  const r = norm('cypress.junit.xml');
  assert.deepEqual(r.totals, { total: 3, passed: 2, failed: 1, skipped: 0 });
  const f = byName(r, 'TC-002');
  assert.equal(f.ticket, 'DEMO-103');
  assert.equal(f.error.kind, 'timeout');
  assert.match(f.error.details, /at Context\.eval/);
});

test('WebdriverIO: a directory of per-worker files is merged', () => {
  const r = norm('wdio');
  assert.deepEqual(r.totals, { total: 3, passed: 2, failed: 1, skipped: 0 });
  assert.deepEqual(r.tests.map((t) => t.caseId).sort(), ['TC-010', 'TC-011', 'TC-020']);
});

test('RSpec JUnit: entities in names and messages are decoded', () => {
  const r = norm('rspec.junit.xml');
  assert.equal(byName(r, 'TC-001').name, 'Cart DEMO-102/TC-001 totals & shipping');
  const f = byName(r, 'TC-002');
  assert.equal(f.name, 'Cart DEMO-102/TC-002 rounds "half up"');
  assert.equal(f.error.message, 'expected: 10.01\n     got: 10.00');
  assert.match(f.error.details, /block \(2 levels\) in <top \(required\)>/);
});

test('Playwright JSON: statuses, flaky-after-retry, timeout, skipped, ANSI stripped, suite path', () => {
  const r = norm('playwright.json');
  assert.equal(r.format, 'playwright-json');
  assert.deepEqual(r.totals, { total: 5, passed: 2, failed: 2, skipped: 1, flaky: 1 });
  assert.equal(r.durationMs, 36000);
  const flaky = byName(r, 'TC-003');
  assert.equal(flaky.status, 'passed');
  assert.equal(flaky.flaky, true);
  assert.equal(flaky.retries, 1);
  const fail = byName(r, 'TC-002');
  assert.equal(fail.error.message, 'Error: expect(received).toBe(expected)'); // no ANSI escapes
  assert.doesNotMatch(JSON.stringify(fail), /\u001b/);
  assert.match(fail.error.details, /Received: "Invalid code"/);
  assert.equal(byName(r, 'TC-005').error.kind, 'timeout');
  assert.equal(byName(r, 'TC-004').status, 'skipped');
  assert.equal(fail.suite, 'Checkout');
  assert.equal(fail.file, 'checkout.spec.ts');
  assert.equal(fail.line, 22);
});

test('Jest JSON: pending counts as skipped, ancestors become the suite, a file that failed to run is not lost', () => {
  const r = norm('jest.json');
  assert.equal(r.format, 'jest-json');
  assert.deepEqual(r.totals, { total: 5, passed: 2, failed: 2, skipped: 1 });
  assert.equal(byName(r, 'TC-003').suite, 'cart › shipping');
  assert.equal(byName(r, 'TC-002').error.message, 'Error: expect(received).toBe(expected)');
  const broken = r.tests.find((t) => t.file.endsWith('broken.test.js'));
  assert.equal(broken.status, 'failed');
  assert.equal(broken.error.kind, 'error');
  assert.match(broken.error.details, /Cannot find module/);
});

test('TAP: nested describe() blocks count the leaves once (not the parent), with # SKIP / # TODO as skipped', () => {
  const r = norm('nested.tap');
  assert.deepEqual(r.totals, { total: 4, passed: 1, failed: 1, skipped: 2 });
  assert.ok(r.tests.every((t) => t.suite === 'cart'));
  assert.equal(byName(r, 'TC-002').error.message, 'expected 108');
  assert.equal(byName(r, 'TC-002').error.kind, 'failure');
  assert.equal(byName(r, 'TC-001').durationMs, 1.5);
  assert.equal(byName(r, 'TC-001').line, 5);
  assert.equal(byName(r, 'TC-003').status, 'skipped');
  assert.equal(byName(r, 'TC-004').status, 'skipped');
});

test('JUnit: <flakyFailure> (surefire / Playwright junit) is a pass that needed retries', () => {
  const r = parseText(`<testsuite name="s"><testcase name="DEMO-1/TC-001 a" time="1">
      <flakyFailure message="timeout"><![CDATA[stack]]></flakyFailure><flakyFailure message="timeout"/></testcase>
    <testcase name="DEMO-1/TC-002 b" time="1"><failure message="nope"/><rerunFailure message="nope"/></testcase></testsuite>`, 'junit');
  assert.deepEqual(r.totals, { total: 2, passed: 1, failed: 1, skipped: 0, flaky: 1 });
  assert.deepEqual([r.tests[0].status, r.tests[0].flaky, r.tests[0].retries], ['passed', true, 2]);
  assert.deepEqual([r.tests[1].status, r.tests[1].retries], ['failed', 1]);
});

test('Playwright JSON: a test skipped at declaration has no results at all, and is still skipped', () => {
  const doc = { config: {}, suites: [{ title: 'a.spec.ts', specs: [{ title: 'TC-001 declared skip', file: 'a.spec.ts', line: 3, tests: [{ status: 'skipped', results: [] }] }], suites: [] }] };
  const r = parseText(JSON.stringify(doc), 'playwright-json');
  assert.deepEqual(r.totals, { total: 1, passed: 0, failed: 0, skipped: 1 });
});

test('every fixture validates against schemas/run-result.schema.json', () => {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(require('../../schemas/run-result.schema.json'));
  for (const name of ['node-test.tap', 'node-test.junit.xml', 'pytest.junit.xml', 'cypress.junit.xml', 'wdio', 'rspec.junit.xml', 'playwright.json', 'jest.json', 'nested.tap']) {
    const result = norm(name);
    assert.ok(validate(result), `${name}: ${JSON.stringify(validate.errors)}`);
  }
});

test('format auto-detection, and an explicit --format overrides it', () => {
  assert.equal(detect('<?xml version="1.0"?><testsuites/>'), 'junit');
  assert.equal(detect('TAP version 13\nok 1 - a'), 'tap');
  assert.equal(detect('ok 1 - a\n1..1'), 'tap');
  assert.equal(detect(fs.readFileSync(path.join(FIX, 'playwright.json'), 'utf8')), 'playwright-json');
  assert.equal(detect(fs.readFileSync(path.join(FIX, 'jest.json'), 'utf8')), 'jest-json');
  assert.throws(() => detect('{"hello":1}'), { code: 'UNRECOGNIZED' });
  assert.throws(() => detect('just some text'), { code: 'UNRECOGNIZED' });
  // forcing the wrong format on real content yields zero tests (which the CLI then refuses), not a crash
  assert.equal(norm('jest.json', { format: 'junit' }).totals.total, 0);
});

test('framework name is carried through, including across a merged directory', () => {
  assert.equal(norm('pytest.junit.xml', { framework: 'pytest' }).framework, 'pytest');
  assert.equal(norm('wdio', { framework: 'webdriverio' }).framework, 'webdriverio');
});

test('a directory ignores stray non-report files but fails if nothing in it is a report', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-results.'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
  assert.throws(() => normalizePath(dir), { code: 'UNRECOGNIZED' });
  fs.copyFileSync(path.join(FIX, 'rspec.junit.xml'), path.join(dir, 'r.xml'));
  assert.equal(normalizePath(dir).totals.total, 2);
  assert.throws(() => normalizePath(path.join(dir, 'missing')), { code: 'NOT_FOUND' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('XML reader: self-closing tags, CDATA, numeric entities, comments, mismatched close tags', () => {
  const root = xml('<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y=\'q\'><b/><c><![CDATA[<raw & text>]]></c>t&#65;&#x42;<d></a>');
  const a = root.children[0];
  assert.deepEqual(a.attrs, { x: '1 & 2', y: 'q' });
  assert.deepEqual(a.children.map((c) => c.name), ['b', 'c', 'd']);
  assert.equal(a.children[1].text, '<raw & text>');
  assert.equal(a.text, 'tAB');
});

test('case id extraction', () => {
  assert.deepEqual(extractIds('DEMO-101/TC-005: x'), { ticket: 'DEMO-101', caseId: 'TC-005' });
  assert.deepEqual(extractIds('test_TC_005_applies'), { caseId: 'TC-005' });
  assert.deepEqual(extractIds('ABTC-5'), {});
  assert.deepEqual(extractIds('no ids'), {});
});

// --- the CLI ---------------------------------------------------------------------------------------
const cli = (argv) => {
  let out = '';
  let err = '';
  const code = main({ argv, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err, json: out ? JSON.parse(out) : null };
};

test('CLI: ok envelope, exit 0 even when tests failed (failures are data)', () => {
  const r = cli([path.join(FIX, 'node-test.tap')]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.data.totals.failed, 2);
});

test('CLI: a report with zero tests is an error, never a pass', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-results.'));
  const empty = path.join(dir, 'empty.xml');
  fs.writeFileSync(empty, '<?xml version="1.0"?><testsuites tests="0"></testsuites>');
  const r = cli([empty]);
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, 'NO_TESTS');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI: unreadable, unrecognized and mis-invoked', () => {
  assert.equal(cli([path.join(FIX, 'nope.xml')]).json.error.code, 'NOT_FOUND');
  assert.equal(cli([path.join(FIX, 'README.md')]).json.error.code, 'UNRECOGNIZED');
  assert.equal(cli([]).code, 2);
  assert.equal(cli(['a', 'b']).code, 2);
  assert.equal(cli([path.join(FIX, 'jest.json'), '--format', 'nonsense']).code, 2);
  assert.equal(cli(['--bogus', 'x']).code, 2);
  assert.equal(cli([path.join(FIX, 'jest.json'), '--out']).code, 2);
});

test('CLI: --out writes the same document it prints', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-results.'));
  const out = path.join(dir, 'nested', 'result.json');
  const r = cli([path.join(FIX, 'pytest.junit.xml'), '--framework', 'pytest', '--out', out]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), r.json);
  assert.equal(r.json.data.framework, 'pytest');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- a point that is "not ok" for its OWN reason is a failure, not a pass hidden behind its passing children -----
test('real node:test TAP: a suite whose own after-hook throws is a FAILED test (node itself counts it as nothing and, alone, exits 0)', () => {
  const r = norm('node-hook-failure.tap');
  assert.deepEqual(r.totals, { total: 4, passed: 2, failed: 2, skipped: 0 });
  assert.deepEqual(r.tests.filter((t) => t.status === 'failed').map((t) => t.name).sort(), ['suite with broken after', 'this one fails']);
  const hook = byName(r, 'suite with broken after');
  assert.match(hook.error.message, /boom in the after hook/);
  assert.equal(hook.error.kind, 'error');
  assert.match(hook.file, /hook\.test\.js$/);
  assert.equal(byName(r, 'child passes').status, 'passed', 'its passing child is still a pass');
});

test('a parent that is only "N subtests failed" is NOT counted again on top of the failing child', () => {
  const r = norm('node-hook-failure.tap');
  assert.equal(r.tests.filter((t) => t.name === 'suite with a failing child').length, 0);
  assert.equal(r.tests.filter((t) => t.name === 'this one fails').length, 1);
});

test('generic TAP: a parent not ok while every child is ok is its own failure; one with a failing child is not; skipped children do not fail a parent', () => {
  const tap = [
    'TAP version 13',
    '    ok 1 - a', '    ok 2 - b', 'not ok 1 - parent with only passing children',
    '    not ok 1 - c', '    ok 2 - d', 'not ok 2 - parent with a failing child',
    '    ok 1 - e # SKIP later', 'ok 3 - parent with only skipped children',
    '    ok 1 - deep1', '        ok 1 - deepest', '    not ok 2 - middle fails on its own', 'not ok 4 - top fails because of middle',
    '1..4',
  ].join('\n');
  const r = parseText(tap, 'tap', {});
  const failed = r.tests.filter((t) => t.status === 'failed').map((t) => t.name).sort();
  assert.deepEqual(failed, ['c', 'middle fails on its own', 'parent with only passing children']);
  assert.equal(r.tests.some((t) => t.name === 'parent with a failing child'), false);
  assert.equal(r.tests.some((t) => t.name === 'top fails because of middle'), false);
  assert.equal(r.tests.some((t) => t.name === 'parent with only skipped children'), false, 'an ok parent is never a test of its own');
});

// --- a directory of reports: a file that IS a report but cannot be read must fail the run, not vanish -------------
const reportDir = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-results.'));
const GOOD_XML = '<testsuites><testsuite name="s" tests="1"><testcase name="DEMO-1/TC-001: ok"/></testsuite></testsuites>';
const BAD_ENTITY_XML = '<testsuites><testsuite name="s" tests="1"><testcase name="DEMO-1/TC-002: breaks"><failure message="bad &#x110000; char">x</failure></testcase></testsuite></testsuites>';

test('a directory with one good report and one that is a report but cannot be parsed FAILS, naming the file (it used to report the good one alone: 1 passed, 0 failed)', () => {
  const dir = reportDir();
  fs.writeFileSync(path.join(dir, 'results-0.xml'), GOOD_XML);
  fs.writeFileSync(path.join(dir, 'results-1.xml'), BAD_ENTITY_XML);
  assert.throws(() => normalizePath(dir), (e) => e.code === 'UNPARSEABLE' && /results-1\.xml/.test(e.message));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an empty report file in a directory fails too (a runner that crashed before writing)', () => {
  const dir = reportDir();
  fs.writeFileSync(path.join(dir, 'results-0.xml'), GOOD_XML);
  for (const empty of ['', '  \n']) {
    fs.writeFileSync(path.join(dir, 'results-1.xml'), empty);
    assert.throws(() => normalizePath(dir), (e) => e.code === 'UNPARSEABLE' && /results-1\.xml/.test(e.message) && /empty/.test(e.message));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file that is not a test report at all is still ignored, but the result SAYS so (a warning)', () => {
  const dir = reportDir();
  fs.writeFileSync(path.join(dir, 'results-0.xml'), GOOD_XML);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
  const warnings = [];
  const r = normalizePath(dir, { warnings });
  assert.equal(r.totals.total, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /package\.json/);
  assert.match(warnings[0], /not a test report/);
  // naming the format changes nothing about a report that cannot be read
  fs.writeFileSync(path.join(dir, 'results-1.xml'), BAD_ENTITY_XML);
  assert.throws(() => normalizePath(dir, { format: 'junit' }), (e) => e.code === 'UNPARSEABLE' && /results-1\.xml/.test(e.message));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the CLI prints those warnings, and exits 1 for a directory with an unreadable report', () => {
  const dir = reportDir();
  fs.writeFileSync(path.join(dir, 'results-0.xml'), GOOD_XML);
  fs.writeFileSync(path.join(dir, 'notes.json'), '{"a":1}');
  let out = ''; let err = '';
  assert.equal(main({ argv: [dir], stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } }), 0);
  assert.match(JSON.parse(out).warnings[0], /notes\.json/);
  fs.writeFileSync(path.join(dir, 'results-1.xml'), BAD_ENTITY_XML);
  out = '';
  assert.equal(main({ argv: [dir], stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } }), 1);
  assert.equal(JSON.parse(out).error.code, 'UNPARSEABLE');
  fs.rmSync(dir, { recursive: true, force: true });
});
