'use strict';

// Slice 2: what the ledger answers across runs (flake rate, heal attempts, stale heals), the journal self-heal talks to it through, and when a
// run is recorded at all.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openLedger } = require('../../scripts/ledger/lib/ledger');
const { staleHeals, healAttempts, flakeRates, DAY_MS } = require('../../scripts/ledger/lib/views');
const { healJournal } = require('../../scripts/ledger/lib/journal');
const { enabledLedger } = require('../../scripts/ledger/lib/enable');
const { main: cliMain } = require('../../scripts/ledger/cli');

const T0 = Date.parse('2026-11-13T10:00:00Z');
const START = { pid: 1, host: 'h' };
let work;
let dir;
let clock;
beforeEach(() => { work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-views-')); dir = path.join(work, 'ledger'); clock = T0; });
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));
const open = () => openLedger({ dir, now: () => clock });

// one finished run: results is [[spec, name, status, phase], ...]
function run(l, id, results, { finish = true } = {}) {
  clock += 60 * 1000;
  l.record(id, 'run.start', START);
  for (const [spec, name, status, phase] of results) l.record(id, 'test.result', { spec, name, status, phase });
  if (finish) l.record(id, 'run.end', { exit: 0, complete: true });
}
const P = 'passed';
const F = 'failed';

describe('readAllRuns', () => {
  test('every readable run, oldest first, with its events; a file with nothing usable in it is left out', () => {
    const l = open();
    run(l, 'b', [['s', 't', P, 'main']]);
    run(l, 'a', [['s', 't', P, 'main']]);
    fs.writeFileSync(path.join(dir, 'runs', 'junk.jsonl'), 'not json\n');
    fs.mkdirSync(path.join(dir, 'runs', 'dir.jsonl'));
    const runs = open().readAllRuns();
    assert.deepEqual(runs.map((r) => r.runId), ['b', 'a'], 'ordered by when they started, not by name');
    assert.deepEqual(runs.map((r) => r.finished), [true, true]);
    assert.equal(runs[0].events.length, 3);
  });
});

describe('flake rate', () => {
  test('a test that failed in the main run and passed in a re-run flipped; one that failed every time did not', () => {
    const l = open();
    run(l, 'r1', [['a.js', 'flips', F, 'main'], ['a.js', 'flips', P, 'rerun-1'], ['a.js', 'broken', F, 'main'], ['a.js', 'broken', F, 'rerun-1'], ['a.js', 'fine', P, 'main']]);
    const r = flakeRates(open(), {});
    assert.deepEqual(r.tests.map((t) => [t.name, t.flips, t.runsSeen, t.rate]), [['flips', 1, 1, 1]]);
    assert.equal(r.runsConsidered, 1);
  });

  test('the rate is flips over the runs the test was seen in, so a test that usually passes reads low', () => {
    const l = open();
    run(l, 'r1', [['a.js', 'x', P, 'main']]);
    run(l, 'r2', [['a.js', 'x', F, 'main'], ['a.js', 'x', P, 'rerun-1']]);
    run(l, 'r3', [['a.js', 'x', P, 'main']]);
    run(l, 'r4', [['a.js', 'x', P, 'main']]);
    const t = flakeRates(open(), { includeStable: true }).tests[0];
    assert.deepEqual([t.runsSeen, t.flips, t.rate], [4, 1, 0.25]);
    assert.equal(t.lastFlipAt, '2026-11-13T10:02:00.000Z');
  });

  test('only the last N runs the test was in count (a window), not its whole history', () => {
    const l = open();
    run(l, 'old1', [['a.js', 'x', F, 'main'], ['a.js', 'x', P, 'rerun-1']]);
    run(l, 'old2', [['a.js', 'x', F, 'main'], ['a.js', 'x', P, 'rerun-1']]);
    for (let i = 0; i < 3; i += 1) run(l, `new${i}`, [['a.js', 'x', P, 'main']]);
    assert.equal(flakeRates(open(), { window: 3, includeStable: true }).tests[0].flips, 0);
    assert.equal(flakeRates(open(), { window: 5, includeStable: true }).tests[0].flips, 2);
  });

  test('a run that did not finish says nothing about flipping and is not counted', () => {
    const l = open();
    run(l, 'crashed', [['a.js', 'x', F, 'main'], ['a.js', 'x', P, 'rerun-1']], { finish: false });
    run(l, 'ok', [['a.js', 'x', P, 'main']]);
    const r = flakeRates(open(), { includeStable: true });
    assert.equal(r.runsConsidered, 1);
    assert.equal(r.tests[0].runsSeen, 1);
    assert.equal(r.tests[0].flips, 0);
  });

  test('a test that only ever SKIPPED was never seen: skipped results do not count as runs', () => {
    const l = open();
    run(l, 'r1', [['a.js', 'skipper', 'skipped', 'main'], ['a.js', 'sometimes', P, 'main']]);
    run(l, 'r2', [['a.js', 'sometimes', 'skipped', 'main']]);
    run(l, 'r3', [['a.js', 'sometimes', F, 'main'], ['a.js', 'sometimes', P, 'rerun-1']]);
    const all = flakeRates(open(), { includeStable: true }).tests;
    assert.deepEqual(all.map((t) => t.name), ['sometimes'], 'the test that only skipped is not listed at all');
    assert.deepEqual([all[0].runsSeen, all[0].flips], [2, 1], 'a skipped run is not a run it was seen in');
  });

  test('skipped results say nothing either; the same name in two files is two tests; stable tests are listed only on request', () => {
    const l = open();
    run(l, 'r1', [['a.js', 'x', 'skipped', 'main'], ['a.js', 'x', F, 'main'], ['a.js', 'x', P, 'rerun-1'], ['b.js', 'x', P, 'main']]);
    assert.deepEqual(flakeRates(open(), {}).tests.map((t) => t.spec), ['a.js']);
    assert.deepEqual(flakeRates(open(), { includeStable: true }).tests.map((t) => t.spec).sort(), ['a.js', 'b.js']);
  });

  test('the worst offenders come first: by rate, then by how many flips, whatever the names', () => {
    const l = open();
    // names chosen so that alphabetical order is the WRONG order
    run(l, 'r1', [['a.js', 'aaa-rare', F, 'main'], ['a.js', 'aaa-rare', P, 'rerun-1'], ['a.js', 'zzz-often', F, 'main'], ['a.js', 'zzz-often', P, 'rerun-1'], ['a.js', 'bbb-once', F, 'main'], ['a.js', 'bbb-once', P, 'rerun-1']]);
    run(l, 'r2', [['a.js', 'aaa-rare', P, 'main'], ['a.js', 'zzz-often', F, 'main'], ['a.js', 'zzz-often', P, 'rerun-1'], ['a.js', 'bbb-once', F, 'main'], ['a.js', 'bbb-once', P, 'rerun-1']]);
    run(l, 'r3', [['a.js', 'aaa-rare', P, 'main'], ['a.js', 'zzz-often', F, 'main'], ['a.js', 'zzz-often', P, 'rerun-1'], ['a.js', 'bbb-once', P, 'main']]);
    run(l, 'r4', [['a.js', 'aaa-rare', P, 'main'], ['a.js', 'zzz-often', P, 'main']]);
    // zzz-often 3/4, bbb-once 2/3 (not in r4), aaa-rare 1/4
    assert.deepEqual(flakeRates(open(), {}).tests.map((t) => [t.name, t.flips, t.runsSeen]), [['zzz-often', 3, 4], ['bbb-once', 2, 3], ['aaa-rare', 1, 4]]);
  });

  test('equal rates are ordered by flips, then by name', () => {
    const l = open();
    run(l, 'r1', [['a.js', 'aaa', F, 'main'], ['a.js', 'aaa', P, 'rerun-1'], ['a.js', 'zzz', F, 'main'], ['a.js', 'zzz', P, 'rerun-1']]);
    run(l, 'r2', [['a.js', 'zzz', F, 'main'], ['a.js', 'zzz', P, 'rerun-1']]);
    // both flipped every time they were seen (rate 1): zzz has 2 flips, aaa has 1
    assert.deepEqual(flakeRates(open(), {}).tests.map((t) => [t.name, t.rate, t.flips]), [['zzz', 1, 2], ['aaa', 1, 1]]);
  });

  test('an empty or missing ledger has no tests and no error', () => {
    assert.deepEqual(flakeRates(openLedger({ dir: path.join(work, 'none') }), {}), { window: 20, runsConsidered: 0, tests: [] });
  });
});

describe('what the review of slice 2 found in the views', () => {
  const runWith = (l, id, events, { end = { exit: 0, complete: true } } = {}) => {
    clock += 60 * 1000;
    l.record(id, 'run.start', START);
    for (const [spec, name, status, phase, extra] of events) l.record(id, 'test.result', { spec, name, status, phase, ...(extra || {}) });
    if (end) l.record(id, 'run.end', end);
  };

  test('a run id used twice leaves two runs in one file, and they are not read as one: no flip across runs', () => {
    const l = open();
    runWith(l, 'same-second', [['a.js', 'login', P, 'main']]);
    runWith(l, 'same-second', [['a.js', 'login', F, 'main']]);
    const runs = open().readAllRuns({ types: ['test.result'] });
    assert.deepEqual(runs.map((r) => [r.runId, r.events.filter((e) => e.type === 'test.result').length, r.complete]), [['same-second', 1, true], ['same-second', 1, true]]);
    const r = flakeRates(open(), { includeStable: true });
    assert.deepEqual([r.runsConsidered, r.tests[0].runsSeen, r.tests[0].flips], [2, 2, 0], 'two runs that each saw one status are not a flip');
  });

  test('two tests that share a title and disagree in the SAME phase are not a flip; a pass in the main run and a fail in a re-run is', () => {
    const l = open();
    runWith(l, 'dup', [['a.js', 'same title', P, 'main'], ['a.js', 'same title', F, 'main']]);
    assert.equal(flakeRates(open(), { includeStable: true }).tests[0].flips, 0);
    runWith(l, 'real', [['a.js', 'same title', P, 'main'], ['a.js', 'same title', F, 'rerun-1']]);
    assert.equal(flakeRates(open(), { includeStable: true }).tests[0].flips, 1);
  });

  test('the runner\'s own "flaky" mark (it passed after retries) is a flip even when every phase passed', () => {
    const l = open();
    runWith(l, 'retry', [['a.js', 'retried', P, 'main', { flaky: true }], ['a.js', 'retried', P, 'rerun-1']]);
    const t = flakeRates(open(), {}).tests;
    assert.deepEqual(t.map((x) => [x.name, x.flips]), [['retried', 1]]);
  });

  test('a run that ended without completing (an exception, no trustworthy main run) is not counted, though it has a run.end', () => {
    const l = open();
    runWith(l, 'failed-run', [['a.js', 'x', F, 'main']], { end: { exit: 3, complete: false } });
    runWith(l, 'good-run', [['a.js', 'x', P, 'main']]);
    const r = flakeRates(open(), { includeStable: true });
    assert.deepEqual([r.runsConsidered, r.tests[0].runsSeen], [1, 1]);
  });

  test('lastFlipAt is the LAST flip, not the first', () => {
    const l = open();
    for (const id of ['f1', 'f2', 'f3']) runWith(l, id, [['a.js', 'x', F, 'main'], ['a.js', 'x', P, 'rerun-1']]);
    const t = flakeRates(open(), {}).tests[0];
    assert.equal(t.flips, 3);
    assert.equal(t.lastFlipAt, '2026-11-13T10:03:00.000Z');
  });

  test('the same title in two files whose names run together (a.js + "xy" against a.jsx + "y") are two tests', () => {
    const l = open();
    runWith(l, 'k', [['a.js', 'xy', F, 'main'], ['a.js', 'xy', P, 'rerun-1'], ['a.jsx', 'y', P, 'main']]);
    assert.deepEqual(flakeRates(open(), { includeStable: true }).tests.map((t) => [t.spec, t.name, t.flips]).sort(), [['a.js', 'xy', 1], ['a.jsx', 'y', 0]]);
  });

  test('runs are ordered by when they STARTED, not by their last event', () => {
    const l = open();
    clock = T0;
    l.record('early', 'run.start', START);
    clock = T0 + 60 * 1000;
    l.record('late', 'run.start', START);
    clock = T0 + 120 * 1000;
    l.record('late', 'run.end', { exit: 0, complete: true });
    clock = T0 + 180 * 1000;
    l.record('early', 'run.end', { exit: 0, complete: true }); // the early run FINISHED last
    assert.deepEqual(open().readAllRuns().map((r) => r.runId), ['early', 'late']);
  });

  test('readAllRuns keeps only the types asked for (and run.start/run.end, which tell runs apart), and events before a run.start are a run of their own', () => {
    const l = open();
    l.record('orphan', 'heal.begin', { branch: 'qa/heal-o', baseSha: 'abc' });
    runWith(l, 'full', [['a.js', 'x', P, 'main']]);
    const kept = open().readAllRuns({ types: ['heal.begin'] });
    assert.deepEqual(kept.map((r) => [r.runId, r.events.map((e) => e.type)]), [['orphan', ['heal.begin']], ['full', ['run.start', 'run.end']]]);
  });

  test('a heal.begin with no tokens is still listed as unfinished, with an empty token list', () => {
    const l = open();
    l.record('r', 'heal.begin', { branch: 'qa/heal-r', baseSha: 'abc' });
    assert.deepEqual(staleHeals(open()).map((h) => h.tokens), [[]]);
  });

  test('one heal is one attempt, even if its record names a token twice; the window edge is inclusive', () => {
    const l = open();
    clock = T0 - 7 * DAY_MS;
    l.record('r', 'heal.begin', { branch: 'qa/heal-r', baseSha: 'abc', tokens: ['qafp000000000001', 'qafp000000000001'] });
    assert.equal(healAttempts(open(), { sinceMs: T0 - 7 * DAY_MS, tokens: ['qafp000000000001'] }).qafp000000000001, 1, 'exactly on the edge still counts, and once');
    assert.equal(healAttempts(open(), { sinceMs: T0 - 7 * DAY_MS + 1, tokens: ['qafp000000000001'] }).qafp000000000001, 0, 'a millisecond later it is outside the window');
  });

  test('a run file over 16 MB is still read: its heal.begin counts, and the cap is not silently blind to a busy run', { timeout: 60000 }, () => {
    const l = open();
    l.record('big', 'run.start', START);
    l.record('big', 'heal.begin', { branch: 'qa/heal-big', baseSha: 'abc', tokens: ['qafp000000000001'] });
    const file = path.join(dir, 'runs', fs.readdirSync(path.join(dir, 'runs'))[0]);
    const line = JSON.stringify({ v: 1, ts: '2026-11-13T10:00:00.000Z', runId: 'big', type: 'test.result', spec: 's'.repeat(80), name: 'n'.repeat(80), status: 'passed', phase: 'main' }) + '\n';
    fs.appendFileSync(file, line.repeat(Math.ceil((17 * 1024 * 1024) / line.length)));
    assert.ok(fs.statSync(file).size > 16 * 1024 * 1024);
    assert.equal(healAttempts(open(), { sinceMs: 0, tokens: ['qafp000000000001'] }).qafp000000000001, 1);
    assert.equal(staleHeals(open()).length, 1, 'and its unfinished heal is still reported');
    assert.match(open().readRun('big').warnings.join('\n'), /larger than/, 'the whole-file reader still refuses it; the views do not rely on it');
  });

  test('a line too long to be a record is skipped with a warning, and the lines after it are read', () => {
    const l = open();
    l.record('long', 'run.start', START);
    const file = path.join(dir, 'runs', fs.readdirSync(path.join(dir, 'runs'))[0]);
    fs.appendFileSync(file, `${'x'.repeat(2 * 1024 * 1024)}\n`);
    l.record('long', 'heal.begin', { branch: 'qa/heal-long', baseSha: 'abc', tokens: ['qafp000000000001'] });
    const [run] = open().readAllRuns({ types: ['heal.begin'] });
    assert.deepEqual(run.events.map((e) => e.type), ['run.start', 'heal.begin']);
    assert.match(run.warnings.join('\n'), /1 line longer than 1048576 bytes skipped/);
  });

  test('a line only just over the limit (it arrives complete inside one buffer, not as a growing remainder) is skipped too', () => {
    const l = open();
    l.record('edge', 'run.start', START);
    const file = path.join(dir, 'runs', fs.readdirSync(path.join(dir, 'runs'))[0]);
    fs.appendFileSync(file, `${'y'.repeat(1024 * 1024 + 100 * 1024)}\n`); // 1.1 MB: over the 1 MB limit, under the 1.25 MB a full buffer can hold
    l.record('edge', 'heal.begin', { branch: 'qa/heal-edge', baseSha: 'abc', tokens: ['qafp000000000001'] });
    const [run] = open().readAllRuns({ types: ['heal.begin'] });
    assert.deepEqual(run.events.map((e) => e.type), ['run.start', 'heal.begin']);
    assert.match(run.warnings.join('\n'), /1 line longer than 1048576 bytes skipped/);
  });

  test('the streaming reader skips a torn last line and reads a UTF-8 name that straddles a chunk boundary', () => {
    const l = open();
    l.record('u', 'run.start', START);
    const file = path.join(dir, 'runs', fs.readdirSync(path.join(dir, 'runs'))[0]);
    const pad = JSON.stringify({ v: 1, ts: '2026-11-13T10:00:00.000Z', runId: 'u', type: 'test.result', spec: 's', name: 'é'.repeat(70), status: 'passed', phase: 'main' }) + '\n';
    fs.appendFileSync(file, pad.repeat(Math.ceil((300 * 1024) / pad.length)));
    fs.appendFileSync(file, '{"v":1,"ts"');
    const [run] = open().readAllRuns({ types: ['test.result'] });
    const names = new Set(run.events.filter((e) => e.type === 'test.result').map((e) => e.name));
    assert.deepEqual([...names], ['é'.repeat(70)], 'no name was cut in the middle of a character');
    assert.deepEqual(run.warnings, [], 'a filtered read cannot know the type of a line it could not parse, so it says nothing about it');
    assert.match(open().readAllRuns()[0].warnings.join('\n'), /torn final line/, 'the unfiltered read reports it');
  });
});

describe('heal attempts and stale heals', () => {
  const begin = (l, id, tokens, branch = `qa/heal-${id}`) => l.record(id, 'heal.begin', { branch, baseSha: 'abc12345', tokens });
  const end = (l, id, outcome, branch = `qa/heal-${id}`) => l.record(id, 'heal.end', { branch, outcome });

  test('attempts are counted per failure token across runs, inside the window only', () => {
    const l = open();
    clock = T0 - 10 * DAY_MS; begin(l, 'old', ['qafp000000000001']); end(l, 'old', 'reverted');
    clock = T0 - 2 * DAY_MS; begin(l, 'r1', ['qafp000000000001', 'qafp000000000002']); end(l, 'r1', 'kept');
    clock = T0; begin(l, 'r2', ['qafp000000000001']); end(l, 'r2', 'reverted');
    const counts = healAttempts(open(), { sinceMs: T0 - 7 * DAY_MS, tokens: ['qafp000000000001', 'qafp000000000002', 'qafp000000000003'] });
    assert.deepEqual(counts, { qafp000000000001: 2, qafp000000000002: 1, qafp000000000003: 0 });
  });

  test('a heal that began and never ended still counts: the crash used the attempt', () => {
    const l = open();
    begin(l, 'died', ['qafp000000000001']);
    assert.equal(healAttempts(open(), { sinceMs: 0, tokens: ['qafp000000000001'] }).qafp000000000001, 1);
  });

  test('a heal.begin with no tokens counts for nothing, and an unknown token is never added to the answer', () => {
    const l = open();
    l.record('r', 'heal.begin', { branch: 'qa/heal-r', baseSha: 'abc' });
    begin(l, 'r2', ['qafp00000000000f']);
    assert.deepEqual(healAttempts(open(), { sinceMs: 0, tokens: ['qafp000000000001'] }), { qafp000000000001: 0 });
  });

  test('a heal that never ended is reported as stale, with its branch and base; one that ended is not', () => {
    const l = open();
    begin(l, 'done', ['qafp000000000001']); end(l, 'done', 'kept');
    begin(l, 'died', ['qafp000000000002']);
    begin(l, 'reverted', ['qafp000000000003']); end(l, 'reverted', 'reverted');
    const stale = staleHeals(open());
    assert.deepEqual(stale.map((s) => [s.runId, s.branch, s.baseSha, s.tokens]), [['died', 'qa/heal-died', 'abc12345', ['qafp000000000002']]]);
  });

  test('an end for a different branch does not close a begin', () => {
    const l = open();
    begin(l, 'r', ['qafp000000000001'], 'qa/heal-one');
    end(l, 'r', 'kept', 'qa/heal-other');
    assert.equal(staleHeals(open()).length, 1);
  });
});

describe('the heal journal', () => {
  test('begin and end become heal.begin and heal.end in the run, attempts read the window, and the settings are carried', () => {
    const l = open();
    const j = healJournal({ ledger: l, runId: 'r1', maxAttempts: 2, windowDays: 7, now: () => clock });
    assert.deepEqual([j.maxAttempts, j.windowDays], [2, 7]);
    j.begin({ branch: 'qa/heal-r1', baseSha: 'abc', tokens: ['qafp000000000001'] });
    j.end({ branch: 'qa/heal-r1', outcome: 'kept' });
    assert.deepEqual(open().readRun('r1').events.map((e) => e.type), ['heal.begin', 'heal.end']);
    assert.equal(j.attempts(['qafp000000000001']).qafp000000000001, 1);
  });

  test('a ledger that cannot be written to is a warning, never an exception: bookkeeping must not change what a heal does', () => {
    const warnings = [];
    fs.mkdirSync(path.join(dir, 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'VERSION'), '9\n'); // a newer layout: every write refuses
    const j = healJournal({ ledger: open(), runId: 'r1', maxAttempts: 1, windowDays: 7, warn: (m) => warnings.push(m) });
    assert.doesNotThrow(() => { j.begin({ branch: 'qa/heal-r1', baseSha: 'abc', tokens: [] }); j.end({ branch: 'qa/heal-r1', outcome: 'kept' }); });
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /^ledger: /);
  });
});

describe('when a run is recorded', () => {
  const cfg = (obj) => { const f = path.join(work, 'qa-config.json'); fs.writeFileSync(f, JSON.stringify(obj)); return f; };

  test('not at all unless the project asks: no config, a config without a ledger block, and a block-less flag set', () => {
    assert.equal(enabledLedger({ configPath: cfg({}), env: {} }), null);
    assert.equal(enabledLedger({ configPath: cfg({ triage: {} }), env: {} }), null);
    assert.equal(fs.existsSync(path.join(work, '.qa-ledger')), false);
  });

  test('a ledger block, even an empty one, turns it on (beside the config file); --ledger-dir alone turns it on too', () => {
    assert.equal(enabledLedger({ configPath: cfg({ ledger: {} }), env: {} }).ledger.dir, path.join(work, '.qa-ledger'));
    assert.equal(enabledLedger({ configPath: cfg({ ledger: { dir } }), env: {} }).ledger.dir, dir);
    assert.equal(enabledLedger({ configPath: cfg({}), env: {}, ledgerDir: dir }).ledger.dir, dir);
  });

  test('a project that HAS a ledger cannot be diverted from it by a flag: the heal attempt cap lives there, and a flag may not lift it', () => {
    const c = cfg({ ledger: { dir } });
    assert.equal(enabledLedger({ configPath: c, env: {}, ledgerDir: dir }).ledger.dir, dir, 'naming the same ledger is fine');
    assert.throws(() => enabledLedger({ configPath: c, env: {}, ledgerDir: path.join(work, 'elsewhere') }), /not the ledger .* names .*heal attempt cap/);
  });

  test('a bad ledger block is a usage error naming the key; an empty or odd --ledger-dir is one too', () => {
    assert.throws(() => enabledLedger({ configPath: cfg({ ledger: { retentionDays: 0 } }), env: {} }), /ledger.retentionDays/);
    for (const bad of ['', 'a\nb', 5]) assert.throws(() => enabledLedger({ configPath: cfg({}), env: {}, ledgerDir: bad }), /--ledger-dir needs a folder path/, JSON.stringify(bad));
  });
});

describe('the CLI shows them', () => {
  const stream = () => { const s = { text: '', write(t) { s.text += t; } }; return s; };
  const cli = (...argv) => { const stdout = stream(); const stderr = stream(); const code = cliMain({ argv: [...argv, '--dir', dir], env: {}, stdout, stderr }); return { code, json: stdout.text ? JSON.parse(stdout.text) : null, stderr: stderr.text }; };

  test('flake-rate lists the tests that flipped, --all lists the stable ones, --window narrows', () => {
    const l = open();
    run(l, 'r1', [['a.js', 'x', F, 'main'], ['a.js', 'x', P, 'rerun-1'], ['a.js', 'y', P, 'main']]);
    run(l, 'r2', [['a.js', 'x', P, 'main'], ['a.js', 'y', P, 'main']]);
    const r = cli('flake-rate');
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.data.tests.map((t) => [t.name, t.rate]), [['x', 0.5]]);
    assert.equal(cli('flake-rate', '--all').json.data.tests.length, 2);
    assert.equal(cli('flake-rate', '--window', '1').json.data.tests.length, 0, 'the last run alone had no flip');
  });

  test('status lists a heal that never ended, so a person knows which branch to look for', () => {
    const l = open();
    l.record('died', 'heal.begin', { branch: 'qa/heal-died', baseSha: 'abc123', tokens: ['qafp000000000001'] });
    const s = cli('status').json.data;
    assert.deepEqual(s.staleHeals.map((h) => [h.runId, h.branch]), [['died', 'qa/heal-died']]);
  });

  test('--window must be a whole number from 1 to 1000', () => {
    for (const bad of ['0', '1001', 'x', '1.5']) assert.equal(cli('flake-rate', '--window', bad).code, 2, bad);
  });
});
