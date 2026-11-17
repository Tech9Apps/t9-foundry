'use strict';

// Slice 4: the budget settings, the run locks (which scopes, all or none, and letting go however the run ends), the cooldown's view of the ledger, and the two
// commands a launcher uses: `ledger budget-check` (may a run start, with which limits) and `ledger budget-record` (what it spent).

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { budgetConfig, validate, tighter, longer, okValue, DEFAULTS, LIMITS, KNOWN } = require('../../scripts/ledger/lib/budget');
const { normalizeEnvUrl, scopesFor, configEnvUrl, acquireAll, guardSignals } = require('../../scripts/ledger/lib/locks');
const { lastRunEnd } = require('../../scripts/ledger/lib/views');
const { openLedger } = require('../../scripts/ledger/lib/ledger');
const { main: cliMain } = require('../../scripts/ledger/cli');
const schema = require('../../qa-config.schema.json');

const T0 = Date.parse('2026-11-13T10:00:00Z');
const MIN = 60 * 1000;
let work;
let dir;
let clock;
beforeEach(() => { work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-budget-')); dir = path.join(work, 'ledger'); clock = T0; });
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));
const open = (extra = {}) => openLedger({ dir, now: () => clock, ...extra });
const cfg = (obj) => { const f = path.join(work, 'qa-config.json'); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

describe('the budget block of qa-config.json', () => {
  test('nothing configured means no limits, and says nothing was explicit', () => {
    const b = budgetConfig({ configPath: cfg({}), env: {} });
    assert.deepEqual([b.maxWallClockMs, b.maxTurns, b.maxCostUsd, b.cooldownMinutes, b.present], [0, 0, 0, 0, false]);
    assert.deepEqual(b.explicit, { maxWallClockMs: false, maxTurns: false, maxCostUsd: false, cooldownMinutes: false });
  });

  test('configured values are used and marked explicit', () => {
    const b = budgetConfig({ configPath: cfg({ budget: { maxWallClockMs: 600000, maxTurns: 40, maxCostUsd: 2.5, cooldownMinutes: 30 } }), env: {} });
    assert.deepEqual([b.maxWallClockMs, b.maxTurns, b.maxCostUsd, b.cooldownMinutes, b.present], [600000, 40, 2.5, 30, true]);
    assert.ok(Object.values(b.explicit).every(Boolean));
  });

  test('a bad value, an unknown key or a block that is not an object is a usage error that names the key', () => {
    const bad = [[{ maxWallClockMs: -1 }, /budget\.maxWallClockMs/], [{ maxWallClockMs: 1.5 }, /budget\.maxWallClockMs/], [{ maxTurns: 'x' }, /budget\.maxTurns/], [{ maxCostUsd: -0.01 }, /budget\.maxCostUsd/], [{ maxCostUsd: Infinity }, /budget\.maxCostUsd/],
      [{ cooldownMinutes: 10081 }, /budget\.cooldownMinutes/], [{ colour: 1 }, /unknown key "budget\.colour"/], [null, /"budget" must be an object/], [[], /"budget" must be an object/], ['x', /"budget" must be an object/]];
    for (const [block, re] of bad) assert.throws(() => budgetConfig({ configPath: cfg({ budget: block }), env: {} }), (e) => e.isUsage && re.test(e.message), JSON.stringify(block));
  });

  test('a config that cannot be read is "no budget block": the other loaders report it, as they always did', () => {
    for (const body of ['{ not json', '', '[]', 'null']) assert.equal(budgetConfig({ configPath: cfg(body), env: {} }).present, false, JSON.stringify(body));
  });

  test('the loader and qa-config.schema.json agree on the keys, the bounds and the defaults', () => {
    const props = schema.properties.budget.properties;
    assert.equal(schema.properties.budget.additionalProperties, false);
    assert.deepEqual(Object.keys(props).sort(), [...KNOWN].sort());
    for (const k of KNOWN) {
      assert.deepEqual([props[k].minimum, props[k].maximum], LIMITS[k], k);
      assert.equal(props[k].default, DEFAULTS[k], k);
      assert.equal(props[k].type, k === 'maxCostUsd' ? 'number' : 'integer', k);
    }
  });

  test('everything the loader accepts the schema accepts, and the reverse', () => {
    const Ajv = require('../node_modules/ajv');
    const ok = new Ajv({ allErrors: true, strict: false }).compile(schema);
    const base = require('../../qa-config.example.json');
    for (const [block, good] of [[{}, true], [{ maxWallClockMs: 0 }, true], [{ maxWallClockMs: 604800000 }, true], [{ maxWallClockMs: 604800001 }, false], [{ maxTurns: 10000 }, true], [{ maxTurns: 10001 }, false], [{ maxCostUsd: 0.5 }, true],
      [{ maxCostUsd: 100001 }, false], [{ cooldownMinutes: 10080 }, true], [{ cooldownMinutes: 1.5 }, false], [{ maxTurns: -1 }, false], [{ extra: 1 }, false]]) {
      let loaderOk = true;
      try { validate(block, 'x'); } catch { loaderOk = false; }
      assert.equal(ok({ ...base, budget: block }), good, `schema: ${JSON.stringify(block)}`);
      assert.equal(loaderOk, good, `loader: ${JSON.stringify(block)}`);
    }
  });

  test('a flag may TIGHTEN a limit and never lift it: any limit is tighter than none, the smaller wins, and a longer cooldown wins', () => {
    assert.equal(tighter(0, 0), 0);
    assert.equal(tighter(0, 5000), 5000, 'the project set no limit: the flag may set one');
    assert.equal(tighter(5000, 0), 5000, 'the flag cannot switch the project\'s limit off');
    assert.equal(tighter(5000, 9000), 5000, 'nor loosen it');
    assert.equal(tighter(5000, 2000), 2000, 'but it may tighten it');
    assert.equal(longer(30, 0), 30);
    assert.equal(longer(30, 10), 30, 'a shorter cooldown cannot be asked for');
    assert.equal(longer(30, 90), 90);
    assert.equal(longer(0, 15), 15);
    assert.deepEqual([okValue('maxTurns', 3), okValue('maxTurns', 3.5), okValue('maxCostUsd', 3.5), okValue('maxWallClockMs', NaN)], [true, false, true, false]);
  });
});

describe('run locks: which scopes, all or none', () => {
  test('the same environment however it was typed: scheme, host and port are normalized, the query and fragment dropped, the path kept without its slash', () => {
    const same = ['https://staging.example.com', 'HTTPS://Staging.Example.COM/', 'https://staging.example.com:443', 'https://staging.example.com/?x=1#top'];
    for (const u of same) assert.equal(normalizeEnvUrl(u), 'https://staging.example.com', u);
    assert.equal(normalizeEnvUrl('https://staging.example.com/app/'), 'https://staging.example.com/app');
    assert.equal(normalizeEnvUrl('https://staging.example.com/App'), 'https://staging.example.com/app', 'the path is folded too: two spellings of one environment must not each get a lock');
    assert.equal(normalizeEnvUrl('https://staging.example.com/a/b///'), 'https://staging.example.com/a/b');
    assert.equal(normalizeEnvUrl('http://localhost:3000'), 'http://localhost:3000');
    assert.notEqual(normalizeEnvUrl('https://staging.example.com/a'), normalizeEnvUrl('https://staging.example.com/b'));
    for (const bad of ['', 'not a url', 'ftp://x.example.com', undefined, null, 5]) assert.equal(normalizeEnvUrl(bad), null, String(bad));
  });

  test('a run takes the environment and the ticket, in a fixed order, and only what it has', () => {
    assert.deepEqual(scopesFor({ envUrl: 'https://Staging.example.com/', ticket: 'DEMO-7' }), ['env:https://staging.example.com', 'ticket:DEMO-7']);
    assert.deepEqual(scopesFor({ ticket: 'DEMO-7' }), ['ticket:DEMO-7']);
    assert.deepEqual(scopesFor({ envUrl: 'https://s.example.com' }), ['env:https://s.example.com']);
    assert.deepEqual(scopesFor({ envUrl: 'nonsense' }), []);
    assert.deepEqual(scopesFor({}), []);
    assert.deepEqual(scopesFor({ envUrl: 'https://z.example.com', ticket: 'A-1' }), scopesFor({ ticket: 'A-1', envUrl: 'https://z.example.com' }), 'whichever way the caller names them');
  });

  test('testEnvironmentBaseUrl comes from the config; no config, an unreadable one, or none named is undefined', () => {
    assert.equal(configEnvUrl({ configPath: cfg({ testEnvironmentBaseUrl: 'https://s.example.com' }), env: {} }), 'https://s.example.com');
    for (const body of [{}, { testEnvironmentBaseUrl: 5 }, '{ not json', '[]', 'null']) assert.equal(configEnvUrl({ configPath: cfg(body), env: {} }), undefined, JSON.stringify(body));
    assert.equal(configEnvUrl({ configPath: path.join(work, 'absent.json'), env: {} }), undefined);
  });

  test('all the scopes or none: when a later one is held, the earlier ones are given back, and the holder is named', () => {
    const l = open();
    const holder = open({ pid: process.ppid }).acquireLock('ticket:T-1', { runId: 'other-run' });
    assert.equal(holder.acquired, true);
    const r = acquireAll(l, ['env:https://s.example.com', 'ticket:T-1'], { runId: 'mine' });
    assert.equal(r.ok, false);
    assert.equal(r.scope, 'ticket:T-1');
    assert.equal(r.holder.runId, 'other-run');
    assert.equal(l.acquireLock('env:https://s.example.com', { runId: 'someone' }).acquired, true, 'the environment lock this run took first was given back');
  });

  test('taking everything works, release gives everything back, and a stale lock it had to take over is reported', () => {
    const l = open();
    const dead = open({ pid: deadPid() });
    dead.acquireLock('env:https://s.example.com', { runId: 'died' });
    const r = acquireAll(l, ['env:https://s.example.com', 'ticket:T-2'], { runId: 'mine' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.stole, ['env:https://s.example.com']);
    assert.equal(open({ pid: process.ppid }).acquireLock('ticket:T-2', { runId: 'x' }).acquired, false, 'held while the run goes on');
    r.release();
    assert.equal(open({ pid: process.ppid }).acquireLock('ticket:T-2', { runId: 'x' }).acquired, true);
    r.release(); // releasing twice is harmless
  });

  test('a TTL given to acquireAll is the lock\'s TTL', () => {
    const l = open();
    acquireAll(l, ['ticket:T-3'], { runId: 'r', ttlMs: 1000 });
    assert.equal(l.listLocks()[0].ttlMs, 1000);
  });
});

describe('letting go when the process is told to stop', () => {
  const fakeProc = () => { const p = new EventEmitter(); p.pid = 4242; p.kills = []; p.kill = (pid, sig) => { p.kills.push([pid, sig]); }; return p; };

  test('on SIGINT, SIGTERM and SIGHUP: the work is stopped FIRST, then the locks are given back, then the signal is sent again (never an exit)', () => {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const p = fakeProc();
      const order = [];
      guardSignals({ release: () => order.push('release'), stopWork: () => order.push('stop'), proc: p });
      p.emit(sig);
      assert.deepEqual(order, ['stop', 'release'], `${sig}: a runner left going would keep hitting the environment after its lock was given up`);
      assert.deepEqual(p.kills, [[4242, sig]], `${sig}: sent again so the process ends the way it would have`);
      assert.equal(p.listenerCount(sig), 0, 'and this handler is gone, so the second delivery is not handled by it');
    }
  });

  test('a handler added AFTER this one (self-heal\'s revert) still runs on the same signal: this one does not exit or swallow it', () => {
    const p = fakeProc();
    const seen = [];
    guardSignals({ release: () => seen.push('release'), proc: p });
    p.on('SIGTERM', () => seen.push('the later handler'));
    p.emit('SIGTERM');
    assert.deepEqual(seen, ['release', 'the later handler']);
  });

  test('a throwing release or stopWork cannot stop the signal from being passed on', () => {
    const p = fakeProc();
    guardSignals({ release: () => { throw new Error('disk gone'); }, stopWork: () => { throw new Error('nothing running'); }, proc: p });
    assert.doesNotThrow(() => p.emit('SIGTERM'));
    assert.deepEqual(p.kills, [[4242, 'SIGTERM']]);
  });

  test('the returned function removes the handlers when the run ends normally', () => {
    const p = fakeProc();
    const disarm = guardSignals({ release: () => {}, proc: p });
    assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => p.listenerCount(s)), [1, 1, 1]);
    disarm();
    assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => p.listenerCount(s)), [0, 0, 0]);
    p.emit('SIGTERM');
    assert.deepEqual(p.kills, []);
  });
});

describe('the cooldown reads the ledger', () => {
  const run = (l, id, ticket, { end = true, at = 0, exit = 0, complete = true } = {}) => {
    clock = T0 + at;
    l.record(id, 'run.start', { pid: 1, host: 'h', ...(ticket ? { ticket } : {}) });
    if (end) { clock += 5 * MIN; l.record(id, 'run.end', { exit, complete }); }
  };

  test('the most recent run.end for that ticket, whatever its outcome; other tickets and runs without one do not count', () => {
    const l = open();
    run(l, 'a', 'T-1', { at: 0 });
    run(l, 'b', 'T-1', { at: 60 * MIN, exit: 3, complete: false });
    run(l, 'c', 'T-2', { at: 120 * MIN });
    run(l, 'd', 'T-1', { at: 180 * MIN, end: false }); // died: no run.end
    run(l, 'e', null, { at: 240 * MIN });
    const last = lastRunEnd(open(), { ticket: 'T-1' });
    assert.deepEqual([last.runId, last.exit, last.complete], ['b', 3, false]);
    assert.equal(last.endedAt, '2026-11-13T11:05:00.000Z');
    assert.equal(lastRunEnd(open(), { ticket: 'T-3' }), null);
    assert.equal(lastRunEnd(openLedger({ dir: path.join(work, 'none') }), { ticket: 'T-1' }), null);
  });
});

describe('the ledger commands a launcher uses', () => {
  const stream = () => { const s = { text: '', write(t) { s.text += t; } }; return s; };
  const cli = (argv, env = {}) => { const stdout = stream(); const stderr = stream(); const code = cliMain({ argv: [...argv, '--dir', dir], env, stdout, stderr, now: () => clock }); return { code, json: stdout.text ? JSON.parse(stdout.text) : null, stderr: stderr.text }; };

  test('budget-check: nothing stands in the way, and the limits to pass on are returned', () => {
    const c = cfg({ budget: { maxWallClockMs: 900000, maxTurns: 40, maxCostUsd: 1.5, cooldownMinutes: 30 }, testEnvironmentBaseUrl: 'https://s.example.com' });
    const r = cli(['budget-check', '--config', c, '--ticket', 'T-1']);
    assert.equal(r.code, 0);
    assert.deepEqual([r.json.data.ok, r.json.data.reasons], [true, []]);
    assert.deepEqual(r.json.data.limits, { maxWallClockMs: 900000, maxTurns: 40, maxCostUsd: 1.5 });
    assert.equal(r.json.data.cooldownMinutes, 30);
    assert.deepEqual(r.json.data.scopes, ['env:https://s.example.com', 'ticket:T-1']);
  });

  test('budget-check: a ticket inside its cooldown is refused (exit 4), with who and when', () => {
    const l = open();
    l.record('prev', 'run.start', { pid: 1, host: 'h', ticket: 'T-1' });
    clock = T0 + 10 * MIN;
    l.record('prev', 'run.end', { exit: 0, complete: true });
    clock = T0 + 25 * MIN;
    const c = cfg({ budget: { cooldownMinutes: 30 } });
    const r = cli(['budget-check', '--config', c, '--ticket', 'T-1']);
    assert.equal(r.code, 4);
    assert.equal(r.json.data.ok, false);
    assert.equal(r.json.data.reasons[0].code, 'COOLDOWN');
    assert.match(r.json.data.reasons[0].message, /ticket T-1 was last run by prev, which ended 15 minute\(s\) ago; the cooldown is 30 minute\(s\)/);
    assert.equal(cli(['budget-check', '--config', c, '--ticket', 'T-2']).code, 0, 'another ticket is free');
    clock = T0 + 41 * MIN;
    assert.equal(cli(['budget-check', '--config', c, '--ticket', 'T-1']).code, 0, 'and the cooldown ends');
  });

  test('budget-check: a held lock is a reason; a stale one is not; taking nothing, it never changes a lock', () => {
    const c = cfg({ testEnvironmentBaseUrl: 'https://s.example.com' });
    const holder = open({ pid: process.ppid });
    holder.acquireLock('env:https://s.example.com', { runId: 'busy-run' });
    const r = cli(['budget-check', '--config', c]);
    assert.equal(r.code, 4);
    assert.deepEqual([r.json.data.reasons[0].code, r.json.data.reasons[0].scope, r.json.data.reasons[0].runId], ['LOCKED', 'env:https://s.example.com', 'busy-run']);
    const before = fs.readdirSync(path.join(dir, 'locks'));
    cli(['budget-check', '--config', c]);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'locks')), before);
    fs.rmSync(dir, { recursive: true, force: true });
    open({ pid: deadPid() }).acquireLock('env:https://s.example.com', { runId: 'died' });
    assert.equal(cli(['budget-check', '--config', c]).code, 0, 'a lock whose owner is gone does not stop anyone');
    assert.equal(open().listLocks().length, 1, 'and checking did not steal it');
  });

  test('budget-check: --env-url names an environment when the config does not; a ticket with no cooldown configured is never held', () => {
    open({ pid: process.ppid }).acquireLock('env:https://other.example.com', { runId: 'r' });
    assert.equal(cli(['budget-check', '--config', cfg({}), '--env-url', 'https://Other.example.com/']).code, 4);
    assert.equal(cli(['budget-check', '--config', cfg({}), '--ticket', 'T-9']).code, 0);
  });

  test('budget-check on a ledger that does not exist is fine, and creates nothing', () => {
    const r = cli(['budget-check', '--config', cfg({})]);
    assert.equal(r.code, 0);
    assert.equal(fs.existsSync(dir), false);
  });

  test('budget-record writes what the launcher measured to the run\'s record, validated, and refuses an empty or negative report', () => {
    const r = cli(['budget-record', '--run-id', 'run-1', '--turns', '31', '--cost-usd', '0.84', '--wall-clock-ms', '412000']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.json.data.type, r.json.data.turns, r.json.data.costUsd, r.json.data.wallClockMs], ['budget', 31, 0.84, 412000]);
    assert.deepEqual(open().readRun('run-1').events.map((e) => [e.type, e.turns, e.costUsd]), [['budget', 31, 0.84]]);
    assert.equal(cli(['budget-record', '--run-id', 'run-1']).code, 2);
    assert.equal(cli(['budget-record', '--turns', '3']).code, 2, 'a run id is required');
    for (const bad of [['--turns', '-1'], ['--turns', '1.5'], ['--cost-usd', '-0.1'], ['--cost-usd', 'x'], ['--wall-clock-ms', '-5']]) assert.equal(cli(['budget-record', '--run-id', 'r', ...bad]).code, 2, bad.join(' '));
  });
});
