'use strict';

// What the independent review of slice 1 found (each describe names its finding), and the mutants it showed the first tests did not kill.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { openLedger, validateRecord, parseEvents, TYPES, MAX_RECORD_BYTES } = require('../../scripts/ledger/lib/ledger');

const LIB = path.join(__dirname, '..', '..', 'scripts', 'ledger', 'lib', 'ledger.js');
const T0 = Date.parse('2026-11-13T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const START = { pid: 1, host: 'h' };
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

let dir;
let clock;
const open = (extra = {}) => openLedger({ dir, now: () => clock, ...extra });
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ledger-rv-')); clock = T0; });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const code = (fn) => { try { fn(); } catch (e) { return e.code || e.message; } return null; };
const files = (sub) => fs.readdirSync(path.join(dir, sub));
const only = (sub) => { const f = files(sub).filter((n) => !/\.(guard|tmp-.*)$/.test(n)); assert.equal(f.length, 1, `${sub}: ${f}`); return path.join(dir, sub, f[0]); };
const setMtime = (file, ms) => fs.utimesSync(file, new Date(ms), new Date(ms));
const mode = (f) => fs.statSync(f).mode & 0o777;
const runFileOf = (l, id) => { l.record(id, 'run.start', START); return only('runs'); };

function child(snippet, d = dir) {
  const src = `const L=require(${JSON.stringify(LIB)});const dir=${JSON.stringify(d)};${snippet}`;
  const proc = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  proc.stdout.on('data', (x) => { out += x; });
  proc.stderr.on('data', (x) => { err += x; });
  return new Promise((resolve) => proc.on('close', (c) => resolve({ code: c, out, err })));
}

describe('F1: a cut-off line does not swallow the next record', () => {
  test('after a torn tail, the next record is a line of its own and the run can still finish', () => {
    const l = open();
    l.record('r', 'run.start', START);
    const file = only('runs');
    fs.appendFileSync(file, '{"v":1,"ts":"2026-11-13T10:00:01.000Z","runId":"r","type":"test.res');
    l.record('r', 'run.end', { exit: 0, complete: true });
    const r = l.readRun('r');
    assert.deepEqual(r.events.map((e) => e.type), ['run.start', 'run.end']);
    assert.equal(r.finished, true);
    assert.match(r.warnings.join('\n'), /line 2 is not valid JSON/, 'the cut-off line is reported, not hidden');
  });

  test('a complete record that merely lacks its newline is not glued to the next one either', () => {
    const l = open();
    const file = runFileOf(l, 'r');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').trimEnd());
    l.record('r', 'run.end', { exit: 0, complete: true });
    assert.deepEqual(l.readRun('r').events.map((e) => e.type), ['run.start', 'run.end']);
  });

  test('the same holds for the audit log', () => {
    const l = open();
    l.audit('r', 'lock.stolen', { scope: 's', reason: 'it expired' });
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), '{"v":1,"ts"');
    l.audit('r', 'lock.stolen', { scope: 't', reason: 'it expired' });
    assert.deepEqual(l.readAudit().events.map((e) => e.scope), ['s', 't']);
  });
});

describe('F2: the first writers of a new ledger', () => {
  test('eight processes claiming in a brand-new ledger: none fails, exactly one wins, every round', async () => {
    for (let round = 0; round < 12; round += 1) {
      const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ledger-fresh-'));
      try {
        const results = await Promise.all(Array.from({ length: 8 }, () => child("const r=L.openLedger({dir}).claim('k',{runId:'r'});process.stdout.write(r.won?'won':'lost')", path.join(fresh, 'new-ledger'))));
        assert.deepEqual(results.map((r) => r.code), Array(8).fill(0), results.map((r) => r.err).join('\n'));
        assert.equal(results.filter((r) => r.out === 'won').length, 1, `round ${round}: ${results.map((r) => r.out).join(' ')}`);
      } finally { fs.rmSync(fresh, { recursive: true, force: true }); }
    }
  });

  test('VERSION is never visible empty: it is created complete', () => {
    const l = open();
    l.claim('k');
    assert.equal(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8'), '1\n');
    assert.deepEqual(files('.').filter((n) => n.startsWith('VERSION.')), [], 'no temp file left');
  });

  test('an empty VERSION (a writer that died mid-create) does not wedge the ledger: reads are quiet and the next write repairs it', () => {
    open().claim('k');
    fs.writeFileSync(path.join(dir, 'VERSION'), '');
    const l = open();
    assert.deepEqual(l.readRun('r').warnings, []);
    assert.equal(l.versionProblem(), null);
    assert.equal(l.claim('k2').won, true);
    assert.equal(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8'), '1\n');
  });
});

describe('F3: reading never throws or hangs, whatever is at the path', () => {
  test('a directory where a file belongs, in every place the ledger reads', () => {
    const l = open();
    l.record('good', 'run.start', START);
    l.claim('good-key');
    l.acquireLock('good-scope', { runId: 'good' });
    fs.mkdirSync(path.join(dir, 'runs', 'zz.jsonl'));
    fs.mkdirSync(path.join(dir, 'keys', 'a'.repeat(32) + '.json'));
    fs.mkdirSync(path.join(dir, 'locks', 'b'.repeat(32) + '.lock'));
    fs.mkdirSync(path.join(dir, 'audit.jsonl'));
    const r = open();
    assert.doesNotThrow(() => { r.status(); r.listRuns(); r.listKeys(); r.listLocks(); r.readAudit(); r.readRun('zz'); });
    const s = r.status();
    assert.equal(s.runs.total, 2);
    assert.equal(s.keys.total, 2);
    assert.equal(s.locks.length, 2);
    assert.equal(r.readAudit().events.length, 0);
    assert.match(r.readAudit().warnings.join('\n'), /not a regular file/);
    assert.equal(r.readRun('good').events.length, 1, 'the good run is still readable beside the bad entries');
  });

  test('VERSION that is a directory: reads warn, writes refuse, nothing throws on the way', () => {
    open().claim('k');
    fs.rmSync(path.join(dir, 'VERSION'));
    fs.mkdirSync(path.join(dir, 'VERSION'));
    const l = open();
    assert.match(l.readRun('r').warnings[0], /VERSION file is not a readable file/);
    assert.equal(code(() => l.claim('k2')), 'LEDGER_VERSION');
    assert.equal(l.status().version, '?');
  });

  test('symlinks are not followed when reading (a loop, a dangling link, a link to a big or special file)', () => {
    const l = open();
    l.record('good', 'run.start', START);
    fs.symlinkSync(path.join(dir, 'runs', 'loop.jsonl'), path.join(dir, 'runs', 'loop.jsonl'));
    fs.symlinkSync('/nowhere/at/all', path.join(dir, 'runs', 'dangling.jsonl'));
    fs.symlinkSync('/dev/zero', path.join(dir, 'runs', 'zero.jsonl'));
    const runs = open().listRuns();
    assert.equal(runs.length, 4);
    assert.equal(runs.filter((r) => r.unreadable).length, 3);
    assert.equal(open().readRun('good').events.length, 1);
  });

  // QA_NO_FIFO_TEST exists for people who run these tests against a deliberately broken ledger (a mutation check): against code that reads a
  // pipe, this test blocks the whole process, and a blocked process cannot time itself out.
  test('a named pipe (which would block a reader forever) is skipped', { skip: process.platform === 'win32' || Boolean(process.env.QA_NO_FIFO_TEST), timeout: 15000 }, () => {
    open().record('good', 'run.start', START);
    execFileSync('mkfifo', [path.join(dir, 'runs', 'pipe.jsonl')]);
    execFileSync('mkfifo', [path.join(dir, 'audit.jsonl')]);
    const l = open();
    assert.equal(l.listRuns().length, 2);
    assert.match(l.readAudit().warnings.join('\n'), /not a regular file/);
  });

  test('a file too big to be ours is not read', () => {
    const l = open();
    l.record('good', 'run.start', START);
    const big = path.join(dir, 'runs', 'big.jsonl');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, 17 * 1024 * 1024); // sparse: no real disk used
    const runs = l.listRuns();
    assert.match(runs.find((r) => r.file === 'big.jsonl').unreadable, /larger than/);
  });

  test('a claim file that is valid JSON but names no key is an unreadable claim, not a collision that wedges the key forever', () => {
    const l = open();
    l.claim('k');
    const file = only('keys');
    for (const body of ['{}', '{"key":{"a":1}}', '[]', 'null', '"text"', '{"key":5}']) {
      fs.writeFileSync(file, body);
      const lost = l.claim('k');
      assert.equal(lost.won, false, body);
      assert.equal(lost.state, 'in-flight', body);
      assert.equal(lost.claim.unreadable, true, body);
    }
    assert.equal(l.complete('k', { id: '1' }).changed, true, 'and it can still be completed');
  });

  test('a ledger root that is a file reads as empty', () => {
    const file = path.join(dir, 'a-file');
    fs.writeFileSync(file, 'x');
    const l = openLedger({ dir: file });
    assert.doesNotThrow(() => { l.status(); l.readRun('r'); l.listRuns(); l.listKeys(); l.listLocks(); });
    assert.equal(l.status().runs.total, 0);
  });

  test('an unreadable file (mode 000) is skipped with a warning', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, () => {
    const l = open();
    const file = runFileOf(l, 'r');
    fs.chmodSync(file, 0);
    try {
      const r = open().readRun('r');
      assert.equal(r.events.length, 0);
      assert.match(r.warnings.join('\n'), /not read/);
    } finally { fs.chmodSync(file, 0o600); }
  });
});

describe('F4: symlinks at a claim or lock path do not loop, and are not written through', () => {
  const sha32 = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 32);

  test('a dangling symlink where a claim belongs: the key is taken (in flight), no stack overflow', () => {
    const l = open();
    l.claim('other');
    fs.symlinkSync('/nowhere', path.join(dir, 'keys', `${sha32('k')}.json`));
    const r = l.claim('k');
    assert.equal(r.won, false);
    assert.equal(r.state, 'in-flight');
    assert.equal(r.claim.unreadable, true);
  });

  test('a dangling symlink where a lock belongs: held for the grace period, then taken over like any abandoned lock', () => {
    const l = open();
    l.acquireLock('other', { runId: 'r0' });
    const lock = path.join(dir, 'locks', `${sha32('s')}.lock`);
    fs.symlinkSync('/nowhere', lock);
    fs.lutimesSync(lock, new Date(T0), new Date(T0)); // its age is judged by the ledger's clock, so set it by that clock
    assert.equal(l.acquireLock('s', { runId: 'r1' }).acquired, false);
    clock = T0 + 5 * 60 * 1000;
    const got = open().acquireLock('s', { runId: 'r2' });
    assert.equal(got.acquired, true);
    assert.equal(fs.lstatSync(lock).isFile(), true, 'the link itself was replaced, not followed');
  });

  test('appending never goes through a symlink to a file outside the ledger', { skip: process.platform === 'win32' }, () => {
    const l = open();
    const file = runFileOf(l, 'r');
    const outside = path.join(os.tmpdir(), `qa-outside-${process.pid}`);
    fs.writeFileSync(outside, 'precious\n');
    try {
      fs.rmSync(file);
      fs.symlinkSync(outside, file);
      assert.ok(code(() => l.record('r', 'run.end', { exit: 0, complete: true })), 'the write is refused');
      assert.equal(fs.readFileSync(outside, 'utf8'), 'precious\n');
    } finally { fs.rmSync(outside, { force: true }); }
  });
});

describe('F5: what goes into a file is validated, checked for secrets and capped', () => {
  test('a run id that is too long, empty, not a string or not printable is refused everywhere, and nothing is written', () => {
    const l = open();
    for (const bad of ['x'.repeat(129), '', 5, null, { a: 1 }, 'a\nb']) {
      assert.equal(code(() => l.record(bad, 'run.start', START)), 'LEDGER_INVALID', JSON.stringify(bad));
      assert.equal(code(() => l.acquireLock('s', { runId: bad })), 'LEDGER_INVALID', JSON.stringify(bad));
    }
    for (const bad of ['x'.repeat(129), 5, { a: 1 }, 'a\nb']) assert.equal(code(() => l.claim('k', { runId: bad })), 'LEDGER_INVALID', JSON.stringify(bad));
    assert.equal(l.claim('k', { runId: null }).won, true, 'no run id at all is fine for a claim');
    assert.deepEqual(files('runs'), []);
  });

  test('a run id, key or lock scope that looks like a credential is refused, and the credential is in no file', () => {
    const l = open();
    assert.equal(code(() => l.record(`run-${TOKEN}`, 'run.start', START)), 'LEDGER_INVALID');
    assert.equal(code(() => l.claim(`k-${TOKEN}`)), 'LEDGER_INVALID');
    assert.equal(code(() => l.claim('k', { runId: `r-${TOKEN}` })), 'LEDGER_INVALID');
    assert.equal(code(() => l.acquireLock(`env:https://user:${TOKEN}@host`, { runId: 'r' })), 'LEDGER_INVALID');
    assert.equal(code(() => l.acquireLock('s', { runId: `r-${TOKEN}` })), 'LEDGER_INVALID');
    for (const sub of ['runs', 'keys', 'locks']) for (const f of files(sub)) assert.equal(fs.readFileSync(path.join(dir, sub, f), 'utf8').includes(TOKEN), false);
    assert.equal(fs.existsSync(path.join(dir, 'audit.jsonl')), false);
  });

  test('a lock TTL must be a positive finite number', () => {
    const l = open();
    for (const bad of [-1, 0, NaN, Infinity, 'x', null, {}]) assert.equal(code(() => l.acquireLock('s', { runId: 'r', ttlMs: bad })), 'LEDGER_INVALID', String(bad));
    assert.equal(l.acquireLock('s', { runId: 'r', ttlMs: 1 }).acquired, true);
  });

  test('a negative TTL cannot be used to take a live owner\'s lock', () => {
    const l = open();
    l.acquireLock('s', { runId: 'r1' });
    assert.equal(code(() => l.acquireLock('s', { runId: 'r2', ttlMs: -1 })), 'LEDGER_INVALID');
    assert.equal(l.acquireLock('s', { runId: 'r3' }).acquired, false);
  });

  test('a claim result is masked, and capped at the record size', () => {
    const l = open();
    l.claim('k');
    l.complete('k', { id: `id ${TOKEN}`, url: `https://x/${'u'.repeat(200000)}` });
    const file = only('keys');
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes(TOKEN), false);
    assert.ok(Buffer.byteLength(text) <= MAX_RECORD_BYTES, `${Buffer.byteLength(text)} bytes`);
  });

  test('a failure code is cut to 80 characters and masked', () => {
    const l = open();
    l.claim('k');
    l.fail('k', { code: `${'C'.repeat(200)}${TOKEN}` });
    const c = l.readClaim('k').error.code;
    assert.equal(c.length, 80);
    assert.equal(c.includes('ghp_'), false);
  });

  test('object keys are masked too, and a __proto__ key is dropped without touching Object.prototype', () => {
    const l = open();
    l.record('r', 'run.start', { ...START, config: JSON.parse(`{"${TOKEN}":1,"__proto__":{"polluted":true},"ok":2}`) });
    const text = fs.readFileSync(only('runs'), 'utf8');
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes('polluted'), false);
    assert.equal({}.polluted, undefined);
    assert.equal(l.readRun('r').events[0].config.ok, 2);
  });

  test('values that cannot be written (circular, BigInt, too deep) are a coded refusal, not a crash', () => {
    const l = open();
    const loop = {};
    loop.self = loop;
    assert.equal(code(() => l.record('r', 'run.start', { ...START, config: loop })), 'LEDGER_INVALID');
    assert.equal(code(() => l.record('r', 'run.start', { ...START, config: { n: 10n } })), 'LEDGER_INVALID');
    let deep = {};
    for (let i = 0; i < 40; i += 1) deep = { d: deep };
    assert.equal(code(() => l.record('r', 'run.start', { ...START, config: deep })), 'LEDGER_INVALID');
    assert.deepEqual(files('runs'), []);
  });
});

describe('F6: prune obeys the same rules as every other write', () => {
  test('it refuses a ledger of a newer layout, and removes nothing', () => {
    const l = open();
    const file = runFileOf(l, 'old');
    setMtime(file, T0 - 500 * DAY);
    fs.writeFileSync(path.join(dir, 'VERSION'), '2\n');
    assert.equal(code(() => open().prune({ runDays: 90 })), 'LEDGER_VERSION');
    assert.equal(fs.existsSync(file), true);
  });

  test('ages that are not positive numbers are refused instead of meaning "everything"', () => {
    const l = open();
    for (const bad of [NaN, null, 0, -1, 'x', Infinity]) {
      assert.equal(code(() => l.prune({ runDays: bad })), 'LEDGER_INVALID', String(bad));
      assert.equal(code(() => l.prune({ keyDays: bad })), 'LEDGER_INVALID', String(bad));
    }
  });

  test('an entry that cannot be removed is reported, not thrown, and a symlink is judged and removed as a link (not as what it points at)', () => {
    const l = open();
    const outside = path.join(os.tmpdir(), `qa-prune-outside-${process.pid}`);
    fs.writeFileSync(outside, 'keep me');
    try {
      l.record('r', 'run.start', START);
      fs.mkdirSync(path.join(dir, 'runs', 'dir.jsonl'));
      fs.mkdirSync(path.join(dir, 'runs', 'dir.jsonl', 'inner'));
      fs.symlinkSync(outside, path.join(dir, 'runs', 'link.jsonl'));
      fs.symlinkSync('/nowhere/at/all', path.join(dir, 'runs', 'dangling.jsonl'));
      clock = T0 + 200 * DAY;
      for (const n of ['dir.jsonl', 'link.jsonl', 'dangling.jsonl']) fs.lutimesSync(path.join(dir, 'runs', n), new Date(T0), new Date(T0));
      fs.utimesSync(outside, new Date(clock), new Date(clock)); // what the link points at is NEW: only the link's own age may decide
      const r = open().prune({ runDays: 90 });
      assert.ok(['link.jsonl', 'dir.jsonl', 'dangling.jsonl'].every((n) => r.runs.includes(n)));
      assert.equal(fs.existsSync(path.join(dir, 'runs', 'link.jsonl')), false);
      assert.equal(fs.lstatSync(path.join(dir, 'runs')).isDirectory() && files('runs').includes('dangling.jsonl'), false, 'a dangling link is removed too');
      assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me', 'the link was removed, not what it points at');
      assert.equal(r.errors.length, 1);
      assert.match(r.errors[0], /^dir\.jsonl:/);
    } finally { fs.rmSync(outside, { force: true }); }
  });

  test('the boundary: a file exactly as old as the limit is kept, one older is removed; old guard and temp files are swept', () => {
    const l = open();
    l.record('exact', 'run.start', START);
    l.record('older', 'run.start', START);
    const [a, b] = files('runs').map((n) => path.join(dir, 'runs', n));
    const idOf = (f) => JSON.parse(fs.readFileSync(f, 'utf8').split('\n')[0]).runId;
    const exact = idOf(a) === 'exact' ? a : b;
    const older = exact === a ? b : a;
    setMtime(exact, T0 - 90 * DAY);
    setMtime(older, T0 - 90 * DAY - 1000);
    l.claim('k');
    for (const f of [path.join(dir, 'keys', 'x.json.guard'), path.join(dir, 'locks', 'y.lock.guard'), path.join(dir, 'locks', 'y.lock.tmp-1-ab')]) { fs.writeFileSync(f, ''); setMtime(f, T0 - 3 * DAY); }
    const r = l.prune({ runDays: 90, keyDays: 400 });
    assert.deepEqual(r.runs.length, 1);
    assert.equal(fs.existsSync(exact), true);
    assert.equal(fs.existsSync(older), false);
    assert.equal(r.leftovers.length, 3);
    assert.deepEqual(files('locks').filter((n) => n.endsWith('.guard') || /\.tmp-/.test(n)), []);
  });
});

describe('F7: the envelope is checked like the schema checks it', () => {
  const Ajv = require('../node_modules/ajv');
  const validate = new Ajv({ allErrors: true, strict: false }).compile(require('../../schemas/ledger-record.schema.json'));
  const ok = { v: 1, ts: '2026-11-13T10:00:00.000Z', runId: 'r', type: 'run.end', exit: 0, complete: true };

  test('a wrong version or timestamp is refused by the code and by the schema alike', () => {
    assert.equal(validateRecord(ok), null);
    assert.equal(validate(ok), true);
    for (const bad of [{ ...ok, v: 2 }, { ...ok, v: '1' }, { ...ok, ts: 'garbage' }, { ...ok, ts: '2026-11-13 10:00:00' }, { ...ok, ts: '2026-11-13T10:00:00+01:00' }]) {
      assert.notEqual(validateRecord(bad), null, JSON.stringify(bad));
      assert.equal(validate(bad), false, JSON.stringify(bad));
    }
  });

  test('a record of a known type from a newer layout is skipped as newer, not read as this one', () => {
    const { events, warnings } = parseEvents(`${JSON.stringify({ ...ok, v: 2 })}\n${JSON.stringify(ok)}\n`, 'run r');
    assert.equal(events.length, 1);
    assert.match(warnings[0], /1 record this version does not understand/);
  });

  test('a record with a garbage timestamp is skipped with the reason', () => {
    const { events, warnings } = parseEvents(`${JSON.stringify({ ...ok, ts: 'garbage' })}\n`, 'run r');
    assert.deepEqual(events, []);
    assert.match(warnings[0], /"ts" must be an ISO 8601/);
  });

  test('the envelope in the code and in the schema list the same fields', () => {
    const def = require('../../schemas/ledger-record.schema.json').definitions.run_end;
    assert.equal(def.properties.v.const, 1);
    assert.ok(def.properties.ts.pattern);
    assert.deepEqual(Object.keys(def.properties).filter((k) => !Object.keys(TYPES['run.end']).includes(k)).sort(), ['runId', 'truncated', 'ts', 'type', 'v']);
  });
});

describe('mutants the first tests did not kill', () => {
  const sha32 = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 32);
  const keyFile = (k) => path.join(dir, 'keys', `${sha32(k)}.json`);
  const lockFile = (s) => path.join(dir, 'locks', `${sha32(s)}.lock`);

  test('a failed claim that FAILED AGAIN between "judged" and "took the guard" is not taken over from under the one who owns that failure', () => {
    const l = open();
    l.claim('k', { runId: 'r1' });
    l.fail('k', { code: 'FIRST' });
    const file = keyFile('k');
    const realOpen = fs.openSync;
    let swapped = false;
    fs.openSync = (p, ...rest) => {
      if (!swapped && String(p) === `${file}.guard`) { swapped = true; fs.writeFileSync(file, `${JSON.stringify({ v: 1, key: 'k', runId: 'r9', state: 'failed', claimedAt: 'x', completedAt: '2099-01-01T00:00:00.000Z', error: { code: 'SECOND' }, pid: 1, host: 'o' })}\n`); }
      return realOpen(p, ...rest);
    };
    let r;
    try { r = l.claim('k', { runId: 'r2' }); } finally { fs.openSync = realOpen; }
    assert.equal(swapped, true);
    assert.equal(r.won, false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).error.code, 'SECOND');
  });

  test('release removes the lock only when pid, host, run id AND start time all match: each one alone is enough to keep it', () => {
    const l = open({ pid: process.pid });
    const mine = l.acquireLock('s', { runId: 'r1' });
    const file = lockFile('s');
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [field, other] of [['pid', original.pid + 1], ['host', 'another-host'], ['runId', 'another-run'], ['startedAt', '2099-01-01T00:00:00.000Z']]) {
      fs.writeFileSync(file, `${JSON.stringify({ ...original, [field]: other })}\n`);
      mine.release();
      assert.equal(fs.existsSync(file), true, `a lock differing only in ${field} was removed`);
    }
    fs.writeFileSync(file, `${JSON.stringify(original)}\n`);
    mine.release();
    assert.equal(fs.existsSync(file), false, 'and its own lock is removed');
  });

  test('a run that resumes with the SAME run id after its lock was stolen does not have its new lock removed by the old release', () => {
    const old = open({ pid: process.pid });
    const mine = old.acquireLock('s', { runId: 'same-run', ttlMs: 1000 });
    clock = T0 + 5000;
    const resumed = open().acquireLock('s', { runId: 'same-run' });
    assert.equal(resumed.stole, 'it expired');
    mine.release();
    assert.equal(fs.existsSync(lockFile('s')), true);
  });

  test('an empty lock file is held for a minute of the LEDGER\'s clock, then abandoned (not judged by the real clock)', () => {
    const l = open();
    l.acquireLock('s', { runId: 'r1' }).release();
    const file = lockFile('s');
    fs.writeFileSync(file, '');
    setMtime(file, clock - 30 * 1000);
    assert.equal(l.acquireLock('s', { runId: 'r2' }).acquired, false, '30 seconds old: still being written');
    setMtime(file, clock - 61 * 1000);
    assert.equal(l.acquireLock('s', { runId: 'r2' }).stole, 'the lock file was never completed');
  });

  test('a takeover guard left by a dead process is cleared after a minute, a fresh one is respected', () => {
    const l = open();
    l.claim('k');
    l.fail('k', { code: 'X' });
    const guard = `${keyFile('k')}.guard`;
    fs.writeFileSync(guard, '');
    setMtime(guard, clock - 10 * 1000);
    assert.equal(l.claim('k').won, false, 'a guard 10 seconds old belongs to someone still working');
    assert.equal(l.readClaim('k').state, 'failed');
    setMtime(guard, clock - 61 * 1000);
    assert.equal(l.claim('k').won, true, 'a guard over a minute old is a dead holder\'s');
    assert.equal(fs.existsSync(guard), false);
  });

  test('a lock held by a process this user may not signal (EPERM, pid 1) is a LIVE owner, not a dead one', { skip: process.platform === 'win32' }, () => {
    const l = open();
    l.acquireLock('s', { runId: 'r1' }).release();
    fs.writeFileSync(lockFile('s'), `${JSON.stringify({ v: 1, scope: 's', runId: 'init', pid: 1, host: os.hostname(), startedAt: new Date(clock).toISOString(), ttlMs: 7200000 })}\n`);
    assert.equal(l.acquireLock('s', { runId: 'r2' }).acquired, false);
  });

  test('readRun returns only the events of the run asked for', () => {
    const l = open();
    const file = runFileOf(l, 'r');
    fs.appendFileSync(file, `${JSON.stringify({ v: 1, ts: '2026-11-13T10:00:00.000Z', runId: 'someone-else', type: 'run.end', exit: 0, complete: true })}\n`);
    const r = l.readRun('r');
    assert.deepEqual(r.events.map((e) => e.runId), ['r']);
    assert.equal(r.finished, false);
  });

  test('every file the ledger writes is 0600: claims (created, completed, taken over), locks (created, stolen)', { skip: process.platform === 'win32' }, () => {
    const l = open();
    l.claim('a'); assert.equal(mode(keyFile('a')), 0o600);
    l.complete('a', { id: '1' }); assert.equal(mode(keyFile('a')), 0o600, 'completed (temp file renamed into place)');
    l.claim('b'); l.fail('b', { code: 'X' });
    l.claim('b'); assert.equal(mode(keyFile('b')), 0o600, 'taken over');
    l.acquireLock('s', { runId: 'r1', ttlMs: 1000 }); assert.equal(mode(lockFile('s')), 0o600);
    clock = T0 + 5000;
    l.acquireLock('s', { runId: 'r2' }); assert.equal(mode(lockFile('s')), 0o600, 'stolen');
    assert.equal(mode(path.join(dir, 'audit.jsonl')), 0o600);
  });

  test('keys and scopes that differ only by case are different keys and different scopes', () => {
    const l = open();
    assert.equal(l.claim('Key').won, true);
    assert.equal(l.claim('key').won, true);
    assert.equal(l.acquireLock('Scope', { runId: 'r' }).acquired, true);
    assert.equal(l.acquireLock('scope', { runId: 'r' }).acquired, true);
  });

  test('the steal is audited with who held it, and a takeover remembers the failure it replaced', () => {
    const l = open({ pid: 4242 });
    l.acquireLock('s', { runId: 'old-run', ttlMs: 1000 });
    clock = T0 + 5000;
    open().acquireLock('s', { runId: 'new-run' });
    const e = open().readAudit().events.find((x) => x.type === 'lock.stolen');
    assert.deepEqual([e.previousRunId, e.previousPid], ['old-run', 4242]);
    l.claim('k'); l.fail('k', { code: 'HTTP_500' });
    assert.equal(l.claim('k', { runId: 'retry' }).tookOverFailed, true);
    assert.equal(JSON.parse(fs.readFileSync(keyFile('k'), 'utf8')).previousFailure.code, 'HTTP_500');
  });

  test('listLocks says WHY a lock is stale, and a done claim reports no owner', () => {
    const l = open({ pid: 999999, host: 'elsewhere' });
    l.acquireLock('s', { runId: 'r', ttlMs: 1000 });
    clock = T0 + 5000;
    assert.equal(open().listLocks()[0].stale, 'it expired');
    l.claim('k'); l.complete('k', { id: '1' });
    assert.equal(l.claim('k').ownerAlive, null);
  });

  test('complete after fail is refused (a failed claim may already be someone else\'s to take over); a second fail keeps the first error', () => {
    const l = open();
    l.claim('k');
    l.fail('k', { code: 'FIRST' });
    assert.equal(code(() => l.complete('k', { id: '1' })), 'LEDGER_CLAIM_FAILED');
    assert.equal(l.fail('k', { code: 'SECOND' }).changed, false);
    assert.equal(l.readClaim('k').error.code, 'FIRST');
  });

  test('a claim file that was torn can be failed as well as completed, and becomes a well-formed record', () => {
    const l = open();
    l.claim('k');
    fs.writeFileSync(keyFile('k'), '{"v":1,"ke');
    assert.equal(l.fail('k', { code: 'X' }).changed, true);
    assert.deepEqual([l.readClaim('k').state, l.readClaim('k').key], ['failed', 'k']);
  });
});
