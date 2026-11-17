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

  test('a ledger block, even an empty one, turns it on; --ledger-dir turns it on and beats the configured dir; --no-ledger beats both', () => {
    const empty = enabledLedger({ configPath: cfg({ ledger: {} }), env: {} });
    assert.equal(empty.ledger.dir, path.resolve('.qa-ledger'));
    assert.equal(enabledLedger({ configPath: cfg({ ledger: { dir } }), env: {} }).ledger.dir, dir);
    assert.equal(enabledLedger({ configPath: cfg({}), env: {}, ledgerDir: dir }).ledger.dir, dir);
    assert.equal(enabledLedger({ configPath: cfg({ ledger: { dir: '/elsewhere' } }), env: {}, ledgerDir: dir }).ledger.dir, dir);
    assert.equal(enabledLedger({ configPath: cfg({ ledger: { dir } }), env: {}, noLedger: true }), null);
  });

  test('--ledger-dir with --no-ledger is a usage error; a bad ledger block is too, unless --no-ledger skips it', () => {
    assert.throws(() => enabledLedger({ configPath: cfg({}), env: {}, ledgerDir: dir, noLedger: true }), /contradict/);
    assert.throws(() => enabledLedger({ configPath: cfg({ ledger: { retentionDays: 0 } }), env: {} }), /ledger.retentionDays/);
    assert.equal(enabledLedger({ configPath: cfg({ ledger: { retentionDays: 0 } }), env: {}, noLedger: true }), null);
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
