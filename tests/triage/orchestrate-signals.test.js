'use strict';

// Real processes, real signals. A run that is told to stop must stop its test runner BEFORE giving up the locks that protect the environment (a runner left going
// would keep hitting it), must give the locks back, and must not get in the way of self-heal restoring the repository on the same signal. A run that is killed
// without a chance to do any of that leaves locks behind, and the next run takes them over.

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { openLedger } = require('../../scripts/ledger/lib/ledger');
const { orchestrate } = require('../../scripts/triage/orchestrate');
const { makeProject, baseEnv, git, UI_TEST } = require('../helpers/heal-project');
const { cleanEnv } = require('../helpers/node-env');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'triage', 'orchestrate.js');
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-orch-sig-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const until = async (what, ok, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (ok()) return; await new Promise((r) => setTimeout(r, 25)); } assert.fail(`timed out waiting for ${what}`); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function spawnRun(argv, env) {
  const child = spawn(process.execPath, [SCRIPT, ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const seen = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { seen.stdout += d; });
  child.stderr.on('data', (d) => { seen.stderr += d; });
  seen.exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, seen };
}

describe('a real SIGTERM to a running orchestrator', () => {
  test('the runner is stopped, the locks are given back, the run ends by the signal (exit 143 or the signal itself), and the ledger shows a run that never ended', { skip: process.platform === 'win32', timeout: 90000 }, async () => {
    const root = tmp();
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj);
    const sentinel = path.join(root, 'runner-pid');
    fs.writeFileSync(path.join(proj, 'slow.test.js'), `const test = require('node:test');\ntest('slow', async () => { require('fs').writeFileSync(${JSON.stringify(sentinel)}, String(process.pid)); await new Promise((r) => setTimeout(r, 60000)); });\n`);
    const ledger = path.join(root, 'ledger');
    const config = path.join(root, 'qa-config.json');
    fs.writeFileSync(config, JSON.stringify({ ledger: { dir: ledger }, testEnvironmentBaseUrl: 'https://staging.example.com' }));
    const { child, seen } = spawnRun(['--framework', 'node', '--cwd', proj, '--spec', 'slow.test.js', '--out', path.join(root, 'out'), '--run-id', 'sig1', '--no-plan', '--preflight', 'ok', '--ticket', 'T-1', '--config', config], cleanEnv());
    await until('the runner to start', () => fs.existsSync(sentinel));
    const runnerPid = Number(fs.readFileSync(sentinel, 'utf8'));
    assert.ok(alive(runnerPid), 'the test runner is going');
    assert.deepEqual(openLedger({ dir: ledger }).listLocks().map((l) => l.scope).sort(), ['env:https://staging.example.com', 'ticket:T-1'], 'both locks are held while it runs');
    child.kill('SIGTERM');
    const { code, signal } = await seen.exited;
    // While a test run is in flight the runner module has its own SIGTERM handler, which exits 128 + the signal; between steps nothing else handles it and the
    // re-sent signal ends the process. Either way the run ENDED by the signal: that is what matters, and it is what it would have done without the guard.
    assert.ok((code === 143 && signal === null) || (code === null && signal === 'SIGTERM'), `it ended by the signal (code ${code}, signal ${signal}; stderr: ${seen.stderr})`);
    assert.deepEqual(openLedger({ dir: ledger }).listLocks(), [], 'the locks were given back');
    await until('the runner to be gone', () => !alive(runnerPid), 5000);
    const r = openLedger({ dir: ledger }).readRun('sig1');
    assert.deepEqual([r.events.map((e) => e.type), r.finished], [['run.start'], false]);
    assert.equal(r.events[0].ticket, 'T-1');
  });

  test('a test runner that IGNORES SIGTERM is killed anyway before the locks are given back: a runner left going would keep hitting the environment', { skip: process.platform === 'win32', timeout: 90000 }, async () => {
    const root = tmp();
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj);
    const sentinel = path.join(root, 'runner-pid');
    fs.writeFileSync(path.join(proj, 'stubborn.test.js'), `const test = require('node:test');\nprocess.on('SIGTERM', () => {});\ntest('stubborn', async () => { require('fs').writeFileSync(${JSON.stringify(sentinel)}, String(process.pid)); await new Promise((r) => setTimeout(r, 60000)); });\n`);
    const ledger = path.join(root, 'ledger');
    const config = path.join(root, 'qa-config.json');
    fs.writeFileSync(config, JSON.stringify({ ledger: { dir: ledger }, testEnvironmentBaseUrl: 'https://staging.example.com' }));
    const { child, seen } = spawnRun(['--framework', 'node', '--cwd', proj, '--spec', 'stubborn.test.js', '--out', path.join(root, 'out'), '--run-id', 'stubborn', '--no-plan', '--preflight', 'ok', '--config', config], cleanEnv());
    await until('the runner to start', () => fs.existsSync(sentinel));
    const runnerPid = Number(fs.readFileSync(sentinel, 'utf8'));
    child.kill('SIGTERM');
    await seen.exited;
    await until('the stubborn runner to be gone', () => !alive(runnerPid), 5000);
    assert.deepEqual(openLedger({ dir: ledger }).listLocks(), []);
  });

  test('a run that is KILLED (no chance to clean up) leaves its locks, and the next run takes them over and says so', { skip: process.platform === 'win32', timeout: 90000 }, async () => {
    const root = tmp();
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj);
    const sentinel = path.join(root, 'started');
    fs.writeFileSync(path.join(proj, 'slow.test.js'), `const test = require('node:test');\ntest('slow', async () => { require('fs').writeFileSync(${JSON.stringify(sentinel)}, '1'); await new Promise((r) => setTimeout(r, 60000)); });\n`);
    const ledger = path.join(root, 'ledger');
    const config = path.join(root, 'qa-config.json');
    fs.writeFileSync(config, JSON.stringify({ ledger: { dir: ledger }, testEnvironmentBaseUrl: 'https://staging.example.com' }));
    const { child, seen } = spawnRun(['--framework', 'node', '--cwd', proj, '--spec', 'slow.test.js', '--out', path.join(root, 'out'), '--run-id', 'killed', '--no-plan', '--preflight', 'ok', '--config', config], cleanEnv());
    await until('the runner to start', () => fs.existsSync(sentinel));
    child.kill('SIGKILL');
    await seen.exited;
    assert.equal(openLedger({ dir: ledger }).listLocks().length, 1, 'the dead run\'s lock is still there');
    assert.equal(openLedger({ dir: ledger }).listLocks()[0].stale, 'its owner process is gone', 'and is known to be abandoned');
    fs.writeFileSync(path.join(proj, 'slow.test.js'), "const test = require('node:test');\ntest('fast', () => {});\n");
    const next = await orchestrate({ specs: ['slow.test.js'], reruns: 2, out: path.join(root, 'out2'), config, noPlan: true, framework: 'node', cwd: proj, runId: 'next', preflight: 'ok' }, { env: cleanEnv() });
    assert.equal(next.code, 0, JSON.stringify(next.doc));
    assert.ok(next.doc.data.warnings.some((m) => /took over a stale run lock/.test(m)), JSON.stringify(next.doc.data.warnings));
    assert.deepEqual(openLedger({ dir: ledger }).listLocks(), []);
  });
});

describe('the wall-clock budget, with the real runner and a real repository', () => {
  const { defaultRunResults } = require('../../scripts/triage/lib/run-results');

  test('a run that is out of time just before self-heal does NOT heal: no branch, no edit, no heal record, exit 5 naming self-heal as skipped', { timeout: 120000 }, async () => {
    const p = makeProject();
    const before = { head: git(p.proj, 'rev-parse', 'HEAD'), branches: git(p.proj, 'branch', '--format=%(refname:short)'), status: git(p.proj, 'status', '--porcelain', '--untracked-files=no') };
    const ledger = path.join(p.root, 'ledger');
    const config = path.join(p.root, 'qa-config.json');
    fs.writeFileSync(config, JSON.stringify({ triage: { selfHeal: { enabled: true, paths: ['tests'] } }, ledger: { dir: ledger }, budget: { maxWallClockMs: 60000 } }));
    let clock = Date.now();
    // the real runner; the clock jumps an hour once the second re-run has finished, so the budget is spent exactly at the step before the heal
    const runResults = async (argv, env) => { const r = await defaultRunResults(argv, env); if (path.basename(argv[argv.indexOf('--out') + 1]) === 'rerun-2') clock += 3600 * 1000; return r; };
    const r = await orchestrate({ specs: ['tests/ui.test.js'], reruns: 2, out: path.join(p.proj, 'qa-results'), config, noPlan: true, framework: 'node', cwd: p.proj, runId: 'late', preflight: 'ok', snapshot: path.join(p.proj, 'app', 'index.html') }, { env: baseEnv(), now: () => clock, runResults });
    assert.equal(r.code, 5, JSON.stringify(r.doc.data && r.doc.data.budget));
    assert.deepEqual([r.doc.data.runs, r.doc.data.budget.before, r.doc.data.budget.skipped], [3, 'self-heal', ['self-heal']]);
    assert.equal(r.doc.data.heal, undefined);
    assert.deepEqual({ head: git(p.proj, 'rev-parse', 'HEAD'), branches: git(p.proj, 'branch', '--format=%(refname:short)'), status: git(p.proj, 'status', '--porcelain', '--untracked-files=no') }, before, 'the repository was not touched');
    assert.deepEqual(openLedger({ dir: ledger }).readRun('late').events.filter((e) => e.type.startsWith('heal.')), []);
    assert.equal(r.doc.data.verdicts.some((v) => v.rule === 'TST-1' && v.action === 'act'), true, 'the heal WAS possible: only the budget stopped it');
  });
});

describe('a SIGTERM while self-heal is validating: the lock guard must not stop the repository from being restored', () => {
  // slow only on the heal branch: the main run (on main) passes through it at once, so the run reaches the heal and is held there, validating
  const SLOW_ON_HEAL = (sentinel) => `${UI_TEST}\ntest('slow on the heal branch', async () => {\n  const head = require('fs').readFileSync(require('path').join(__dirname, '..', '.git', 'HEAD'), 'utf8');\n  if (!head.includes('qa/heal-')) return;\n  require('fs').writeFileSync(${JSON.stringify(sentinel)}, String(process.pid));\n  await new Promise((r) => setTimeout(r, 60000));\n});\n`;

  test('the repository is restored exactly as found, the heal says it was interrupted, the locks are gone, the runner is gone, and the process exits 143', { skip: process.platform === 'win32', timeout: 120000 }, async () => {
    const sentinel = path.join(tmp(), 'validating-pid');
    const p = makeProject({ files: { 'tests/ui.test.js': SLOW_ON_HEAL(sentinel) } });
    const before = { head: git(p.proj, 'rev-parse', 'HEAD'), branch: git(p.proj, 'branch', '--show-current'), branches: git(p.proj, 'branch', '--format=%(refname:short)'), status: git(p.proj, 'status', '--porcelain', '--untracked-files=no') };
    const original = fs.readFileSync(path.join(p.proj, 'tests', 'ui.test.js'));
    const ledger = path.join(p.root, 'ledger');
    const config = path.join(p.root, 'qa-config.json');
    fs.writeFileSync(config, JSON.stringify({ triage: { selfHeal: { enabled: true, paths: ['tests'] } }, ledger: { dir: ledger }, testEnvironmentBaseUrl: 'https://staging.example.com' }));
    const { child, seen } = spawnRun(['--framework', 'node', '--cwd', p.proj, '--spec', 'tests/ui.test.js', '--out', path.join(p.proj, 'qa-results'), '--preflight', 'ok', '--run-id', 'heal-sig', '--no-plan', '--ticket', 'T-1', '--config', config, '--snapshot', path.join(p.proj, 'app', 'index.html')], baseEnv());
    await until('the heal\'s validation run to start', () => fs.existsSync(sentinel), 60000);
    const runnerPid = Number(fs.readFileSync(sentinel, 'utf8'));
    assert.equal(git(p.proj, 'branch', '--show-current'), 'qa/heal-heal-sig', 'the repository is on the heal branch while it validates');
    assert.equal(openLedger({ dir: ledger }).listLocks().length, 2);
    child.kill('SIGTERM');
    const { code, signal } = await seen.exited;
    assert.deepEqual([code, signal], [143, null], `self-heal reverted and exited 128 + SIGTERM by itself (stderr: ${seen.stderr})`);
    assert.match(seen.stderr, /heal: interrupted by SIGTERM; the repository was restored exactly as found/);
    assert.deepEqual({ head: git(p.proj, 'rev-parse', 'HEAD'), branch: git(p.proj, 'branch', '--show-current'), branches: git(p.proj, 'branch', '--format=%(refname:short)'), status: git(p.proj, 'status', '--porcelain', '--untracked-files=no') }, before);
    assert.ok(fs.readFileSync(path.join(p.proj, 'tests', 'ui.test.js')).equals(original), 'the test file holds its original bytes');
    assert.deepEqual(openLedger({ dir: ledger }).listLocks(), [], 'the locks were given back');
    await until('the validating runner to be gone', () => !alive(runnerPid), 5000);
    const heals = openLedger({ dir: ledger }).readRun('heal-sig').events.filter((e) => e.type.startsWith('heal.')).map((e) => [e.type, e.outcome]);
    assert.deepEqual(heals, [['heal.begin', undefined], ['heal.end', 'interrupted']]);
  });
});
