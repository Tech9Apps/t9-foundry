'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv = require('../node_modules/ajv');
const { classify, main, RULES, CLASSES, DEFAULT_THRESHOLD } = require('../../scripts/triage/classify');
const { normalizePath } = require('../../scripts/results/normalize');

const validateReport = new Ajv({ allErrors: true, strict: false }).compile(require('../../schemas/triage-report.schema.json'));
const FIX = path.join(__dirname, '..', 'fixtures', 'results');

// ── tiny builders: every scenario is visible in the test that uses it ──────────────────────────────
const err = (message, kind = 'failure', details = '') => ({ kind, message, details });
const T = (name, status, error, extra = {}) => ({ name, status, ...(error ? { error } : {}), ...extra });
const pass = (name, extra) => T(name, 'passed', undefined, extra);
const fail = (name, error, extra) => T(name, 'failed', error, extra);
// 'tap' is the one format trusted by default; the gate for every other format has its own tests below
const run = (...tests) => ({ format: 'tap', totals: {}, tests });
const only = (report) => { assert.equal(report.verdicts.length, 1, JSON.stringify(report.verdicts.map((v) => v.test.name))); return report.verdicts[0]; };
const ok = (report) => { assert.ok(validateReport(report), JSON.stringify(validateReport.errors)); return report; };
const triage = (runs, opts = {}) => ok(classify({ runs, ...opts }));

const CASE = 'DEMO-101/TC-005: a second code is rejected';
const ASSERT = err('a second application of the code should be rejected');

describe('product-bug (PRD-1/2/3)', () => {
  test('PRD-1: failed in every attempt with the same assertion, traceable to a manual case → product-bug 0.85, act', () => {
    const v = only(triage([run(fail(CASE, ASSERT, { ticket: 'DEMO-101', caseId: 'TC-005' })), run(fail(CASE, ASSERT, { ticket: 'DEMO-101', caseId: 'TC-005' })), run(fail(CASE, ASSERT, { ticket: 'DEMO-101', caseId: 'TC-005' }))]));
    assert.deepEqual([v.class, v.rule, v.confidence, v.action], ['product-bug', 'PRD-1', 0.85, 'act']);
    assert.match(v.evidence.join(' '), /all 3 attempts/);
    assert.match(v.evidence.join(' '), /DEMO-101\/TC-005/);
  });

  test('PRD-2: same, but not traceable to a case → 0.75, so only a proposal at the default threshold', () => {
    const v = only(triage([run(fail('checkout total is wrong', ASSERT)), run(fail('checkout total is wrong', ASSERT))]));
    assert.deepEqual([v.rule, v.confidence, v.action], ['PRD-2', 0.75, 'propose']);
  });

  test('PRD-3: one attempt only (no re-run) → 0.6 and propose, because a flaky test cannot be ruled out', () => {
    const v = only(triage([run(fail(CASE, ASSERT, { ticket: 'DEMO-101', caseId: 'TC-005' }))]));
    assert.deepEqual([v.class, v.rule, v.confidence, v.action], ['product-bug', 'PRD-3', 0.6, 'propose']);
    assert.match(v.evidence[0], /no re-run was done/);
  });

  test('different assertion messages across attempts is NOT a consistent product bug', () => {
    const v = only(triage([run(fail('t', err('expected 1 got 2'))), run(fail('t', err('expected 1 got 3')))]));
    assert.equal(v.class, 'undetermined');
    assert.match(v.evidence[0], /different errors/);
  });

  test('volatile parts of the message (durations, ids) do not make attempts look different', () => {
    const v = only(triage([run(fail('t', err('order 123456789 rejected after 1200ms'))), run(fail('t', err('order 987654321 rejected after 900ms')))]));
    assert.equal(v.rule, 'PRD-2');
  });
});

describe('REAL demo output', () => {
  const real = normalizePath(path.join(FIX, 'node-test.tap'));
  test('the two planted bugs: proposed after one run, acted on once re-runs confirm them', () => {
    const one = triage([real]);
    assert.deepEqual(one.verdicts.map((v) => [v.test.caseId, v.rule, v.action]), [['TC-005', 'PRD-3', 'propose'], ['TC-006', 'PRD-3', 'propose']]);
    const three = triage([real, real, real]);
    assert.deepEqual(three.verdicts.map((v) => [v.test.ticket, v.test.caseId, v.rule, v.action]), [['DEMO-101', 'TC-005', 'PRD-1', 'act'], ['DEMO-102', 'TC-006', 'PRD-1', 'act']]);
    assert.equal(three.summary.tests, 22);
    assert.equal(three.summary.byClass['product-bug'], 2);
  });
});

describe('flaky (FLK-1)', () => {
  test('failed, then passed on a re-run → flaky 0.9, never a product-bug even though the failure was an assertion', () => {
    const v = only(triage([run(fail(CASE, ASSERT)), run(pass(CASE))]));
    assert.deepEqual([v.class, v.rule, v.confidence, v.action], ['flaky', 'FLK-1', 0.9, 'act']);
    assert.deepEqual(v.attempts, [{ run: 0, status: 'failed' }, { run: 1, status: 'passed' }]);
    assert.match(v.evidence[0], /failed in run 0 but passed in run 1/);
  });

  test('the runner\'s own retry (it passed, flagged flaky) is triaged too, at 0.85', () => {
    const v = only(triage([run(pass('login works', { flaky: true, retries: 2 }), pass('other'))]));
    assert.deepEqual([v.class, v.rule, v.confidence], ['flaky', 'FLK-1', 0.85]);
    assert.match(v.evidence[0], /retries: 2/);
  });

  test('a test that passes and was never flaky is not triaged at all', () => {
    assert.deepEqual(triage([run(pass('a'), pass('b'))]).verdicts, []);
  });
});

describe('environment (ENV-1/2/3)', () => {
  test('ENV-2: connection refused in every failing attempt → environment 0.9', () => {
    const e = err('connect ECONNREFUSED 127.0.0.1:3000', 'error');
    const v = only(triage([run(fail('t', e)), run(fail('t', e))]));
    assert.deepEqual([v.class, v.rule, v.confidence, v.action], ['environment', 'ENV-2', 0.9, 'act']);
  });

  test('ENV-2 needs EVERY failing attempt to carry the signal: one refused + one assertion is not an outage', () => {
    const v = only(triage([run(fail('t', err('connect ECONNREFUSED 127.0.0.1:3000', 'error'))), run(fail('t', ASSERT))]));
    assert.notEqual(v.rule, 'ENV-2');
  });

  test('a bare "Timeout exceeded" is NOT an infrastructure signal (it is ambiguous)', () => {
    const e = err('Timeout 30000ms exceeded.', 'timeout');
    const v = only(triage([run(fail('t', e)), run(fail('t', e))]));
    assert.equal(v.class, 'undetermined');
    assert.match(v.evidence[0], /timed out every time/);
  });

  test('ENV-1: a failed preflight outranks everything, even a clean consistent assertion', () => {
    const v = only(triage([run(fail(CASE, ASSERT, { caseId: 'TC-005', ticket: 'DEMO-101' })), run(fail(CASE, ASSERT, { caseId: 'TC-005', ticket: 'DEMO-101' }))], { preflight: 'failed' }));
    assert.deepEqual([v.class, v.rule, v.confidence], ['environment', 'ENV-1', 0.95]);
    assert.ok(v.alternatives.some((a) => a.rule === 'PRD-1'), 'the product-bug reading is kept as an alternative');
  });

  test('a passing preflight does not suppress anything', () => {
    assert.equal(only(triage([run(fail(CASE, ASSERT))], { preflight: 'ok' })).rule, 'PRD-3');
  });

  test('ENV-3: most of the run failing with one error → environment, but only 0.6 (could be a real suite-wide regression)', () => {
    const boom = err('expected 200 but got 500 from /api/cart');
    const tests = [...['a', 'b', 'c', 'd', 'e'].map((n) => fail(n, boom)), pass('f'), pass('g')];
    const report = triage([run(...tests)]);
    assert.equal(report.verdicts.length, 5);
    for (const v of report.verdicts) {
      assert.deepEqual([v.class, v.rule, v.confidence, v.action], ['environment', 'ENV-3', 0.6, 'propose']);
      assert.ok(v.alternatives.some((a) => a.class === 'product-bug'), 'the regression reading is kept visible');
    }
  });

  test('ENV-3 does not fire for a few failures, a minority, or different errors', () => {
    const boom = err('expected 200 but got 500');
    assert.notEqual(triage([run(fail('a', boom), fail('b', boom), pass('c'), pass('d'), pass('e'))]).verdicts[0].rule, 'ENV-3'); // 2 failures
    assert.notEqual(triage([run(fail('a', boom), fail('b', boom), fail('c', boom), ...['d', 'e', 'f', 'g', 'h', 'i'].map((n) => pass(n)))]).verdicts[0].rule, 'ENV-3'); // 3 of 9
    const mixed = [fail('a', err('one')), fail('b', err('two')), fail('c', err('three')), fail('d', err('four')), pass('e')];
    assert.ok(triage([run(...mixed)]).verdicts.every((v) => v.rule !== 'ENV-3'));
  });

  test('infrastructure signatures recognised across tools', () => {
    for (const m of ['getaddrinfo ENOTFOUND api.example.test', 'net::ERR_CONNECTION_REFUSED at http://x', 'Error: socket hang up', '502 Bad Gateway', 'Service Unavailable', 'HTTP 503', 'read ECONNRESET']) {
      assert.equal(only(triage([run(fail('t', err(m, 'error'))), run(fail('t', err(m, 'error')))])).rule, 'ENV-2', m);
    }
  });
});

describe('test-bug (TST-1/2)', () => {
  const stale = err("Error: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('add-to-cart')", 'timeout');
  const cand = (testid, similarity = 0.67) => ({ testid, similarity, tag: 'button', text: 'Add' });
  const withEvidence = (locator) => ({ 'ui-1': { locator } });
  const uiRuns = () => [run(fail('ui-1', stale, { file: 'checkout.spec.ts' })), run(fail('ui-1', stale, { file: 'checkout.spec.ts' }))];
  const key = (runs) => classify({ runs, evidence: {} }).verdicts[0].key;

  test('TST-1: locator not found, and exactly one element resembles it → test-bug 0.85, act', () => {
    const runs = uiRuns();
    const v = only(triage(runs, { evidence: { [key(runs)]: { locator: { target: 'add-to-cart', present: false, candidates: [cand('add-to-basket')] } } } }));
    assert.deepEqual([v.class, v.rule, v.confidence, v.action], ['test-bug', 'TST-1', 0.85, 'act']);
    assert.match(v.evidence[0], /"add-to-cart".*"add-to-basket"/);
  });

  test('a locator error reported as a plain FAILURE (as node:test and Playwright report it) is never a product bug, with or without evidence', () => {
    const plain = err("locator not found: getByTestId('coupon-apply-btn')", 'failure');
    const ticketed = { ticket: 'DEMO-101', caseId: 'TC-901' };
    const runs = [run(fail('DEMO-101/TC-901: apply', plain, ticketed)), run(fail('DEMO-101/TC-901: apply', plain, ticketed)), run(fail('DEMO-101/TC-901: apply', plain, ticketed))];
    const v = only(triage(runs));
    assert.deepEqual([v.class, v.action], ['undetermined', 'propose']);
    assert.ok(!(v.alternatives || []).some((a) => a.class === 'product-bug'), 'not even offered as an alternative');
  });

  test('locator not found but NO DOM evidence → undetermined 0.4 (and says what would settle it)', () => {
    const v = only(triage(uiRuns()));
    assert.deepEqual([v.class, v.rule, v.confidence, v.action], ['undetermined', 'UND-1', 0.4, 'propose']);
    assert.match(v.evidence[0], /locators\.js/);
  });

  test('several candidates, or none, or the element IS present → undetermined, never test-bug', () => {
    const runs = uiRuns();
    const k = key(runs);
    const ambiguous = only(triage(runs, { evidence: { [k]: { locator: { target: 'add-to-cart', present: false, candidates: [cand('add-to-basket'), cand('add-to-bag')] } } } }));
    assert.deepEqual([ambiguous.class, ambiguous.confidence], ['undetermined', 0.5]);
    const gone = only(triage(runs, { evidence: { [k]: { locator: { target: 'add-to-cart', present: false, candidates: [] } } } }));
    assert.deepEqual([gone.class, gone.confidence], ['undetermined', 0.5]);
    const present = only(triage(runs, { evidence: { [k]: { locator: { target: 'add-to-cart', present: true, candidates: [] } } } }));
    assert.deepEqual([present.class, present.confidence], ['undetermined', 0.4]);
    assert.match(present.evidence[0], /not a stale selector/);
  });

  test('an element that IS present is never "renamed", even if something resembles it (the evidence would be contradictory)', () => {
    const runs = uiRuns();
    const v = only(triage(runs, { evidence: { [key(runs)]: { locator: { target: 'add-to-cart', present: true, candidates: [cand('add-to-basket')] } } } }));
    assert.equal(v.class, 'undetermined');
  });

  test('evidence is looked up by the test key OR by its name', () => {
    const runs = uiRuns();
    const v = only(triage(runs, { evidence: withEvidence({ target: 'add-to-cart', present: false, candidates: [cand('add-to-basket')] }) }));
    assert.equal(v.rule, 'TST-1');
  });

  test('TST-2: a crash only the test can cause (ReferenceError, missing module) whose first stack frame is in the test file → test-bug 0.8, act; a TypeError is 0.65, propose', () => {
    const e = err('ReferenceError: page is not defined', 'error', 'TestContext.<anonymous> (/work/e2e/checkout.spec.ts:12:7)\n at node:internal/x:1:1');
    const v = only(triage([run(fail('t', e)), run(fail('t', e))]));
    assert.deepEqual([v.class, v.rule, v.confidence, v.action], ['test-bug', 'TST-2', 0.8, 'act']);
    const t = err("TypeError: Cannot read properties of undefined (reading 'click')", 'error', 'TestContext.<anonymous> (/work/e2e/checkout.spec.ts:12:7)');
    assert.deepEqual([only(triage([run(fail('t', t)), run(fail('t', t))])).confidence, only(triage([run(fail('t', t)), run(fail('t', t))])).action], [0.65, 'propose']);
    assert.match(v.evidence[0], /checkout\.spec\.ts:12/);
  });

  test('TST-2 needs EVERY failing attempt to be a test-code crash: one crash plus one assertion is not enough', () => {
    const crash = err('TypeError: x is not a function', 'error', 'at run (/work/tests/a.test.js:3:3)');
    const v = only(triage([run(fail('t', crash)), run(fail('t', ASSERT))]));
    assert.notEqual(v.rule, 'TST-2');
  });

  test('TST-2 fires for a runner that reports a thrown TypeError as a plain failure (node:test, Playwright)', () => {
    const e = err("TypeError: Cannot read properties of undefined (reading 'click')", 'failure', 'at run (/work/e2e/checkout.spec.ts:12:7)');
    assert.equal(only(triage([run(fail('t', e)), run(fail('t', e))])).rule, 'TST-2');
  });

  test('the same TypeError raised inside the APP is not blamed on the test', () => {
    const e = err("TypeError: Cannot read properties of undefined (reading 'total')", 'error', 'at totals (/work/demo/app/src/pricing.js:30:11)\n at TestContext.<anonymous> (/work/demo/app/test/a.test.js:3:3)');
    const v = only(triage([run(fail('t', e)), run(fail('t', e))]));
    assert.equal(v.class, 'undetermined');
    assert.match(v.evidence[0], /not in test code/);
  });
});

describe('precedence and alternatives', () => {
  test('ENV-2 beats FLK-1: it was down, then it came back — an environment blip, with the flip kept as an alternative', () => {
    const v = only(triage([run(fail('t', err('connect ECONNREFUSED 127.0.0.1:1', 'error'))), run(pass('t'))]));
    assert.equal(v.rule, 'ENV-2');
    assert.deepEqual(v.alternatives.map((a) => a.rule), ['FLK-1']);
  });

  test('a test that failed twice then passed is flaky and does NOT list product-bug as an alternative', () => {
    const v = only(triage([run(fail('t', ASSERT)), run(fail('t', ASSERT)), run(pass('t'))]));
    assert.equal(v.rule, 'FLK-1');
    assert.equal(v.alternatives, undefined);
  });

  test('rule ids are exactly the documented, ordered list, and the schema allows each of them', () => {
    assert.deepEqual(RULES, ['ENV-1', 'ENV-2', 'FLK-1', 'TST-1', 'TST-2', 'ENV-3', 'PRD-1', 'PRD-2', 'PRD-3', 'UND-1']);
    const schema = require('../../schemas/triage-report.schema.json');
    assert.deepEqual([...schema.properties.verdicts.items.properties.rule.enum].sort(), [...RULES].sort());
    assert.deepEqual([...schema.properties.verdicts.items.properties.class.enum].sort(), [...CLASSES].sort());
  });
});

describe('threshold, scope and identity', () => {
  test('the threshold decides act vs propose, nothing else', () => {
    const runs = [run(fail(CASE, ASSERT, { caseId: 'TC-005', ticket: 'DEMO-101' })), run(fail(CASE, ASSERT, { caseId: 'TC-005', ticket: 'DEMO-101' }))];
    assert.equal(DEFAULT_THRESHOLD, 0.8);
    assert.equal(only(triage(runs)).action, 'act');
    assert.equal(only(triage(runs, { threshold: 0.9 })).action, 'propose');
    const one = [run(fail(CASE, ASSERT))];
    assert.equal(only(triage(one, { threshold: 0.6 })).action, 'act');
    assert.equal(only(triage(one, { threshold: 0.6 })).class, 'product-bug');
  });

  test('skipped tests are never triaged, and a test that only fails in a RE-run is not triaged', () => {
    assert.deepEqual(triage([run(T('s', 'skipped'), pass('p')), run(fail('p', ASSERT))]).verdicts, []);
  });

  test('a test skipped on a re-run has still only been attempted once', () => {
    const v = only(triage([run(fail(CASE, ASSERT)), run(T(CASE, 'skipped'))]));
    assert.equal(v.rule, 'PRD-3');
    assert.deepEqual(v.attempts, [{ run: 0, status: 'failed' }]);
  });

  test('attempts are grouped by ticket/caseId, so a reworded title does not split a test across runs', () => {
    const a = fail('DEMO-101/TC-005: second code rejected', ASSERT, { ticket: 'DEMO-101', caseId: 'TC-005' });
    const b = pass('DEMO-101/TC-005: a second code is rejected (reworded)', { ticket: 'DEMO-101', caseId: 'TC-005' });
    const v = only(triage([run(a), run(b)]));
    assert.equal(v.rule, 'FLK-1');
    assert.equal(v.key, 'DEMO-101/TC-005');
  });

  test('every verdict carries a fingerprint token for tracker search, and the summary adds up', () => {
    const report = triage([run(fail('a', ASSERT), fail('b', err('other')), pass('c'), T('d', 'skipped'))]);
    assert.ok(report.verdicts.every((v) => /^qafp[0-9a-f]{12}$/.test(v.token)));
    assert.equal(report.summary.tests, 3);
    assert.equal(report.summary.triaged, 2);
    assert.equal(report.summary.act + report.summary.propose, 2);
    assert.equal(Object.values(report.summary.byClass).reduce((x, y) => x + y, 0), 2);
  });

  test('no runs is a usage error', () => {
    assert.throws(() => classify({ runs: [] }), { isUsage: true });
  });
});

// ── the CLI ─────────────────────────────────────────────────────────────────────────────────────
describe('classify CLI', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-triage-'));
  const write = (name, obj) => { const f = path.join(dir, name); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
  const cli = (argv) => { let out = ''; let e = ''; const code = main({ argv, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { e += s; } } }); return { code, err: e, json: out ? JSON.parse(out) : null }; };

  test('reads run.js-style { ok, data } documents or bare results; failures are data (exit 0)', () => {
    const wrapped = write('wrapped.json', { ok: false, data: run(fail(CASE, ASSERT)) });
    const bare = write('bare.json', run(fail(CASE, ASSERT)));
    for (const f of [wrapped, bare]) {
      const r = cli(['--run', f]);
      assert.equal(r.code, 0);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.data.verdicts.length, 1);
    }
  });

  test('--rerun, --preflight, --evidence, --threshold and --out all take effect', () => {
    const main1 = write('m.json', run(fail(CASE, ASSERT, { caseId: 'TC-005', ticket: 'DEMO-101' })));
    const out = path.join(dir, 'nested', 'report.json');
    const r = cli(['--run', main1, '--rerun', main1, '--threshold', '0.9', '--out', out]);
    assert.equal(r.json.data.runs, 2);
    assert.equal(r.json.data.verdicts[0].action, 'propose');
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), r.json);
    assert.equal(cli(['--run', main1, '--preflight', 'failed']).json.data.verdicts[0].rule, 'ENV-1');
    const ev = write('ev.json', { 'DEMO-101/TC-005': { locator: { target: 'x', present: true, candidates: [] } } });
    assert.equal(cli(['--run', main1, '--evidence', ev]).code, 0);
  });

  test('unreadable inputs exit 1 with the file named; bad invocations exit 2', () => {
    assert.equal(cli(['--run', path.join(dir, 'nope.json')]).json.error.code, 'UNREADABLE');
    assert.match(cli(['--run', write('junk.json', 'not json')]).json.error.message, /junk\.json/);
    assert.match(cli(['--run', write('notresult.json', { hello: 1 })]).json.error.message, /no "tests" array/);
    assert.equal(cli(['--run', write('ok.json', run()), '--evidence', path.join(dir, 'missing.json')]).code, 1);
    for (const argv of [[], ['--bogus'], ['--rerun', 'x'], ['--run'], ['--run', 'x', '--preflight', 'maybe'], ['--run', 'x', '--threshold', '2'], ['--run', 'x', '--threshold', '0']]) {
      assert.equal(cli(argv).code, 2, argv.join(' '));
    }
  });
});
