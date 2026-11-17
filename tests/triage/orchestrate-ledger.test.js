'use strict';

// Slice 2: the orchestrator's run, remembered in the run ledger. The loop itself is tested in orchestrate.test.js and must behave the same
// whether or not it is being recorded (a test below holds it to that).

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { main, orchestrate } = require('../../scripts/triage/orchestrate');
const { cleanEnv } = require('../helpers/node-env');
const { openLedger } = require('../../scripts/ledger/lib/ledger');

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-orch-led-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const T = (name, status, extra = {}) => ({ name, status, ...extra });
const ASSERT = { kind: 'failure', message: 'a second application of the code should be rejected', details: '' };
const withFile = (n) => ({ ticket: 'DEMO-101', caseId: `TC-00${n}`, file: `/w/tests/c${n}.test.js` });
const result = (...tests) => ({ ok: tests.every((t) => t.status !== 'failed'), data: { format: 'tap', totals: { total: tests.length, passed: tests.filter((t) => t.status === 'passed').length, failed: tests.filter((t) => t.status === 'failed').length }, tests } });
const answerAll = (doc) => async () => ({ code: doc.ok ? 0 : 1, doc });
const cfgFile = (obj = {}) => { const f = path.join(tmp(), 'qa-config.json'); fs.writeFileSync(f, JSON.stringify(obj)); return f; };

// a run with one consistent failure and one pass
const FAILING = [T('DEMO-101/TC-005: x', 'failed', { ...withFile(5), error: ASSERT, durationMs: 12 }), T('ok', 'passed', { file: '/w/tests/c9.test.js' })];

async function go(args, deps, dir = path.join(tmp(), 'ledger')) {
  const out = tmp();
  const r = await orchestrate({ specs: [], reruns: 2, out, config: cfgFile(), noPlan: true, framework: 'node', runId: 'run-1', ledgerDir: dir, ...args }, { env: {}, ...deps });
  return { ...r, out, dir, events: () => openLedger({ dir }).readRun('run-1').events };
}

describe('the orchestrator records its run when asked', () => {
  test('a green run: run.start, one test.result per test, run.end with the totals', async () => {
    const r = await go({}, { runResults: answerAll(result(T('a', 'passed', { file: 'a.test.js' }), T('b', 'passed', { file: 'b.test.js' }))) });
    assert.equal(r.code, 0);
    assert.deepEqual(r.events().map((e) => e.type), ['run.start', 'test.result', 'test.result', 'run.end']);
    const [start, , , end] = r.events();
    assert.deepEqual([start.framework, start.pid, typeof start.host], ['node', process.pid, 'string']);
    assert.equal(start.config.reruns.value, 2, 'the settings this run used, and where each came from');
    assert.deepEqual([end.exit, end.complete, end.counts], [0, true, { total: 2, passed: 2, failed: 0 }]);
    assert.equal(openLedger({ dir: r.dir }).readRun('run-1').finished, true);
  });

  test('a failing run: the main run and every re-run are recorded by phase, then the verdict, then run.end', async () => {
    const r = await go({}, { runResults: answerAll(result(...FAILING)) });
    assert.equal(r.code, 0);
    const ev = r.events();
    assert.deepEqual(ev.map((e) => e.type), ['run.start', ...Array(6).fill('test.result'), 'verdict', 'run.end']);
    assert.deepEqual(ev.filter((e) => e.type === 'test.result').map((e) => [e.phase, e.name, e.status]), [
      ['main', 'DEMO-101/TC-005: x', 'failed'], ['main', 'ok', 'passed'], ['rerun-1', 'DEMO-101/TC-005: x', 'failed'], ['rerun-1', 'ok', 'passed'], ['rerun-2', 'DEMO-101/TC-005: x', 'failed'], ['rerun-2', 'ok', 'passed'],
    ]);
    assert.equal(ev[1].spec, '/w/tests/c5.test.js');
    assert.equal(ev[1].durationMs, 12);
    const v = ev.find((e) => e.type === 'verdict');
    assert.match(v.token, /^qafp[0-9a-f]{12}$/);
    assert.deepEqual([v.class, v.action, typeof v.confidence], ['product-bug', 'act', 'number']);
    assert.deepEqual([ev.at(-1).exit, ev.at(-1).complete], [0, true]);
  });

  test('a consistent failure that passes on re-run is recorded as the flip the flake rate counts', async () => {
    let calls = 0;
    const runResults = async () => { calls += 1; return { code: 0, doc: result(T('DEMO-101/TC-005: x', calls === 1 ? 'failed' : 'passed', { ...withFile(5), ...(calls === 1 ? { error: ASSERT } : {}) })) }; };
    const r = await go({}, { runResults });
    const results = r.events().filter((e) => e.type === 'test.result');
    assert.deepEqual(results.map((e) => [e.phase, e.status]), [['main', 'failed'], ['rerun-1', 'passed'], ['rerun-2', 'passed']]);
    const { flakeRates } = require('../../scripts/ledger/lib/views');
    assert.equal(flakeRates(openLedger({ dir: r.dir }), {}).tests[0].flips, 1);
  });

  test('a run with no trustworthy main run still ends in the ledger: run.end exit 3, not complete', async () => {
    const r = await go({}, { runResults: async () => ({ code: 3, doc: { ok: false, error: { code: 'NO_REPORT', message: 'wrote nothing' } } }) });
    assert.equal(r.code, 3);
    assert.deepEqual(r.events().map((e) => e.type), ['run.start', 'run.end']);
    assert.deepEqual([r.events()[1].exit, r.events()[1].complete], [3, false]);
  });

  test('an unexpected exception still writes run.end before it propagates', async () => {
    const dir = path.join(tmp(), 'ledger');
    await assert.rejects(() => go({}, { runResults: async () => { throw new Error('the runner exploded'); } }, dir), /the runner exploded/);
    const ev = openLedger({ dir }).readRun('run-1').events;
    assert.deepEqual(ev.map((e) => e.type), ['run.start', 'run.end']);
    assert.deepEqual([ev[1].exit, ev[1].complete], [3, false]);
  });

  test('a REAL SIGKILL during the main run leaves run.start and NO run.end: that is how the ledger knows the run did not finish', { skip: process.platform === 'win32', timeout: 90000 }, async () => {
    const root = tmp();
    const proj = path.join(root, 'proj');
    const sentinel = path.join(root, 'started');
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, 'slow.test.js'), `const test = require('node:test');\ntest('slow', async () => { require('fs').writeFileSync(${JSON.stringify(sentinel)}, '1'); await new Promise((r) => setTimeout(r, 60000)); });\n`);
    const dir = path.join(root, 'ledger');
    const script = path.join(__dirname, '..', '..', 'scripts', 'triage', 'orchestrate.js');
    const child = spawn(process.execPath, [script, '--framework', 'node', '--cwd', proj, '--spec', 'slow.test.js', '--out', path.join(root, 'out'), '--run-id', 'killed1', '--no-plan', '--preflight', 'ok', '--ledger-dir', dir, '--config', cfgFile()], { env: cleanEnv(), stdio: 'ignore', detached: true });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    const end = Date.now() + 60000;
    while (!fs.existsSync(sentinel) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(sentinel), true, 'the run reached the slow test');
    process.kill(-child.pid, 'SIGKILL'); // the orchestrator and the runner under it: nothing gets to clean up
    await exited;
    const l = openLedger({ dir });
    const r = l.readRun('killed1');
    assert.deepEqual(r.events.map((e) => e.type), ['run.start']);
    assert.equal(r.finished, false);
    assert.deepEqual(l.status().runs.unfinished, ['killed1']);
  });

  test('only the first 5000 results are recorded, and the run says so', async () => {
    const many = Array.from({ length: 5003 }, (_, i) => T(`t${i}`, 'passed', { file: 'big.test.js' }));
    const r = await go({}, { runResults: answerAll(result(...many)) });
    const ev = r.events();
    assert.equal(ev.filter((e) => e.type === 'test.result').length, 5000);
    assert.match(r.doc.data.warnings.join('\n'), /holds only the first 5000 test results/);
    assert.equal(ev.at(-1).type, 'run.end');
  });
});

describe('recording is opt-in, and bookkeeping never changes the run', () => {
  test('without a ledger block or --ledger-dir nothing is recorded and no ledger folder appears', async () => {
    const before = fs.existsSync('.qa-ledger');
    const out = tmp();
    const r = await orchestrate({ specs: [], reruns: 2, out, config: cfgFile(), noPlan: true, framework: 'node', runId: 'run-1' }, { env: {}, runResults: answerAll(result(...FAILING)) });
    assert.equal(r.code, 0);
    assert.equal(fs.existsSync('.qa-ledger'), before, 'no ledger folder was created in the working directory');
    assert.equal(r.doc.data.warnings, undefined);
  });

  test('a ledger block in qa-config.json turns it on, and its folder is beside the config file, not wherever the command ran', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'qa-config.json'), JSON.stringify({ ledger: {} }));
    const cwdBefore = fs.existsSync('.qa-ledger');
    const r = await orchestrate({ specs: [], reruns: 2, out: tmp(), config: path.join(root, 'qa-config.json'), noPlan: true, framework: 'node', runId: 'run-1' }, { env: {}, runResults: answerAll(result(T('a', 'passed', { file: 'a.test.js' }))) });
    assert.equal(r.code, 0);
    assert.equal(openLedger({ dir: path.join(root, '.qa-ledger') }).readRun('run-1').events.length, 3);
    assert.equal(fs.existsSync('.qa-ledger'), cwdBefore, 'nothing appeared in the working directory');
  });

  test('a project with a ledger cannot be diverted from it by --ledger-dir (the heal attempt cap lives there): naming the same one is fine', async () => {
    const root = tmp();
    const dir = path.join(root, 'the-ledger');
    const config = path.join(root, 'qa-config.json');
    fs.writeFileSync(config, JSON.stringify({ ledger: { dir } }));
    const base = { specs: [], reruns: 2, out: tmp(), config, noPlan: true, framework: 'node', runId: 'run-1' };
    const deps = { env: {}, runResults: answerAll(result(T('a', 'passed', { file: 'a.test.js' }))) };
    await assert.rejects(() => orchestrate({ ...base, ledgerDir: path.join(root, 'other') }, deps), (e) => e.isUsage && /not the ledger .* names/.test(e.message));
    assert.equal(fs.existsSync(path.join(root, 'other')), false);
    assert.equal((await orchestrate({ ...base, ledgerDir: dir }, deps)).code, 0);
  });

  test('the result is the same with and without the ledger, except for what the ledger adds', async () => {
    const run = (extra) => go({ out: tmp(), ...extra }, { runResults: answerAll(result(...FAILING)) });
    const withLedger = await run({});
    const without = await run({ ledgerDir: undefined });
    const strip = (d) => JSON.parse(JSON.stringify(d, (k, v) => (k === 'files' ? undefined : v)));
    assert.deepEqual(strip(withLedger.doc), strip(without.doc));
  });

  test('a ledger that cannot be written to is one warning, and the run is otherwise unaffected', async () => {
    const root = tmp();
    const notADir = path.join(root, 'file');
    fs.writeFileSync(notADir, 'x');
    const r = await go({}, { runResults: answerAll(result(...FAILING)) }, path.join(notADir, 'ledger'));
    assert.equal(r.code, 0);
    assert.equal(r.doc.data.status, 'triaged');
    assert.deepEqual(r.doc.data.verdicts.map((v) => v.class), ['product-bug']);
    const w = r.doc.data.warnings.filter((x) => x.startsWith('ledger:'));
    assert.equal(w.length, 1, 'said once, not once per event');
    assert.match(w[0], /could not record/);
  });

  test('a run id that looks like a credential is refused by the ledger, with a warning, and the run still works', async () => {
    const r = await go({ runId: 'run-ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, { runResults: answerAll(result(T('a', 'passed', { file: 'a.test.js' }))) });
    assert.equal(r.code, 0);
    assert.match(r.doc.data.warnings.join('\n'), /ledger: could not record/);
    assert.equal(openLedger({ dir: r.dir }).listRuns().length, 0);
  });

  test('an earlier heal that never ended is reported at the start of the next run', async () => {
    const dir = path.join(tmp(), 'ledger');
    openLedger({ dir }).record('died-run', 'heal.begin', { branch: 'qa/heal-died-run', baseSha: 'abcdef0123456789', tokens: ['qafp000000000001'] });
    const r = await go({}, { runResults: answerAll(result(T('a', 'passed', { file: 'a.test.js' }))) }, dir);
    const w = r.doc.data.warnings.find((x) => /never recorded how it ended/.test(x));
    assert.ok(w, JSON.stringify(r.doc.data.warnings));
    assert.match(w, /run died-run began a self-heal on qa\/heal-died-run \(from abcdef01\)/);
    assert.match(w, /git branch --list 'qa\/heal-\*'/);
  });

  test('there is no --no-ledger (a flag may not turn off what the project set); an empty --ledger-dir is a usage error, exit 2', async () => {
    for (const [argv, re] of [[['--no-ledger'], /unknown option --no-ledger/], [['--ledger-dir', ''], /--ledger-dir needs a folder path/]]) {
      let err = '';
      const code = await main({ argv: ['--framework', 'node', ...argv, '--config', cfgFile()], env: {}, stdout: { write: () => {} }, stderr: { write: (t) => { err += t; } } });
      assert.equal(code, 2, argv.join(' '));
      assert.match(err, re);
    }
  });

  test('a bad ledger block is a usage error naming the key, before any test is run', async () => {
    let ran = false;
    let err = '';
    const code = await main({ argv: ['--framework', 'node', '--config', cfgFile({ ledger: { retentionDays: 0 } })], env: {}, stdout: { write: () => {} }, stderr: { write: (t) => { err += t; } }, runResults: async () => { ran = true; return { code: 0, doc: result() }; } });
    assert.equal(code, 2);
    assert.equal(ran, false);
    assert.match(err, /ledger.retentionDays/);
  });
});

describe('what the review of slice 2 found in the orchestrator', () => {
  test('a project WITHOUT a ledger sees no new warning, however many results a run has (the counter counted for nobody)', async () => {
    const many = Array.from({ length: 5003 }, (_, i) => T(`t${i}`, 'passed', { file: 'big.test.js' }));
    const out = tmp();
    const r = await orchestrate({ specs: [], reruns: 2, out, config: cfgFile(), noPlan: true, framework: 'node', runId: 'run-1' }, { env: {}, runResults: answerAll(result(...many)) });
    assert.equal(r.code, 0);
    assert.equal(r.doc.data.warnings, undefined);
  });

  test('a usage error thrown after the run began is recorded as exit 2; one before it began leaves no run at all', async () => {
    const dir = path.join(tmp(), 'ledger');
    const usageErr = Object.assign(new Error('bad flag'), { isUsage: true });
    await assert.rejects(() => go({}, { runResults: async () => { throw usageErr; } }, dir), /bad flag/);
    const ev = openLedger({ dir }).readRun('run-1').events;
    assert.deepEqual(ev.map((e) => [e.type, e.exit]), [['run.start', undefined], ['run.end', 2]]);
    // a bad triage setting is refused before run.start: nothing was started, so nothing is ended
    const dir2 = path.join(tmp(), 'ledger');
    await assert.rejects(() => go({ config: cfgFile({ triage: { reruns: 99 } }) }, { runResults: answerAll(result()) }, dir2), (e) => e.isUsage);
    assert.deepEqual(openLedger({ dir: dir2 }).listRuns(), []);
  });

  test('only the first 2000 verdicts are recorded, and the run says so', async () => {
    const failing = Array.from({ length: 2003 }, (_, i) => T(`DEMO-101/TC-${String(i).padStart(4, '0')}: t${i}`, 'failed', { ticket: 'DEMO-101', caseId: `TC-${String(i).padStart(4, '0')}`, file: `/w/tests/c${i}.test.js`, error: { kind: 'failure', message: `expected ${i} to equal ${i + 1}`, details: '' } }));
    const r = await go({ reruns: 0 }, { runResults: answerAll(result(...failing)) });
    const ev = r.events();
    assert.equal(ev.filter((e) => e.type === 'verdict').length, 2000);
    assert.ok(r.doc.data.warnings.some((w) => /holds only the first 2000 verdicts/.test(w)), JSON.stringify(r.doc.data.warnings));
    assert.equal(ev.at(-1).type, 'run.end');
  });

  test('a test the runner itself called flaky is recorded as flaky, and counts as a flip in the flake rate even though every phase passed', async () => {
    const flaky = T('DEMO-101/TC-005: x', 'passed', { ...withFile(5), flaky: true });
    const r = await go({}, { runResults: answerAll(result(flaky)) });
    assert.deepEqual(r.events().filter((e) => e.type === 'test.result').map((e) => [e.phase, e.status, e.flaky]), [['main', 'passed', true], ['rerun-1', 'passed', true], ['rerun-2', 'passed', true]]);
    const { flakeRates } = require('../../scripts/ledger/lib/views');
    assert.deepEqual(flakeRates(openLedger({ dir: r.dir }), {}).tests.map((t) => [t.name, t.flips]), [['DEMO-101/TC-005: x', 1]]);
  });

  test('two runs that share a run id (a resume, or two started in the same second) are two runs in the ledger, and a pass in one and a fail in the other is not a flip', async () => {
    const dir = path.join(tmp(), 'ledger');
    await go({ reruns: 0 }, { runResults: answerAll(result(T('login', 'passed', { file: 'a.test.js' }))) }, dir);
    await go({ reruns: 0 }, { runResults: answerAll(result(T('login', 'failed', { file: 'a.test.js', error: ASSERT }))) }, dir);
    const l = openLedger({ dir });
    assert.equal(l.readAllRuns().length, 2);
    const { flakeRates } = require('../../scripts/ledger/lib/views');
    assert.deepEqual(flakeRates(l, { includeStable: true }).tests.map((t) => [t.runsSeen, t.flips]), [[2, 0]]);
  });
});

describe('the loop, end to end: a bug filed in one run is commented on in the next, even while the tracker\'s index lags', () => {
  test('run 1 plans file-bug, the bug is filed through the ledger, run 2 plans comment-existing from the ledger (and says why)', async () => {
    const { MOCKS } = require('../tracker/workspace');
    const { createAdapter } = require('../../scripts/tracker/adapters');
    const { runOnce } = require('../../scripts/tracker/lib/once');
    const mock = MOCKS.github();
    mock.state.searchLag = true; // a bug filed now is not in the search for a while
    const root = tmp();
    const dir = path.join(root, 'ledger');
    const config = path.join(root, 'qa-config.json');
    fs.writeFileSync(config, JSON.stringify({ ticketSource: { type: 'github', github: mock.settings }, ledger: { dir } }));
    const env = { [mock.tokenEnv]: mock.token };
    const loop = (runId) => orchestrate({ specs: [], reruns: 2, out: tmp(), config, framework: 'node', runId, baseUrl: mock.baseUrl, preflight: 'ok' }, { env, fetch: mock.fetch, runResults: answerAll(result(...FAILING)) });

    const one = await loop('run-1');
    const planned = JSON.parse(fs.readFileSync(one.doc.data.files.plan, 'utf8')).data.actions[0];
    assert.equal(planned.step, 'file-bug');

    // /file-bug: the tracker CLI's write path, under the key the plan handed out
    const adapter = createAdapter('github', { settings: mock.settings, env, fetch: mock.fetch, baseUrl: mock.baseUrl, timeoutMs: 500, retryDelayMs: 0 });
    const bug = await runOnce(adapter, 'create-bug', { title: 'Second code accepted', body: `Steps.\n\n${planned.marker}`, idempotencyKey: planned.idempotencyKey }, { ledger: openLedger({ dir }), runId: 'run-1' });

    const two = await loop('run-2');
    const a = JSON.parse(fs.readFileSync(two.doc.data.files.plan, 'utf8')).data.actions[0];
    assert.equal(a.step, 'comment-existing');
    assert.deepEqual([a.existing.id, a.existing.source], [String(bug.id), 'ledger']);
    assert.deepEqual(two.doc.data.verdicts.map((v) => v.step), ['comment-existing']);
    assert.ok(two.doc.data.warnings.some((w) => /which this ledger filed/.test(w)), JSON.stringify(two.doc.data.warnings));
    assert.equal(mock.createdItems().length, 1, 'one bug on the tracker, not two');
    assert.deepEqual(openLedger({ dir }).readRun('run-2').events.filter((e) => e.type === 'verdict').map((e) => e.step), ['comment-existing'], 'and the verdict event says what the plan did');
  });
});
