'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { openLedger, validateRecord, parseEvents, stemOf, TYPES, MAX_RECORD_BYTES } = require('../../scripts/ledger/lib/ledger');

const LIB = path.join(__dirname, '..', '..', 'scripts', 'ledger', 'lib', 'ledger.js');
const T0 = Date.parse('2026-11-13T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

let dir;
let clock;
const open = (extra = {}) => openLedger({ dir, now: () => clock, ...extra });
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ledger-')); clock = T0; });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const START = { pid: 1, host: 'h' };
const runFile = (runId) => path.join(dir, 'runs', `${stemOf(runId)}.jsonl`);
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

// runs a snippet in a separate node process that has the ledger library loaded as `L` and the ledger directory as `dir`
function child(snippet, { keepAlive = false } = {}) {
  const src = `const L=require(${JSON.stringify(LIB)});const dir=${JSON.stringify(dir)};${snippet}${keepAlive ? ';setInterval(()=>{},1000)' : ''}`;
  const proc = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  const closed = new Promise((resolve) => proc.on('close', (c, s) => resolve({ code: c, signal: s, out, err })));
  const ready = new Promise((resolve) => { const t = setInterval(() => { if (out.includes('ready')) { clearInterval(t); resolve(); } }, 10); proc.on('close', () => { clearInterval(t); resolve(); }); });
  const printed = new Promise((resolve) => { const t = setInterval(() => { if (out.length) { clearInterval(t); resolve(); } }, 10); proc.on('close', () => { clearInterval(t); resolve(); }); });
  return { proc, closed, ready, printed, output: () => out };
}

describe('records', () => {
  test('a record is one line with the envelope, and reading it back gives the same thing', () => {
    const l = open();
    const rec = l.record('run-1', 'run.start', { framework: 'node', ...START });
    assert.deepEqual(Object.keys(rec).slice(0, 4), ['v', 'ts', 'runId', 'type']);
    assert.equal(rec.ts, '2026-11-13T10:00:00.000Z');
    const text = fs.readFileSync(runFile('run-1'), 'utf8');
    assert.equal(text.split('\n').length, 2, 'one line and the final newline');
    assert.deepEqual(open().readRun('run-1').events, [rec]);
  });

  test('a run is finished only when it has a run.end, whatever else is in the file', () => {
    const l = open();
    l.record('r', 'run.start', START);
    l.record('r', 'test.result', { spec: 'a.test.js', name: 'x', status: 'passed', phase: 'main' });
    assert.equal(l.readRun('r').finished, false);
    l.record('r', 'run.end', { exit: 0, complete: true });
    assert.equal(l.readRun('r').finished, true);
  });

  test('every type in the table can be written and read back', () => {
    const l = open();
    const sample = {
      'run.start': START, 'test.result': { spec: 's', name: 'n', status: 'failed', phase: 'rerun-1', durationMs: 5 }, verdict: { token: 'qafp0123456789ab', class: 'flaky', confidence: 0.9, action: 'act', step: 'report-flaky' },
      'action.claimed': { key: 'k', step: 'file-bug', target: 't' }, 'action.done': { key: 'k', id: '7', url: 'https://x', deduplicated: false }, 'action.failed': { key: 'k', code: 'HTTP_500', message: 'm' },
      'heal.begin': { branch: 'qa/heal-1', baseSha: 'abc' }, 'heal.end': { branch: 'qa/heal-1', outcome: 'kept' }, budget: { wallClockMs: 10, exceeded: 'wall clock' }, 'run.end': { exit: 1, complete: false, counts: { failed: 2 } },
      'lock.stolen': { scope: 'env:x', reason: 'it expired', previousRunId: 'old', previousPid: 9 },
    };
    assert.deepEqual(Object.keys(sample).sort(), Object.keys(TYPES).sort(), 'the sample covers every type');
    for (const [type, fields] of Object.entries(sample)) l.record('r', type, fields);
    assert.equal(l.readRun('r').events.length, Object.keys(TYPES).length);
    assert.deepEqual(l.readRun('r').warnings, []);
  });

  test('a record that does not fit its type is refused, and nothing is written', () => {
    const l = open();
    const bad = [
      ['nope', {}, 'unknown record type'],
      ['run.start', { pid: 1 }, '"host" is required'],
      ['run.start', { pid: 'one', host: 'h' }, '"pid" must be a number'],
      ['run.start', { ...START, extra: 1 }, 'unknown field "extra"'],
      ['run.start', { ...START, type: 'run.end' }, 'belongs to the record envelope'],
      ['run.start', { ...START, runId: 'other' }, 'belongs to the record envelope'],
      ['heal.end', { branch: 'b', outcome: 'maybe' }, 'must be one of'],
      ['verdict', { token: 't', class: 'c', confidence: NaN, action: 'a' }, '"confidence" must be a number'],
    ];
    for (const [type, fields, why] of bad) {
      let err;
      try { l.record('r', type, fields); } catch (e) { err = e; }
      assert.equal(err && err.code, 'LEDGER_INVALID', `${type} ${JSON.stringify(fields)}`);
      assert.match(err.message, new RegExp(why.replace(/[()"]/g, '\\$&')));
    }
    assert.equal(fs.existsSync(path.join(dir, 'runs', 'r.jsonl')), false);
    assert.equal(code(() => l.record('', 'run.start', START)), 'LEDGER_INVALID');
  });

  test('a secret in a field is masked before it reaches the file, in nested values too', () => {
    const l = open();
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    l.record('r', 'action.failed', { key: 'k', code: 'HTTP_401', message: `bad credentials ${token}` });
    l.record('r', 'run.start', { ...START, config: { nested: { header: `Authorization: ${token}`, list: [token] } } });
    const text = fs.readFileSync(runFile('r'), 'utf8');
    assert.equal(text.includes(token), false);
    assert.match(text, /<redacted>/);
  });

  test('a record that is too long is shrunk to fit one line, never dropped', () => {
    const l = open();
    const long = l.record('r', 'action.failed', { key: 'k', code: 'X', message: 'm'.repeat(50000) });
    assert.equal(long.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(long)) <= MAX_RECORD_BYTES);
    const bulky = l.record('r', 'run.start', { ...START, config: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, 'v'.repeat(150)])) });
    assert.equal(bulky.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(bulky)) <= MAX_RECORD_BYTES);
    assert.equal(l.readRun('r').events.length, 2, 'both survive the round trip through validation');
    assert.deepEqual(l.readRun('r').warnings, []);
  });

  test('files are private to the user: 0600 for files, 0700 for folders', { skip: process.platform === 'win32' }, () => {
    const l = open();
    l.record('r', 'run.start', START);
    l.claim('k', { runId: 'r' });
    const mode = (f) => fs.statSync(f).mode & 0o777;
    assert.equal(mode(runFile('r')), 0o600);
    assert.equal(mode(path.join(dir, 'runs')), 0o700);
    assert.equal(mode(path.join(dir, 'keys')), 0o700);
    assert.equal(mode(path.join(dir, 'VERSION')), 0o600);
    for (const f of fs.readdirSync(path.join(dir, 'keys'))) assert.equal(mode(path.join(dir, 'keys', f)), 0o600);
  });
});

describe('reading a damaged ledger never throws', () => {
  test('a torn final line (a write cut off) is skipped with a warning, the rest is used', () => {
    const l = open();
    l.record('r', 'run.start', START);
    fs.appendFileSync(runFile('r'), '{"v":1,"ts":"2026-11-13T10:00:01.000Z","runId":"r","type":"run.e');
    const r = l.readRun('r');
    assert.equal(r.events.length, 1);
    assert.match(r.warnings.join('\n'), /torn final line/);
    assert.equal(r.finished, false);
  });

  test('a bad line in the middle is skipped with a warning naming it', () => {
    const l = open();
    l.record('r', 'run.start', START);
    fs.appendFileSync(runFile('r'), 'this is not json\n');
    l.record('r', 'run.end', { exit: 0, complete: true });
    const r = l.readRun('r');
    assert.equal(r.events.length, 2);
    assert.match(r.warnings.join('\n'), /line 2 is not valid JSON/);
    assert.equal(r.finished, true);
  });

  test('a record of a type this version does not know (a newer writer) is skipped and counted, not an error', () => {
    const { events, warnings } = parseEvents('{"v":2,"ts":"2027-01-01T00:00:00.000Z","runId":"r","type":"future.thing","x":1}\n', 'run r');
    assert.deepEqual(events, []);
    assert.match(warnings[0], /1 record this version does not understand/);
  });

  test('a record with the right type but the wrong shape is skipped with the reason', () => {
    const { events, warnings } = parseEvents('{"v":1,"ts":"2026-11-13T10:00:00.000Z","runId":"r","type":"run.end","exit":"zero","complete":true}\n', 'run r');
    assert.deepEqual(events, []);
    assert.match(warnings[0], /"exit" must be a number/);
  });

  test('a newer VERSION: reads carry a warning, and every write refuses', () => {
    const l = open();
    l.record('r', 'run.start', START);
    fs.writeFileSync(path.join(dir, 'VERSION'), '2\n');
    const fresh = open();
    assert.match(fresh.readRun('r').warnings[0], /layout version "2"/);
    assert.equal(code(() => fresh.record('r', 'run.end', { exit: 0, complete: true })), 'LEDGER_VERSION');
    assert.equal(code(() => fresh.claim('k')), 'LEDGER_VERSION');
    assert.equal(code(() => fresh.acquireLock('s', { runId: 'r' })), 'LEDGER_VERSION');
    assert.equal(fs.readFileSync(runFile('r'), 'utf8').split('\n').length, 2, 'the file was not touched');
  });

  test('reading a ledger that does not exist is empty, and does not create it', () => {
    const missing = path.join(dir, 'nowhere');
    const l = openLedger({ dir: missing });
    assert.deepEqual(l.readRun('r').events, []);
    assert.deepEqual(l.listRuns(), []);
    assert.equal(l.status().runs.total, 0);
    assert.equal(fs.existsSync(missing), false);
  });
});

describe('names cannot leave the ledger or collide', () => {
  test('a hostile run id stays inside runs/', () => {
    const l = open();
    for (const id of ['../../etc/passwd', 'a/b', '..', '.', 'x\\y', 'C:\\temp', 'a'.repeat(128)]) {
      l.record(id, 'run.start', START);
      assert.ok(path.resolve(runFile(id)).startsWith(path.join(dir, 'runs') + path.sep), id);
      assert.equal(l.readRun(id).events.length, 1, id);
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), ['VERSION', 'keys', 'locks', 'runs']);
  });

  test('ids that fold together do not share a file, including on a case-insensitive disk', () => {
    const stems = ['a/b', 'a-b', 'Run', 'run', 'RUN', 'a.b', 'a_b'].map(stemOf);
    assert.equal(new Set(stems.map((s) => s.toLowerCase())).size, stems.length, stems.join(' '));
    const l = open();
    l.record('Run', 'run.start', START);
    l.record('run', 'run.start', START);
    assert.equal(l.readRun('Run').events.length, 1);
    assert.equal(l.readRun('run').events.length, 1);
  });

  test('a hostile key is hashed: it never becomes a path', () => {
    const l = open();
    assert.equal(l.claim('../../../tmp/evil', { runId: 'r' }).won, true);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'keys')).filter((n) => !/^[0-9a-f]{32}\.json$/.test(n)), []);
    for (const bad of ['', 'x'.repeat(201), 'a\nb', 'a\u0000b', 5, null]) assert.equal(code(() => l.claim(bad)), 'LEDGER_INVALID', JSON.stringify(bad));
  });
});

describe('idempotency keys', () => {
  test('the first claim wins; the second is told the key is in flight, and by whom', () => {
    const l = open();
    const a = l.claim('k', { runId: 'r1' });
    assert.equal(a.won, true);
    const b = l.claim('k', { runId: 'r2' });
    assert.equal(b.won, false);
    assert.equal(b.state, 'in-flight');
    assert.equal(b.claim.runId, 'r1');
    assert.equal(b.ownerAlive, true, 'this very process owns it');
  });

  test('complete records the result; every later claim sees done with that result', () => {
    const l = open();
    l.claim('k', { runId: 'r1' });
    l.complete('k', { id: '42', url: 'https://tracker/42' });
    const again = l.claim('k', { runId: 'r2' });
    assert.equal(again.won, false);
    assert.equal(again.state, 'done');
    assert.deepEqual(again.claim.result, { id: '42', url: 'https://tracker/42' });
    assert.equal(l.complete('k', { id: 'other' }).changed, false, 'a second complete changes nothing');
    assert.equal(l.readClaim('k').result.id, '42');
  });

  test('a failed claim may be taken again, once, by exactly one caller', () => {
    const l = open();
    l.claim('k', { runId: 'r1' });
    l.fail('k', { code: 'HTTP_500', message: 'upstream down' });
    assert.equal(l.readClaim('k').state, 'failed');
    const retry = l.claim('k', { runId: 'r2' });
    assert.equal(retry.won, true);
    assert.equal(retry.tookOverFailed, true);
    assert.equal(l.claim('k', { runId: 'r3' }).won, false);
    assert.equal(fs.readdirSync(path.join(dir, 'keys')).length, 1, 'no guard or temp file is left behind');
  });

  test('a done claim is never failed or overwritten', () => {
    const l = open();
    l.claim('k');
    l.complete('k', { id: '1' });
    assert.equal(l.fail('k', { code: 'X' }).changed, false);
    assert.equal(l.readClaim('k').state, 'done');
  });

  test('complete or fail without a claim is an error, and a result may carry only what action.done carries', () => {
    const l = open();
    assert.equal(code(() => l.complete('nope')), 'LEDGER_NO_CLAIM');
    assert.equal(code(() => l.fail('nope', { code: 'X' })), 'LEDGER_NO_CLAIM');
    l.claim('k');
    assert.equal(code(() => l.complete('k', { id: '1', secret: 'x' })), 'LEDGER_INVALID');
    assert.equal(code(() => l.fail('k', {})), 'LEDGER_INVALID');
  });

  test('a claim file that is empty or cut off still counts as taken (its writer is mid-write, or died there)', () => {
    const l = open();
    l.claim('k');
    const file = path.join(dir, 'keys', fs.readdirSync(path.join(dir, 'keys'))[0]);
    fs.writeFileSync(file, '');
    const lost = l.claim('k', { runId: 'r2' });
    assert.equal(lost.won, false);
    assert.equal(lost.state, 'in-flight');
    assert.equal(l.complete('k', { id: '9' }).changed, true, 'and it can still be completed');
    assert.equal(l.readClaim('k').state, 'done');
  });

  test('a claim file holding a different key is reported, not trusted', () => {
    const l = open();
    l.claim('k');
    const file = path.join(dir, 'keys', fs.readdirSync(path.join(dir, 'keys'))[0]);
    fs.writeFileSync(file, `${JSON.stringify({ v: 1, key: 'someone-else', state: 'done' })}\n`);
    assert.equal(code(() => l.claim('k')), 'LEDGER_KEY_COLLISION');
  });

  test('a failure message is masked and cut', () => {
    const l = open();
    l.claim('k');
    l.fail('k', { code: 'HTTP_401', message: `token ghp_abcdefghijklmnopqrstuvwxyz0123456789 ${'x'.repeat(1000)}` });
    const e = l.readClaim('k').error;
    assert.equal(e.message.includes('ghp_'), false);
    assert.ok(e.message.length <= 300);
  });

  test('N processes claiming one key at once: exactly one wins', async () => {
    const run = Array.from({ length: 8 }, () => child("const r=L.openLedger({dir}).claim('shared',{runId:'r'+process.pid});process.stdout.write(r.won?'won':'lost:'+r.state)"));
    const results = await Promise.all(run.map((c) => c.closed));
    assert.deepEqual(results.map((r) => r.code), Array(8).fill(0), results.map((r) => r.err).join('\n'));
    assert.equal(results.filter((r) => r.out === 'won').length, 1, results.map((r) => r.out).join(' '));
    assert.equal(results.filter((r) => r.out === 'lost:in-flight').length, 7);
  });

  test('N processes racing to take over one failed key: exactly one wins', async () => {
    const l = open();
    l.claim('shared');
    l.fail('shared', { code: 'X' });
    const run = Array.from({ length: 8 }, () => child("const r=L.openLedger({dir}).claim('shared',{runId:'r'+process.pid});process.stdout.write(r.won?'won':'lost:'+r.state)"));
    const results = await Promise.all(run.map((c) => c.closed));
    assert.equal(results.filter((r) => r.out === 'won').length, 1, results.map((r) => r.out + r.err).join(' '));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'keys')).filter((n) => !/^[0-9a-f]{32}\.json$/.test(n)), [], 'no guard or temp file left');
  });

  test('a writer killed after claiming leaves the key in flight with a dead owner: the signal a resume needs', async () => {
    const c = child("L.openLedger({dir}).claim('half',{runId:'r'});process.stdout.write('ready')", { keepAlive: true });
    await c.ready;
    const pid = c.proc.pid;
    c.proc.kill('SIGKILL');
    await c.closed;
    const l = open();
    const lost = l.claim('half', { runId: 'r2' });
    assert.equal(lost.won, false);
    assert.equal(lost.state, 'in-flight');
    assert.equal(lost.claim.pid, pid);
    assert.equal(lost.ownerAlive, false);
  });

  test('a claim from another machine has an owner nobody here can check', () => {
    open({ host: 'build-7' }).claim('k', { runId: 'r' });
    assert.equal(open({ host: 'my-laptop' }).claim('k').ownerAlive, null);
  });

  test('taking over a failed claim does not clobber a fresh claim that appears in between', () => {
    const l = open();
    l.claim('k', { runId: 'r1' });
    l.fail('k', { code: 'X' });
    const file = path.join(dir, 'keys', fs.readdirSync(path.join(dir, 'keys'))[0]);
    // between "I saw the failed claim" and "I took the guard to replace it", another caller takes it over and writes a fresh claim
    const realOpen = fs.openSync;
    let swapped = false;
    fs.openSync = (p, ...rest) => {
      if (!swapped && String(p) === `${file}.guard`) { swapped = true; fs.writeFileSync(file, `${JSON.stringify({ v: 1, key: 'k', runId: 'fresh', state: 'claimed', claimedAt: 'x', pid: 1, host: 'other' })}\n`); }
      return realOpen(p, ...rest);
    };
    let r;
    try { r = l.claim('k', { runId: 'r2' }); } finally { fs.openSync = realOpen; }
    assert.equal(swapped, true);
    assert.equal(r.won, false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).runId, 'fresh', 'the fresh claim is untouched');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'keys')), [path.basename(file)], 'and no guard or temp file is left');
  });
});

describe('locks', () => {
  test('one holder at a time; a second run is told who has it; release lets the next in', () => {
    const l = open();
    const a = l.acquireLock('env:staging', { runId: 'r1' });
    assert.equal(a.acquired, true);
    const b = l.acquireLock('env:staging', { runId: 'r2' });
    assert.equal(b.acquired, false);
    assert.equal(b.holder.runId, 'r1');
    assert.equal(l.acquireLock('ticket:ABC-1', { runId: 'r2' }).acquired, true, 'a different scope is independent');
    a.release();
    assert.equal(l.acquireLock('env:staging', { runId: 'r2' }).acquired, true);
  });

  test('withLock releases on success and on a throw, and refuses with the holder named', () => {
    const l = open();
    assert.equal(l.withLock('s', { runId: 'r1' }, () => 'done'), 'done');
    assert.throws(() => l.withLock('s', { runId: 'r1' }, () => { throw new Error('boom'); }), /boom/);
    assert.equal(l.acquireLock('s', { runId: 'r2' }).acquired, true, 'released after the throw');
    let err;
    try { l.withLock('s', { runId: 'r3' }, () => 'never'); } catch (e) { err = e; }
    assert.equal(err.code, 'LOCKED');
    assert.equal(err.holder.runId, 'r2');
    assert.match(err.message, /run r2/);
  });

  test('a lock whose owner process died is stolen, and the steal is audited', async () => {
    const c = child("L.openLedger({dir}).acquireLock('env:x',{runId:'dead-run'});process.stdout.write('ready')", { keepAlive: true });
    await c.ready;
    c.proc.kill('SIGKILL');
    await c.closed;
    const l = open();
    const got = l.acquireLock('env:x', { runId: 'live-run' });
    assert.equal(got.acquired, true);
    assert.equal(got.stole, 'its owner process is gone');
    const audit = l.readAudit().events.find((e) => e.type === 'lock.stolen');
    assert.equal(audit.scope, 'env:x');
    assert.equal(audit.previousRunId, 'dead-run');
    assert.equal(audit.runId, 'live-run');
    assert.equal(fs.readdirSync(path.join(dir, 'locks')).length, 1, 'no guard or temp file left');
  });

  test('a live owner on this machine is never robbed, however old the lock; an expired one is', () => {
    const a = open({ pid: process.pid });
    a.acquireLock('s', { runId: 'r1', ttlMs: 1000 });
    clock = T0 + 500;
    assert.equal(open().acquireLock('s', { runId: 'r2' }).acquired, false, 'within its TTL');
    clock = T0 + 5000;
    const late = open().acquireLock('s', { runId: 'r2' });
    assert.equal(late.acquired, true);
    assert.equal(late.stole, 'it expired');
  });

  test('a lock from another machine is only ever stolen by TTL: its pid means nothing here', () => {
    open({ host: 'build-7', pid: 999999 }).acquireLock('s', { runId: 'remote', ttlMs: 1000 });
    clock = T0 + 500;
    assert.equal(open({ host: 'my-laptop' }).acquireLock('s', { runId: 'local' }).acquired, false);
    clock = T0 + 2000;
    assert.equal(open({ host: 'my-laptop' }).acquireLock('s', { runId: 'local' }).stole, 'it expired');
  });

  test('releasing after your lock was stolen does not remove the new owner\'s lock', () => {
    const old = open({ pid: process.pid });
    const mine = old.acquireLock('s', { runId: 'r1', ttlMs: 1000 });
    clock = T0 + 5000;
    const thief = open().acquireLock('s', { runId: 'r2' });
    assert.equal(thief.acquired, true);
    mine.release();
    assert.equal(open().acquireLock('s', { runId: 'r3' }).acquired, false, 'the thief still holds it');
    thief.release();
    assert.equal(open().acquireLock('s', { runId: 'r3' }).acquired, true);
  });

  test('a lock file with nothing readable in it is a writer mid-write for a minute, then abandoned', () => {
    const l = open();
    l.acquireLock('s', { runId: 'r1' }).release();
    const lockFile = path.join(dir, 'locks', 'x.lock');
    // find the real name of the scope's lock by creating and reading it
    const probe = l.acquireLock('s', { runId: 'r1' });
    const real = path.join(dir, 'locks', fs.readdirSync(path.join(dir, 'locks'))[0]);
    probe.release();
    fs.writeFileSync(real, '');
    assert.notEqual(lockFile, real);
    assert.equal(l.acquireLock('s', { runId: 'r2' }).acquired, false);
    fs.utimesSync(real, new Date(T0 - 10 * 60 * 1000), new Date(T0 - 10 * 60 * 1000));
    const got = l.acquireLock('s', { runId: 'r2' });
    assert.equal(got.acquired, true);
    assert.equal(got.stole, 'the lock file was never completed');
  });

  test('a run that judged a lock stale does not replace it if another run got there first', () => {
    const l = open({ pid: process.pid });
    l.acquireLock('s', { runId: 'old', ttlMs: 1000 });
    clock = T0 + 5000;
    const file = path.join(dir, 'locks', fs.readdirSync(path.join(dir, 'locks'))[0]);
    // between "this lock is stale" and "I took the guard to replace it", another run steals it and writes a fresh one
    const realOpen = fs.openSync;
    let swapped = false;
    const fresh = { v: 1, scope: 's', runId: 'rival', pid: process.pid, host: os.hostname(), startedAt: new Date(clock).toISOString(), ttlMs: 7200000 };
    fs.openSync = (p, ...rest) => {
      if (!swapped && String(p) === `${file}.guard`) { swapped = true; fs.writeFileSync(file, `${JSON.stringify(fresh)}\n`); }
      return realOpen(p, ...rest);
    };
    let got;
    try { got = open().acquireLock('s', { runId: 'me' }); } finally { fs.openSync = realOpen; }
    assert.equal(swapped, true);
    assert.equal(got.acquired, false);
    assert.equal(got.holder.runId, 'rival');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).runId, 'rival', 'the rival\'s lock is untouched');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'locks')), [path.basename(file)]);
  });

  test('N processes racing to steal one stale lock: exactly one gets it', async () => {
    const dead = child("L.openLedger({dir}).acquireLock('env:race',{runId:'dead'});process.stdout.write('ready')", { keepAlive: true });
    await dead.ready;
    dead.proc.kill('SIGKILL');
    await dead.closed;
    // the racers keep running after they print, so the winner's lock never goes stale while the others are still looking
    const racers = Array.from({ length: 8 }, (_, i) => child(`const g=L.openLedger({dir}).acquireLock('env:race',{runId:'racer-${i}'});process.stdout.write(g.acquired?'won':'lost')`, { keepAlive: true }));
    await Promise.all(racers.map((r) => r.printed));
    const results = racers.map((r) => r.output());
    for (const r of racers) r.proc.kill('SIGKILL');
    await Promise.all(racers.map((r) => r.closed));
    assert.equal(results.filter((o) => o === 'won').length, 1, results.join(' '));
    assert.equal(open().readAudit().events.filter((e) => e.type === 'lock.stolen').length, 1, 'one steal, one audit record');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'locks')).filter((n) => !n.endsWith('.lock')), [], 'no guard or temp file left');
  });

  test('bad arguments are refused', () => {
    const l = open();
    assert.equal(code(() => l.acquireLock('', { runId: 'r' })), 'LEDGER_INVALID');
    assert.equal(code(() => l.acquireLock('s', {})), 'LEDGER_INVALID');
  });
});

describe('status and pruning', () => {
  test('status says what finished, what did not, which claims are in flight and which locks are held', () => {
    const l = open();
    l.record('done-run', 'run.start', START);
    l.record('done-run', 'run.end', { exit: 0, complete: true });
    l.record('crashed-run', 'run.start', START);
    l.claim('a', { runId: 'done-run' });
    l.complete('a', { id: '1' });
    l.claim('b', { runId: 'crashed-run' });
    l.acquireLock('env:x', { runId: 'crashed-run' });
    const s = l.status();
    assert.deepEqual(s.runs, { total: 2, finished: 1, unfinished: ['crashed-run'] });
    assert.deepEqual(s.keys.byState, { done: 1, claimed: 1 });
    assert.deepEqual(s.keys.inFlight.map((k) => [k.key, k.runId, k.ownerAlive]), [['b', 'crashed-run', true]]);
    assert.equal(s.locks.length, 1);
    assert.equal(s.locks[0].runId, 'crashed-run');
    assert.equal(s.locks[0].stale, null);
    assert.equal(s.version, 1);
  });

  test('prune removes what is older than the limits, keeps what is not, and a dry run touches nothing', () => {
    const l = open();
    for (const id of ['old', 'new']) l.record(id, 'run.start', START);
    l.claim('old-key'); l.claim('new-key');
    const age = (file, days) => fs.utimesSync(file, new Date(T0 - days * DAY), new Date(T0 - days * DAY));
    age(runFile('old'), 100);
    age(runFile('new'), 10);
    const keyFileOf = (k) => path.join(dir, 'keys', fs.readdirSync(path.join(dir, 'keys')).find((n) => JSON.parse(fs.readFileSync(path.join(dir, 'keys', n), 'utf8')).key === k));
    age(keyFileOf('old-key'), 401);
    age(keyFileOf('new-key'), 399);
    fs.writeFileSync(path.join(dir, 'keys', 'x.json.tmp-1-abc'), 'x');
    age(path.join(dir, 'keys', 'x.json.tmp-1-abc'), 3);

    const dry = l.prune({ runDays: 90, keyDays: 400, dryRun: true });
    assert.deepEqual([dry.runs.length, dry.keys.length, dry.leftovers.length], [1, 1, 1]);
    assert.equal(fs.existsSync(runFile('old')), true, 'a dry run removes nothing');

    const real = l.prune({ runDays: 90, keyDays: 400 });
    assert.deepEqual([real.runs.length, real.keys.length, real.leftovers.length], [1, 1, 1]);
    assert.equal(fs.existsSync(runFile('old')), false);
    assert.equal(fs.existsSync(runFile('new')), true);
    assert.equal(l.readClaim('old-key'), null);
    assert.equal(l.readClaim('new-key').state, 'claimed');
  });
});

describe('the record schema and the code agree', () => {
  const Ajv = require('../node_modules/ajv');
  const schema = require('../../schemas/ledger-record.schema.json');
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const sample = (type) => {
    const fields = {};
    for (const [k, spec] of Object.entries(TYPES[type])) {
      const want = Array.isArray(spec) ? 'enum' : spec.replace('?', '');
      fields[k] = { string: 's', number: 1, boolean: true, object: {}, array: [], enum: Array.isArray(spec) ? spec[0] : null }[want];
    }
    return { v: 1, ts: '2026-11-13T10:00:00.000Z', runId: 'r', type, ...fields };
  };

  test('a record the code accepts, the schema accepts, for every type', () => {
    for (const type of Object.keys(TYPES)) {
      const rec = sample(type);
      assert.equal(validateRecord(rec), null, type);
      assert.equal(validate(rec), true, `${type}: ${ajv.errorsText(validate.errors)}`);
    }
  });

  test('a record the code refuses, the schema refuses', () => {
    for (const type of Object.keys(TYPES)) {
      const extra = { ...sample(type), surprise: 1 };
      assert.notEqual(validateRecord(extra), null, type);
      assert.equal(validate(extra), false, type);
      const required = Object.entries(TYPES[type]).find(([, s]) => !(typeof s === 'string' && s.endsWith('?')));
      if (required) {
        const missing = sample(type);
        delete missing[required[0]];
        assert.notEqual(validateRecord(missing), null, `${type} without ${required[0]}`);
        assert.equal(validate(missing), false, `${type} without ${required[0]}`);
      }
    }
  });

  test('the schema names exactly the fields the table names, with the same required ones', () => {
    for (const [type, table] of Object.entries(TYPES)) {
      const def = schema.definitions[type.replace('.', '_')];
      assert.ok(def, `${type} is in the schema`);
      assert.deepEqual(Object.keys(def.properties).sort(), ['v', 'ts', 'runId', 'type', 'truncated', ...Object.keys(table)].sort(), type);
      assert.deepEqual([...def.required].sort(), ['v', 'ts', 'runId', 'type', ...Object.entries(table).filter(([, s]) => !(typeof s === 'string' && s.endsWith('?'))).map(([k]) => k)].sort(), type);
    }
    assert.equal(schema.oneOf.length, Object.keys(TYPES).length);
  });
});
