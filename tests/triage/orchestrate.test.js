'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main, orchestrate, MAX_RERUNS } = require('../../scripts/triage/orchestrate');
const { MOCKS } = require('../tracker/workspace');

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-orch-'));
const E = (message, kind = 'failure', details = '') => ({ kind, message, details });
const T = (name, status, extra = {}) => ({ name, status, ...extra });
const ids = (n) => ({ ticket: 'DEMO-101', caseId: `TC-00${n}`, file: `/w/tests/c${n}.test.js` });
const ASSERT = E('a second application of the code should be rejected');
const result = (...tests) => ({ ok: tests.every((t) => t.status !== 'failed'), data: { format: 'tap', totals: { total: tests.length, passed: tests.filter((t) => t.status === 'passed').length, failed: tests.filter((t) => t.status === 'failed').length, skipped: 0 }, tests } });
const noReport = { ok: false, error: { code: 'NO_REPORT', message: 'tap exited 1 but wrote no usable report' } };

// A scripted stand-in for the results runner: records every call and answers by the --out directory's name.
function scripted(answers) {
  const calls = [];
  const runResults = async (argv) => {
    const out = argv[argv.indexOf('--out') + 1];
    const name = path.basename(out);
    calls.push({ name, specs: argv.flatMap((a, i) => (a === '--spec' ? [argv[i + 1]] : [])), argv });
    const a = typeof answers === 'function' ? answers(name, calls.length) : answers[name];
    if (!a) return { code: 3, doc: noReport };
    return { code: a.code === undefined ? (a.doc && a.doc.ok ? 0 : 1) : a.code, doc: a.doc };
  };
  return { runResults, calls };
}
const go = async (args, deps) => {
  const out = tmp();
  const o = { specs: [], reruns: 2, out, ...args };
  const r = await orchestrate(o, { env: {}, ...deps });
  return { ...r, out };
};

describe('orchestrate: the loop', () => {
  test('a green run ends after the main run: no re-runs, no triage, no files', async () => {
    const s = scripted({ main: { doc: result(T('a', 'passed'), T('b', 'passed')) } });
    const r = await go({ framework: 'node' }, { runResults: s.runResults });
    assert.equal(r.code, 0);
    assert.equal(r.doc.data.status, 'green');
    assert.equal(s.calls.length, 1);
    assert.equal(fs.existsSync(path.join(r.out, 'triage.json')), false);
  });

  test('failures are re-run ONCE PER RERUN, scoped to the failing spec files only', async () => {
    const failing = [T('DEMO-101/TC-005: x', 'failed', { ...ids(5), error: ASSERT }), T('DEMO-101/TC-006: y', 'failed', { ...ids(6), error: ASSERT }), T('ok', 'passed', { file: '/w/tests/c9.test.js' })];
    const s = scripted((name) => ({ doc: result(...failing) }));
    const r = await go({ framework: 'node', specs: ['all.test.js'], noPlan: true }, { runResults: s.runResults });
    assert.deepEqual(s.calls.map((c) => c.name), ['main', 'rerun-1', 'rerun-2']);
    assert.deepEqual(s.calls[0].specs, ['all.test.js'], 'the main run uses the caller\'s selection');
    for (const c of s.calls.slice(1)) assert.deepEqual(c.specs.sort(), ['/w/tests/c5.test.js', '/w/tests/c6.test.js'], 'a re-run touches only the failing files, never the passing one');
    assert.equal(r.doc.data.runs, 3);
    assert.deepEqual(r.doc.data.verdicts.map((v) => [v.rule, v.action]), [['PRD-1', 'act'], ['PRD-1', 'act']]);
  });

  test('--reruns 0 means a single attempt: product bugs are only PROPOSED (PRD-3)', async () => {
    const s = scripted({ main: { doc: result(T('DEMO-101/TC-005: x', 'failed', { ...ids(5), error: ASSERT })) } });
    const r = await go({ framework: 'node', reruns: 0, noPlan: true }, { runResults: s.runResults });
    assert.equal(s.calls.length, 1);
    assert.deepEqual(r.doc.data.verdicts.map((v) => [v.rule, v.action]), [['PRD-3', 'propose']]);
  });

  test('a failed preflight skips the re-runs and says why; every failure is an environment failure (ENV-1)', async () => {
    const s = scripted({ main: { doc: result(T('DEMO-101/TC-005: x', 'failed', { ...ids(5), error: ASSERT })) } });
    const r = await go({ framework: 'node', preflight: 'failed', noPlan: true }, { runResults: s.runResults });
    assert.equal(s.calls.length, 1);
    assert.match(r.doc.data.rerunNotes[0], /preflight reported the environment as not ready/);
    assert.deepEqual(r.doc.data.verdicts.map((v) => [v.class, v.rule]), [['environment', 'ENV-1']]);
  });

  test('a failure with no file location re-runs the caller\'s whole selection, and says so', async () => {
    const s = scripted(() => ({ doc: result(T('no-file test', 'failed', { error: ASSERT })) }));
    const r = await go({ framework: 'node', specs: ['suite.test.js'], noPlan: true }, { runResults: s.runResults });
    assert.deepEqual(s.calls[1].specs, ['suite.test.js']);
    assert.match(r.doc.data.rerunNotes[0], /no file location/);
  });

  test('a re-run that produces no usable report is skipped with a warning; the rest still classify', async () => {
    const t = T('DEMO-101/TC-005: x', 'failed', { ...ids(5), error: ASSERT });
    const s = scripted({ main: { doc: result(t) }, 'rerun-1': { doc: noReport, code: 3 }, 'rerun-2': { doc: result(t) } });
    const r = await go({ framework: 'node', noPlan: true }, { runResults: s.runResults });
    assert.equal(r.doc.data.runs, 2);
    assert.match(r.doc.data.warnings[0], /re-run 1 produced no usable report/);
    assert.equal(r.doc.data.verdicts[0].rule, 'PRD-1'); // main + one re-run = two failing attempts
  });

  test('a flaky pass in the main run (the runner retried it) is triaged even though nothing "failed"', async () => {
    const flaky = T('DEMO-102/TC-002: banner', 'passed', { ticket: 'DEMO-102', caseId: 'TC-002', file: '/w/tests/b.test.js', flaky: true, retries: 1 });
    const s = scripted(() => ({ doc: result(flaky, T('other', 'passed')) }));
    const r = await go({ framework: 'node', noPlan: true }, { runResults: s.runResults });
    assert.equal(r.doc.data.status, 'triaged');
    assert.deepEqual(r.doc.data.verdicts.map((v) => v.class), ['flaky']);
  });

  test('no trustworthy MAIN run (exit 3 from the runner) stops everything: nothing is classified', async () => {
    const s = scripted({ main: { doc: noReport, code: 3 } });
    const r = await go({ framework: 'node' }, { runResults: s.runResults });
    assert.equal(r.code, 3);
    assert.equal(r.doc.ok, false);
    assert.equal(r.doc.stage, 'run');
    assert.equal(r.doc.error.code, 'NO_REPORT');
    assert.equal(s.calls.length, 1);
    assert.equal(fs.existsSync(path.join(r.out, 'triage.json')), false);
  });

  test('a snapshot turns a missing-element failure into locator evidence (TST-1); without it the verdict is only a proposal', async () => {
    const snap = path.join(tmp(), 'page.html');
    fs.writeFileSync(snap, '<button data-testid="coupon-apply">Apply</button><input data-testid="coupon-input">');
    const stale = T('DEMO-101/TC-901: apply', 'failed', { ticket: 'DEMO-101', caseId: 'TC-901', file: '/w/tests/ui.test.js', error: E("locator not found: getByTestId('coupon-apply-btn')") });
    const s = () => scripted(() => ({ doc: result(stale) }));
    const withSnap = await go({ framework: 'node', snapshot: snap, noPlan: true }, { runResults: s().runResults });
    assert.deepEqual(withSnap.doc.data.verdicts.map((v) => [v.class, v.rule, v.action]), [['test-bug', 'TST-1', 'act']]);
    const without = await go({ framework: 'node', noPlan: true }, { runResults: s().runResults });
    assert.deepEqual(without.doc.data.verdicts.map((v) => [v.class, v.action]), [['undetermined', 'propose']]);
    const unreadable = await go({ framework: 'node', snapshot: '/nope/page.html', noPlan: true }, { runResults: s().runResults });
    assert.match(unreadable.doc.data.warnings[0], /snapshot not readable/);
    assert.equal(unreadable.doc.data.verdicts[0].class, 'undetermined');
  });

  test('two tests with the SAME NAME in different files each get their own locator evidence (it is keyed by identity, not name)', async () => {
    const snap = path.join(tmp(), 'page.html');
    fs.writeFileSync(snap, '<button data-testid="add-to-basket">Add</button>');
    const a = T('ui check', 'failed', { file: '/w/tests/a.test.js', error: E("locator not found: getByTestId('add-to-cart')") });
    const b = T('ui check', 'failed', { file: '/w/tests/b.test.js', error: E("locator not found: getByTestId('pay-now')") });
    const s = scripted(() => ({ doc: result(a, b) }));
    const r = await go({ framework: 'node', snapshot: snap, noPlan: true }, { runResults: s.runResults });
    const byFile = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(r.out, 'triage.json'), 'utf8')).data.verdicts.map((v) => [path.basename(v.test.file), v]));
    assert.deepEqual([byFile['a.test.js'].class, byFile['a.test.js'].rule], ['test-bug', 'TST-1']);
    assert.deepEqual([byFile['b.test.js'].class, byFile['b.test.js'].rule], ['undetermined', 'UND-1']);
  });

  test('it writes triage.json, plan.json and flaky.json, and --no-plan writes only the first', async () => {
    const flaky = [T('DEMO-102/TC-002: b', 'failed', { ticket: 'DEMO-102', caseId: 'TC-002', file: '/w/tests/b.test.js', error: ASSERT })];
    let n = 0;
    const s = scripted(() => ({ doc: result(...(n++ === 0 ? flaky : [T('DEMO-102/TC-002: b', 'passed', { ticket: 'DEMO-102', caseId: 'TC-002', file: '/w/tests/b.test.js' })])) }));
    const r = await go({ framework: 'node' }, { runResults: s.runResults });
    for (const f of ['triage.json', 'plan.json', 'flaky.json']) assert.ok(fs.existsSync(path.join(r.out, f)), f);
    assert.equal(JSON.parse(fs.readFileSync(path.join(r.out, 'flaky.json'), 'utf8')).flaky.length, 1);
    const n2 = await go({ framework: 'node', noPlan: true }, { runResults: scripted(() => ({ doc: result(...flaky) })).runResults });
    assert.equal(fs.existsSync(path.join(n2.out, 'plan.json')), false);
    assert.ok(fs.existsSync(path.join(n2.out, 'triage.json')));
  });

  test('the plan step searches the tracker for product bugs and the summary carries each failure\'s step', async () => {
    const mock = MOCKS.github();
    const cfg = path.join(tmp(), 'cfg.json');
    fs.writeFileSync(cfg, JSON.stringify({ ticketSource: { type: 'github', github: mock.settings } }));
    const s = scripted(() => ({ doc: result(T('DEMO-101/TC-005: x', 'failed', { ...ids(5), error: ASSERT })) }));
    const r = await go({ framework: 'node', config: cfg, baseUrl: mock.baseUrl, runId: 'r7' }, { runResults: s.runResults, env: { [mock.tokenEnv]: mock.token }, fetch: mock.fetch });
    assert.deepEqual(r.doc.data.verdicts.map((v) => v.step), ['file-bug']);
    assert.ok(mock.calls.some((c) => c.path === '/search/issues'), 'the tracker was searched');
    assert.equal(mock.createdItems().length, 0, 'orchestrating files nothing');
  });

  test('--config and the runner flags are passed through to the results runner; the runner is always --quiet', async () => {
    const s = scripted({ main: { doc: result(T('a', 'passed')) } });
    await go({ framework: 'playwright', testDir: 'e2e', configFile: 'pw.config.ts', cwd: '/proj', config: '/proj/qa-config.json', timeoutMs: 5000 }, { runResults: s.runResults });
    const a = s.calls[0].argv;
    for (const [flag, v] of [['--framework', 'playwright'], ['--test-dir', 'e2e'], ['--config-file', 'pw.config.ts'], ['--cwd', '/proj'], ['--config', '/proj/qa-config.json'], ['--timeout-ms', '5000']]) assert.equal(a[a.indexOf(flag) + 1], v, flag);
    assert.ok(a.includes('--quiet'));
  });
});

describe('orchestrate CLI', () => {
  const cli = async (argv) => { let out = ''; let e = ''; const code = await main({ argv, env: {}, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { e += s; } }, runResults: async () => ({ code: 3, doc: noReport }) }); return { code, err: e, json: out ? JSON.parse(out) : null }; };

  test('exit 3 when there is no trustworthy main run; exit 2 for bad invocations', async () => {
    assert.equal((await cli(['--framework', 'node', '--out', tmp()])).code, 3);
    assert.equal(MAX_RERUNS, 5);
    for (const argv of [[], ['--bogus'], ['--framework'], ['--framework', 'node', '--reruns', '-1'], ['--framework', 'node', '--reruns', '6'], ['--framework', 'node', '--reruns', '1.5'], ['--framework', 'node', '--preflight', 'maybe'], ['--framework', 'node', '--threshold', '0']]) {
      assert.equal((await cli(argv)).code, 2, argv.join(' '));
    }
  });
});
