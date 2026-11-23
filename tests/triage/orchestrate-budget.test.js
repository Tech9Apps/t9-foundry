'use strict';

// Slice 4 in the orchestrator: the run locks, the per-ticket cooldown and the wall-clock budget. A refusal (exit 4) starts nothing and leaves nothing behind; a
// stop (exit 5) is a partial result that says what it did not do; and with no ledger there are no locks and no cooldown, only the wall-clock limit.

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main, orchestrate } = require('../../scripts/triage/orchestrate');
const { openLedger } = require('../../scripts/ledger/lib/ledger');

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-orch-bud-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const T = (name, status, extra = {}) => ({ name, status, ...extra });
const ASSERT = { kind: 'failure', message: 'a second application of the code should be rejected', details: '' };
const result = (...tests) => ({ ok: tests.every((t) => t.status !== 'failed'), data: { format: 'tap', totals: { total: tests.length, passed: tests.filter((t) => t.status === 'passed').length, failed: tests.filter((t) => t.status === 'failed').length }, tests } });
const PASSING = [T('a', 'passed', { file: 'a.test.js' })];
const FAILING = [T('DEMO-101/TC-005: x', 'failed', { ticket: 'DEMO-101', caseId: 'TC-005', file: '/w/tests/c5.test.js', error: ASSERT }), T('ok', 'passed', { file: '/w/tests/c9.test.js' })];
const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-13T10:00:00Z');
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const ENV_URL = 'https://staging.example.com';

// a world: a config with a ledger (and whatever else the test says), a clock the test moves, and a scripted runner that counts what it was asked to run
function world(configExtra = {}, { ledger = true } = {}) {
  const root = tmp();
  const dir = path.join(root, 'ledger');
  const config = path.join(root, 'qa-config.json');
  fs.writeFileSync(config, JSON.stringify({ environments: { testEnvironmentBaseUrl: ENV_URL }, ...(ledger ? { ledger: { dir } } : {}), ...configExtra }));
  const w = { root, dir, config, clock: T0, calls: [], hook: null };
  w.now = () => w.clock;
  w.runner = (tests = PASSING) => async (argv) => {
    const out = path.basename(argv[argv.indexOf('--out') + 1]);
    w.calls.push(out);
    if (w.hook) await w.hook(out);
    return { code: tests.every((t) => t.status !== 'failed') ? 0 : 1, doc: result(...tests) };
  };
  w.run = (args = {}, tests = PASSING) => orchestrate({ specs: [], reruns: 2, out: tmp(), config, noPlan: true, framework: 'node', runId: 'run-1', ...args }, { env: {}, now: w.now, runResults: w.runner(tests) });
  w.ledger = (extra = {}) => openLedger({ dir, now: w.now, ...extra });
  return w;
}

describe('the per-ticket cooldown', () => {
  test('a ticket run again inside its cooldown is REFUSED (exit 4) and nothing is left behind: no run.start, no lock, nothing run', async () => {
    const w = world({ budget: { cooldownMinutes: 30 } });
    assert.equal((await w.run({ ticket: 'T-1', runId: 'first' })).code, 0);
    w.calls.length = 0;
    w.clock = T0 + 10 * MIN;
    const r = await w.run({ ticket: 'T-1', runId: 'second' });
    assert.equal(r.code, 4);
    assert.deepEqual([r.doc.ok, r.doc.stage, r.doc.error.code], [false, 'cooldown', 'COOLDOWN']);
    assert.match(r.doc.error.message, /ticket T-1 was last run by first, which ended 10 minute\(s\) ago; the cooldown is 30 minute\(s\), so this run was not started/);
    assert.deepEqual([r.doc.error.details.ticket, r.doc.error.details.lastRunId, r.doc.error.details.cooldownMinutes], ['T-1', 'first', 30]);
    assert.deepEqual(w.calls, [], 'the tests were not run');
    assert.deepEqual(w.ledger().readRun('second').events, [], 'and no record was made of the refused attempt');
    assert.deepEqual(w.ledger().listLocks(), [], 'and no lock is held');
  });

  test('the boundary: 29 minutes 59 seconds after the last run is still inside the cooldown, exactly 30 minutes is not', async () => {
    const w = world({ budget: { cooldownMinutes: 30 } });
    await w.run({ ticket: 'T-1', runId: 'first' }); // ends at T0
    w.clock = T0 + 30 * MIN - 1000;
    assert.equal((await w.run({ ticket: 'T-1', runId: 'a' })).code, 4);
    w.clock = T0 + 30 * MIN;
    assert.equal((await w.run({ ticket: 'T-1', runId: 'b' })).code, 0);
  });

  test('the cooldown ends, and is per ticket: another ticket, and a run with no ticket, are never held by it', async () => {
    const w = world({ budget: { cooldownMinutes: 30 } });
    await w.run({ ticket: 'T-1', runId: 'first' });
    w.clock = T0 + 10 * MIN;
    assert.equal((await w.run({ ticket: 'T-2', runId: 'other-ticket' })).code, 0);
    assert.equal((await w.run({ runId: 'no-ticket' })).code, 0);
    w.clock = T0 + 31 * MIN;
    assert.equal((await w.run({ ticket: 'T-1', runId: 'third' })).code, 0, 'thirty minutes after it ended');
  });

  test('any run that ended counts, whether it completed or not; one that never ended (it died) does not', async () => {
    const w = world({ budget: { cooldownMinutes: 30 } });
    const l = w.ledger();
    l.record('died', 'run.start', { pid: 1, host: 'h', ticket: 'T-1' }); // no run.end
    assert.equal((await w.run({ ticket: 'T-1', runId: 'a' })).code, 0, 'a run that died leaves no end to wait out');
    w.clock = T0 + MIN;
    l.record('bad', 'run.start', { pid: 1, host: 'h', ticket: 'T-9' });
    l.record('bad', 'run.end', { exit: 3, complete: false });
    assert.equal((await w.run({ ticket: 'T-9', runId: 'b' })).code, 4, 'a run that ended in failure still ended');
  });

  test('a flag may LENGTHEN the cooldown but never shorten what the project set; with none set, the flag sets one', async () => {
    const w = world({ budget: { cooldownMinutes: 30 } });
    await w.run({ ticket: 'T-1', runId: 'first' });
    w.clock = T0 + 20 * MIN;
    assert.equal((await w.run({ ticket: 'T-1', runId: 'x', cooldownMinutes: 5 })).code, 4, '5 minutes asked for, 30 configured: 30 holds');
    assert.equal((await w.run({ ticket: 'T-1', runId: 'y', cooldownMinutes: 0 })).code, 4);
    assert.equal((await w.run({ ticket: 'T-1', runId: 'z', cooldownMinutes: 90 })).code, 4, 'a longer one is fine');
    const free = world();
    await free.run({ ticket: 'T-1', runId: 'first' });
    free.clock = T0 + MIN;
    assert.equal((await free.run({ ticket: 'T-1', runId: 'a' })).code, 0, 'no cooldown configured');
    assert.equal((await free.run({ ticket: 'T-1', runId: 'b', cooldownMinutes: 10 })).code, 4, 'the flag set one');
  });

  test('a last run that ended in the FUTURE (a clock that was wrong) does not hold a ticket', async () => {
    const w = world({ budget: { cooldownMinutes: 30 } });
    const l = w.ledger();
    w.clock = T0 + 5 * 24 * 60 * MIN;
    l.record('future', 'run.start', { pid: 1, host: 'h', ticket: 'T-1' });
    l.record('future', 'run.end', { exit: 0, complete: true });
    w.clock = T0;
    assert.equal((await w.run({ ticket: 'T-1', runId: 'now' })).code, 0);
  });

  test('without a ledger there is nothing to read: the cooldown is not applied (and nothing says it was)', async () => {
    const w = world({ budget: { cooldownMinutes: 30 } }, { ledger: false });
    assert.equal((await w.run({ ticket: 'T-1', runId: 'a' })).code, 0);
    const r = await w.run({ ticket: 'T-1', runId: 'b' });
    assert.equal(r.code, 0);
    assert.ok(r.doc.data.warnings.some((m) => /a cooldown is set but there is no run ledger/.test(m)), 'it says so, once the project has asked for a cooldown');
    const plain = world({}, { ledger: false });
    assert.equal((await plain.run({ ticket: 'T-1', runId: 'c' })).doc.data.warnings, undefined, 'with no cooldown asked for, nothing new is said');
  });

  test('the run records its ticket, so the next run can find it', async () => {
    const w = world();
    await w.run({ ticket: 'T-77', runId: 'rec' });
    assert.equal(w.ledger().readRun('rec').events.find((e) => e.type === 'run.start').ticket, 'T-77');
  });
});

describe('the run locks', () => {
  const holder = (w, scope, runId = 'busy-run') => w.ledger({ pid: process.ppid }).acquireLock(scope, { runId });

  test('another run holds the ENVIRONMENT: refused (exit 4) naming who and since when; nothing started, and the holder\'s lock is untouched', async () => {
    const w = world();
    holder(w, `env:${ENV_URL}`);
    const r = await w.run();
    assert.equal(r.code, 4);
    assert.deepEqual([r.doc.ok, r.doc.stage, r.doc.error.code], [false, 'lock', 'LOCKED']);
    assert.match(r.doc.error.message, /locked by run busy-run since 2026-11-13T10:00:00\.000Z \(env:https:\/\/staging\.example\.com\); this run was not started/);
    assert.deepEqual([r.doc.error.details.scope, r.doc.error.details.runId, r.doc.error.details.pid], [`env:${ENV_URL}`, 'busy-run', process.ppid]);
    assert.deepEqual(w.calls, []);
    assert.deepEqual(w.ledger().readRun('run-1').events, []);
    assert.deepEqual(w.ledger().listLocks().map((l) => l.runId), ['busy-run']);
  });

  test('the same environment however it is written in the config (case, trailing slash, default port)', async () => {
    for (const written of ['https://Staging.Example.com/', 'https://staging.example.com:443']) {
      const w = world({ environments: { testEnvironmentBaseUrl: written } });
      holder(w, `env:${ENV_URL}`);
      assert.equal((await w.run()).code, 4, written);
    }
  });

  test('another run holds the TICKET: refused. With both held, the one named first in the fixed order (the environment) is reported', async () => {
    const w = world();
    holder(w, 'ticket:T-1');
    const r = await w.run({ ticket: 'T-1' });
    assert.equal(r.code, 4);
    assert.equal(r.doc.error.details.scope, 'ticket:T-1');
    assert.deepEqual(w.ledger().listLocks().map((l) => l.scope), ['ticket:T-1'], 'the environment lock this run took first was given back');
    holder(w, `env:${ENV_URL}`, 'env-holder');
    assert.equal((await w.run({ ticket: 'T-1' })).doc.error.details.scope, `env:${ENV_URL}`);
  });

  test('a run that is allowed holds BOTH locks for as long as it goes on, and gives them back when it ends: green, failing, or stopped', async () => {
    const w = world({ budget: { maxWallClockMs: 60000 } });
    let during = null;
    w.hook = async () => { during = [w.ledger({ pid: process.ppid }).acquireLock(`env:${ENV_URL}`, { runId: 'p1' }).acquired, w.ledger({ pid: process.ppid }).acquireLock('ticket:T-1', { runId: 'p2' }).acquired]; };
    assert.equal((await w.run({ ticket: 'T-1' })).code, 0);
    assert.deepEqual(during, [false, false], 'neither could be taken while the run was going');
    assert.deepEqual(w.ledger().listLocks(), [], 'given back');
    w.hook = null;
    assert.equal((await w.run({ ticket: 'T-1', runId: 'r2' }, FAILING)).code, 0);
    assert.deepEqual(w.ledger().listLocks(), []);
    w.hook = async () => { w.clock += 120 * 1000; };
    assert.equal((await w.run({ ticket: 'T-1', runId: 'r3' }, FAILING)).code, 5, 'stopped by its budget');
    assert.deepEqual(w.ledger().listLocks(), []);
  });

  test('an exception inside the run (and a usage error) still gives the locks back', async () => {
    const w = world();
    await assert.rejects(() => orchestrate({ specs: [], reruns: 2, out: tmp(), config: w.config, noPlan: true, framework: 'node', runId: 'boom', ticket: 'T-1' }, { env: {}, now: w.now, runResults: async () => { throw new Error('the runner exploded'); } }), /exploded/);
    assert.deepEqual(w.ledger().listLocks(), []);
    await assert.rejects(() => orchestrate({ specs: [], reruns: 2, out: tmp(), config: w.config, noPlan: true, framework: 'node', runId: 'bad', ticket: 'T-1' }, { env: {}, now: w.now, runResults: async () => { throw Object.assign(new Error('bad flag'), { isUsage: true }); } }), /bad flag/);
    assert.deepEqual(w.ledger().listLocks(), []);
  });

  test('a run with no trustworthy result (exit 3) gives them back too', async () => {
    const w = world();
    const r = await orchestrate({ specs: [], reruns: 2, out: tmp(), config: w.config, noPlan: true, framework: 'node', runId: 'bad', ticket: 'T-1' }, { env: {}, now: w.now, runResults: async () => ({ code: 3, doc: { ok: false, error: { code: 'NO_REPORT', message: 'wrote nothing' } } }) });
    assert.equal(r.code, 3);
    assert.deepEqual(w.ledger().listLocks(), []);
  });

  test('a lock whose owner is gone is taken over, the run goes ahead, and it says so (and the steal is in the audit log)', async () => {
    const w = world();
    w.ledger({ pid: deadPid() }).acquireLock(`env:${ENV_URL}`, { runId: 'died' });
    const r = await w.run();
    assert.equal(r.code, 0);
    assert.ok(r.doc.data.warnings.some((m) => /took over a stale run lock \(env:https:\/\/staging\.example\.com\)/.test(m)), JSON.stringify(r.doc.data.warnings));
    assert.deepEqual(w.ledger().readAudit().events.filter((e) => e.type === 'lock.stolen').map((e) => [e.scope, e.previousRunId]), [[`env:${ENV_URL}`, 'died']]);
  });

  test('two overlapping runs on one environment: the second is refused while the first runs, and the third goes ahead once it has finished', async () => {
    const w = world();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    w.hook = async () => { await gate; };
    const first = w.run({ runId: 'first' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    w.hook = null;
    const second = await w.run({ runId: 'second' });
    assert.equal(second.code, 4);
    assert.match(second.doc.error.message, /locked by run first/);
    release();
    assert.equal((await first).code, 0);
    assert.equal((await w.run({ runId: 'third' })).code, 0);
  });

  test('without a ledger there are no locks: two runs overlap freely, and no ledger folder appears', async () => {
    const w = world({}, { ledger: false });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    w.hook = async () => { await gate; };
    const first = w.run({ runId: 'first' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    w.hook = null;
    assert.equal((await w.run({ runId: 'second' })).code, 0);
    release();
    await first;
    assert.equal(fs.existsSync(w.dir), false);
  });

  test('a ledger that cannot take the locks is a warning, and the run goes ahead unprotected (bookkeeping never blocks a run)', async () => {
    const w = world();
    fs.mkdirSync(w.dir, { recursive: true });
    fs.writeFileSync(path.join(w.dir, 'VERSION'), '9\n');
    const r = await w.run();
    assert.equal(r.code, 0);
    assert.ok(r.doc.data.warnings.some((m) => /could not take the run locks/.test(m) && /not protected from a concurrent one/.test(m)), JSON.stringify(r.doc.data.warnings));
  });

  test('no environment named and no ticket: nothing to lock, so nothing is taken', async () => {
    const w = world({ environments: {} });
    assert.equal((await w.run()).code, 0);
    assert.equal(fs.existsSync(path.join(w.dir, 'locks')) ? fs.readdirSync(path.join(w.dir, 'locks')).length : 0, 0);
  });
});

describe('the wall-clock budget', () => {
  test('a run past its limit stops BEFORE the next step, classifies what it has, and ends with exit 5 and complete: false, saying what it skipped', async () => {
    const w = world({ budget: { maxWallClockMs: 60000 } });
    w.hook = async (out) => { if (out === 'main') w.clock += 90 * 1000; };
    const r = await w.run({ noPlan: false }, FAILING);
    assert.equal(r.code, 5);
    assert.equal(r.doc.ok, true, 'a partial result, not an error');
    const d = r.doc.data;
    assert.deepEqual([d.status, d.runs], ['triaged', 1]);
    assert.deepEqual(d.budget, { stopped: true, exceeded: 'wall-clock', limitMs: 60000, elapsedMs: 90000, before: 'the re-runs', skipped: ['re-runs', 'plan'] });
    assert.deepEqual(w.calls, ['main'], 'no re-run was started');
    assert.equal(d.verdicts.length, 1, 'what could be classified was');
    assert.ok(d.warnings.some((m) => /stopped by the wall-clock budget \(60000 ms, 90000 ms used\) before the re-runs/.test(m)));
    const ev = w.ledger().readRun('run-1').events;
    assert.deepEqual(ev.filter((e) => e.type === 'budget').map((e) => [e.wallClockMs, e.exceeded]), [[90000, 'wall-clock limit of 60000 ms reached before the re-runs'], [90000, undefined]]);
    const end = ev.at(-1);
    assert.deepEqual([end.type, end.exit, end.complete], ['run.end', 5, false]);
  });

  test('between re-runs: the ones already run count, the rest are skipped', async () => {
    const w = world({ budget: { maxWallClockMs: 60000 } });
    w.hook = async (out) => { if (out === 'rerun-1') w.clock += 90 * 1000; };
    const r = await w.run({ reruns: 4, noPlan: true }, FAILING);
    assert.equal(r.code, 5);
    assert.deepEqual(w.calls, ['main', 'rerun-1']);
    assert.deepEqual([r.doc.data.runs, r.doc.data.budget.before, r.doc.data.budget.skipped], [2, 're-run 2', ['re-run 2 onward']]);
  });

  test('at the plan: the re-runs happened, the tracker search did not', async () => {
    const w = world({ budget: { maxWallClockMs: 60000 } });
    w.hook = async (out) => { if (out === 'rerun-2') w.clock += 90 * 1000; };
    const r = await w.run({ noPlan: false }, FAILING);
    assert.equal(r.code, 5);
    assert.deepEqual([r.doc.data.runs, r.doc.data.budget.before, r.doc.data.budget.skipped], [3, 'the plan', ['plan']]);
    assert.equal(r.doc.data.files.plan, undefined, 'no plan was written');
  });

  test('under the limit nothing changes: exit 0, no budget field', async () => {
    const w = world({ budget: { maxWallClockMs: 600000 } });
    const r = await w.run({}, FAILING);
    assert.equal(r.code, 0);
    assert.equal(r.doc.data.budget, undefined);
  });

  test('a green run that went over its limit stopped nothing: there was nothing left to skip', async () => {
    const w = world({ budget: { maxWallClockMs: 1000 } });
    w.hook = async () => { w.clock += 5000; };
    const r = await w.run({}, PASSING);
    assert.equal(r.code, 0);
    assert.equal(r.doc.data.status, 'green');
  });

  test('a flag may tighten the limit, never lift it; with none configured the flag sets one; it works with no ledger at all', async () => {
    const over = async (w) => { w.hook = async (out) => { if (out === 'main') w.clock += 90 * 1000; }; };
    const cfgd = world({ budget: { maxWallClockMs: 60000 } });
    await over(cfgd);
    assert.equal((await cfgd.run({ maxWallClockMs: 0 }, FAILING)).code, 5, 'a flag of 0 cannot switch the project\'s limit off');
    cfgd.calls.length = 0;
    assert.equal((await cfgd.run({ maxWallClockMs: 999999, runId: 'b' }, FAILING)).code, 5, 'nor loosen it');
    const flagOnly = world();
    await over(flagOnly);
    assert.equal((await flagOnly.run({ maxWallClockMs: 60000 }, FAILING)).code, 5, 'with no project limit the flag sets one');
    const noLedger = world({ budget: { maxWallClockMs: 60000 } }, { ledger: false });
    await over(noLedger);
    const r = await noLedger.run({}, FAILING);
    assert.equal(r.code, 5, 'the wall-clock limit does not need a ledger');
    assert.equal(fs.existsSync(noLedger.dir), false);
  });

  test('the flags are checked: a negative or odd limit, or a ticket that is empty, too long or credential-like, is a usage error (exit 2) before anything runs', async () => {
    const w = world();
    for (const [argv, re] of [[['--max-wall-clock-ms', '-1'], /--max-wall-clock-ms must be a whole number from 0 to/], [['--max-wall-clock-ms', '1.5'], /--max-wall-clock-ms/], [['--cooldown-minutes', 'x'], /--cooldown-minutes must be a whole number/], [['--ticket', ''], /--ticket must be 1-128 characters/], [['--ticket', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'], /--ticket looks like a credential/]]) {
      let err = '';
      const code = await main({ argv: ['--framework', 'node', ...argv, '--config', w.config], env: {}, stdout: { write: () => {} }, stderr: { write: (t) => { err += t; } }, runResults: w.runner() });
      assert.equal(code, 2, argv.join(' '));
      assert.match(err, re);
    }
    assert.deepEqual(w.calls, []);
  });

  test('a malformed budget block stops the run with a usage error naming the key, before anything runs', async () => {
    const w = world({ budget: { maxTurns: -3 } });
    let err = '';
    const code = await main({ argv: ['--framework', 'node', '--config', w.config], env: {}, stdout: { write: () => {} }, stderr: { write: (t) => { err += t; } }, runResults: w.runner() });
    assert.equal(code, 2);
    assert.match(err, /budget\.maxTurns/);
    assert.deepEqual(w.calls, []);
  });

  test('through main(): the exit codes are 4 for a refusal and 5 for a stop', async () => {
    const run = async (w, argv, tests = PASSING) => { let out = ''; const code = await main({ argv: ['--framework', 'node', '--config', w.config, '--out', tmp(), '--no-plan', '--run-id', 'm1', ...argv], env: {}, now: w.now, stdout: { write: (t) => { out += t; } }, stderr: { write: () => {} }, runResults: w.runner(tests) }); return { code, json: JSON.parse(out) }; };
    const w = world({ budget: { cooldownMinutes: 30, maxWallClockMs: 60000 } });
    w.hook = async (out) => { if (out === 'main') w.clock += 90 * 1000; };
    const stopped = await run(w, ['--ticket', 'T-1'], FAILING);
    assert.equal(stopped.code, 5);
    assert.equal(stopped.json.data.budget.stopped, true);
    w.hook = null;
    const refused = await run(w, ['--ticket', 'T-1', '--run-id', 'm2'], FAILING);
    assert.equal(refused.code, 4);
    assert.equal(refused.json.error.code, 'COOLDOWN');
  });
});

describe('review of slice 4: what the first review found', () => {
  test('a ticketless run is never held by another ticketless run\'s cooldown', async () => {
    const w = world({ budget: { cooldownMinutes: 30 } });
    assert.equal((await w.run({ runId: 'a' })).code, 0);
    w.clock = T0 + MIN;
    assert.equal((await w.run({ runId: 'b' })).code, 0);
  });

  test('a run that completes with locks and nothing to report has no warnings at all (the steal warning needs a steal)', async () => {
    const w = world();
    const r = await w.run({ ticket: 'T-1' });
    assert.equal(r.code, 0);
    assert.equal(r.doc.data.warnings, undefined);
  });

  test('the wall-clock limit is "more than": a run that has used exactly its limit at a step is not stopped', async () => {
    const w = world({ budget: { maxWallClockMs: 60000 } });
    w.hook = async (out) => { if (out === 'main') w.clock += 60000; };
    const r = await w.run({}, FAILING);
    assert.equal(r.code, 0);
    assert.deepEqual(w.calls, ['main', 'rerun-1', 'rerun-2']);
  });

  test('a run that ended with a wrong clock (days ahead) does not hide a genuine run that ended a minute ago: the cooldown still holds', async () => {
    const w = world({ budget: { cooldownMinutes: 30 } });
    const l = w.ledger();
    w.clock = T0 + 3 * 24 * 60 * MIN;
    l.record('wrong-clock', 'run.start', { pid: 1, host: 'h', ticket: 'T-1' });
    l.record('wrong-clock', 'run.end', { exit: 0, complete: true });
    w.clock = T0 + 9 * MIN;
    l.record('genuine', 'run.start', { pid: 1, host: 'h', ticket: 'T-1' });
    l.record('genuine', 'run.end', { exit: 0, complete: true });
    w.clock = T0 + 10 * MIN;
    const r = await w.run({ ticket: 'T-1', runId: 'next' });
    assert.equal(r.code, 4);
    assert.equal(r.doc.error.details.lastRunId, 'genuine');
  });

  test('the lock lasts as long as the run can (re-runs and timeout counted), so it is not taken from a run that is still working', async () => {
    const w = world();
    let seen = null;
    w.hook = async (out) => { if (out === 'main') seen = w.ledger().listLocks().map((l) => [l.scope, l.ttlMs]).sort(); };
    await w.run({ ticket: 'T-1', reruns: 5, timeoutMs: 60 * MIN });
    assert.deepEqual(seen, [[`env:${ENV_URL}`, 7 * 60 * MIN + 10 * MIN], ['ticket:T-1', 7 * 60 * MIN + 10 * MIN]]);
    const w2 = world({ budget: { maxWallClockMs: 10 * MIN } });
    w2.hook = async (out) => { if (out === 'main') seen = w2.ledger().listLocks().map((l) => l.ttlMs); };
    await w2.run({ reruns: 2 });
    assert.deepEqual(seen, [10 * MIN + 30 * MIN + 10 * MIN], 'with a wall-clock limit: one step past it');
  });

  test('a lock that cannot be taken at all part-way (a credential-looking ticket handed in by a library caller) is a warning, and the lock taken before it is not left behind', async () => {
    const w = world();
    const r = await w.run({ ticket: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' });
    assert.equal(r.code, 0);
    assert.ok(r.doc.data.warnings.some((m) => /could not take the run locks/.test(m)), JSON.stringify(r.doc.data.warnings));
    assert.deepEqual(w.ledger().listLocks(), [], 'the environment lock was given back');
  });

  test('an environment URL the lock cannot use (no scheme) is a warning, and the run goes ahead without an environment lock', async () => {
    const w = world({ environments: { testEnvironmentBaseUrl: 'staging.example.com' } });
    const r = await w.run({ ticket: 'T-1' });
    assert.equal(r.code, 0);
    assert.ok(r.doc.data.warnings.some((m) => /environments\.testEnvironmentBaseUrl is not an http\(s\) URL, so this run takes no environment lock/.test(m)), JSON.stringify(r.doc.data.warnings));
  });

  test('the usage line names the slice 4 flags', async () => {
    let err = '';
    await main({ argv: ['--help'], env: {}, stdout: { write: () => {} }, stderr: { write: (t) => { err += t; } } });
    for (const f of ['--ticket', '--max-wall-clock-ms', '--cooldown-minutes']) assert.ok(err.includes(f), f);
  });
});
