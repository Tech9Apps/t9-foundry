'use strict';

// Slice 4 in post-tests.js: one run at a time per ticket (with a ledger), given back however the run ends, including a real signal.

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { openLedger } = require('../../scripts/ledger/lib/ledger');
const { workspace: makeWorkspace } = require('./workspace');
const { fileBackedGithub } = require('./fixtures/file-backed-mock');
const { assertValid } = require('./helpers');
const { cleanEnv } = require('../helpers/node-env');

const CASES_MD = path.join(__dirname, '..', '..', 'demo', 'expected', 'DEMO-101-test-cases.md');
const N = 10;
const workspace = () => makeWorkspace('github', { casesFile: CASES_MD });
const ledgerOf = (w) => path.join(w.dir, 'ledger');
const withLedger = (w, extra = []) => ['--ledger-dir', ledgerOf(w), '--run-id', 'run-a', ...extra];
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const holder = (w, scope, runId = 'busy-run') => openLedger({ dir: ledgerOf(w), pid: process.ppid }).acquireLock(scope, { runId });

describe('post-tests: one run at a time per ticket', () => {
  test('a ticket another run is posting is REFUSED (exit 4, IN_PROGRESS, retriable) before anything reaches the tracker, naming the run; its lock is untouched', async () => {
    const w = workspace();
    holder(w, `ticket:${w.parent}`);
    const r = await w.post(withLedger(w));
    assert.equal(r.code, 4);
    assert.deepEqual([r.json.ok, r.json.error.code, r.json.error.retriable], [false, 'IN_PROGRESS', true]);
    assert.match(r.json.error.message, new RegExp(`the test cases of ${w.parent} are being posted by run busy-run since .* \\(ticket:${w.parent}\\); nothing was posted`));
    assert.deepEqual([r.json.error.details.scope, r.json.error.details.runId, r.json.error.details.pid], [`ticket:${w.parent}`, 'busy-run', process.ppid]);
    assertValid('tracker-error', r.json.error);
    assert.equal(w.mock.calls.length, 0, 'not a request, not even the parent fetch');
    assert.equal(fs.existsSync(w.keysFile), false, 'and no keys file');
    assert.deepEqual(openLedger({ dir: ledgerOf(w) }).listLocks().map((l) => l.runId), ['busy-run']);
  });

  test('another ticket is independent, and a --dry-run needs no lock (it reads and writes nothing)', async () => {
    const w = workspace();
    holder(w, 'ticket:SOMETHING-ELSE');
    assert.equal((await w.post(withLedger(w))).code, 0);
    const locked = workspace();
    holder(locked, `ticket:${locked.parent}`);
    const dry = await locked.post(withLedger(locked, ['--dry-run']));
    assert.equal(dry.code, 0);
    assert.equal(dry.json.dryRun, true);
  });

  test('the lock is held while the cases are posted and given back after: a good run, one with failures, and one stopped by a systemic failure', async () => {
    const w = workspace();
    const during = [];
    const realFetch = w.mock.fetch;
    w.mock.fetch = async (...a) => { during.push(openLedger({ dir: ledgerOf(w), pid: process.ppid }).acquireLock(`ticket:${w.parent}`, { runId: 'probe' }).acquired); return realFetch(...a); };
    // post() hands the mock's fetch to the command: swap it so every request probes the lock
    const { main } = require('../../scripts/tracker/post-tests');
    let out = '';
    const code = await main({ argv: ['--parent', w.parent, '--cases', w.cases, '--keys-file', w.keysFile, '--config', w.config, '--base-url', w.mock.baseUrl, ...withLedger(w)], env: { [w.mock.tokenEnv]: w.mock.token }, fetch: w.mock.fetch, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    assert.equal(code, 0, out);
    assert.ok(during.length > 0 && during.every((got) => got === false), 'at every request the ticket was locked');
    assert.deepEqual(openLedger({ dir: ledgerOf(w) }).listLocks(), []);
    const failing = workspace();
    failing.mock.inject({ method: 'POST', match: failing.mock.paths.create, status: 500 });
    assert.equal((await failing.post(withLedger(failing))).code, 1);
    assert.deepEqual(openLedger({ dir: ledgerOf(failing) }).listLocks(), []);
    const revoked = workspace();
    revoked.mock.inject({ method: 'POST', match: revoked.mock.paths.create, status: 401, times: 20 });
    assert.equal((await revoked.post(withLedger(revoked))).code, 1);
    assert.deepEqual(openLedger({ dir: ledgerOf(revoked) }).listLocks(), []);
  });

  test('a lock whose owner is gone is taken over and the run goes ahead; the steal is in the audit log', async () => {
    const w = workspace();
    openLedger({ dir: ledgerOf(w), pid: deadPid() }).acquireLock(`ticket:${w.parent}`, { runId: 'died' });
    const r = await w.post(withLedger(w));
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(openLedger({ dir: ledgerOf(w) }).readAudit().events.filter((e) => e.type === 'lock.stolen').map((e) => e.previousRunId), ['died']);
    assert.deepEqual(openLedger({ dir: ledgerOf(w) }).listLocks(), []);
  });

  test('without a ledger there is no lock: the run is exactly what it was, and no ledger folder appears', async () => {
    const w = workspace();
    const r = await w.post();
    assert.equal(r.code, 0);
    assert.equal(r.json.warnings, undefined);
    assert.equal(fs.existsSync(ledgerOf(w)), false);
  });

  test('a ledger that cannot take the lock is a warning and the run goes ahead (the adapter\'s marker still prevents duplicates)', async () => {
    const w = workspace();
    fs.mkdirSync(ledgerOf(w), { recursive: true });
    fs.writeFileSync(path.join(ledgerOf(w), 'VERSION'), '9\n');
    const r = await w.post(withLedger(w));
    assert.equal(r.code, 0, r.out);
    assert.ok(r.json.warnings.some((m) => /could not take the ticket lock/.test(m) && /not protected from a concurrent one/.test(m)));
    assert.equal(r.json.created, N);
  });

  test('the run id on the lock is --run-id, or one made from the process when none is given', async () => {
    const w = workspace();
    let seen;
    const { main } = require('../../scripts/tracker/post-tests');
    const realFetch = w.mock.fetch;
    w.mock.fetch = async (...a) => { seen = seen || openLedger({ dir: ledgerOf(w) }).listLocks()[0]; return realFetch(...a); };
    await main({ argv: ['--parent', w.parent, '--cases', w.cases, '--keys-file', w.keysFile, '--config', w.config, '--base-url', w.mock.baseUrl, '--ledger-dir', ledgerOf(w), '--only', 'TC-001'], env: { [w.mock.tokenEnv]: w.mock.token }, fetch: w.mock.fetch, stdout: { write: () => {} }, stderr: { write: () => {} } });
    assert.equal(seen.runId, `post-tests-${process.pid}`);
  });
});

describe('a REAL SIGTERM to a post-tests run that is hanging mid-batch', () => {
  test('the ticket lock is given back, the run ends by the signal, and the next run resumes: ten cases, each exactly once', { skip: process.platform === 'win32', timeout: 90000 }, async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-post-sig-'));
    after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateFile = path.join(root, 'tracker.json');
    const mock = fileBackedGithub(stateFile);
    const parent = mock.seedTicket({ title: 'DEMO-101: Apply a discount code', description: 'story', acceptance: '1. a' });
    mock.save();
    const ledger = path.join(root, 'ledger');
    const config = path.join(root, 'qa-config.json');
    fs.writeFileSync(config, JSON.stringify({ ticketSource: { type: 'github', github: mock.settings }, ledger: { dir: ledger } }));
    fs.copyFileSync(CASES_MD, path.join(root, 'DEMO-101.md'));
    const args = ['--parent', parent, '--cases', path.join(root, 'DEMO-101.md'), '--keys-file', path.join(root, 'keys.json'), '--config', config, '--run-id', 'sig-run'];
    const ready = path.join(root, 'ready');
    const hang = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'post-and-hang.js'), stateFile, '3', ready, ...args], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise((resolve) => hang.on('exit', (code, signal) => resolve({ code, signal })));
    const end = Date.now() + 30000;
    while (!fs.existsSync(ready) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    assert.equal(fs.existsSync(ready), true, 'the run reached its third create and is hanging');
    assert.deepEqual(openLedger({ dir: ledger }).listLocks().map((l) => l.scope), [`ticket:${parent}`], 'the ticket is locked while it hangs');
    hang.kill('SIGTERM');
    const { code, signal } = await exited;
    assert.deepEqual([code, signal], [null, 'SIGTERM']);
    assert.deepEqual(openLedger({ dir: ledger }).listLocks(), [], 'the lock was given back');

    const done = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'post-and-die.js'), stateFile, '0', ...args], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    done.stdout.on('data', (d) => { out += d; });
    const finished = await new Promise((resolve) => done.on('exit', resolve));
    assert.equal(finished, 0, out);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const keys = state.created.map((n) => state.issues.find(([k]) => Number(k) === n)[1].body.match(/qa-harness-key:(\S+)/)[1]);
    assert.equal(keys.length, N);
    assert.equal(new Set(keys).size, N, 'every case exactly once');
    assert.deepEqual(openLedger({ dir: ledger }).listLocks(), []);
  });
});
