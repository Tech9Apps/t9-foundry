'use strict';

// The exit criterion of Phase 3: "killing a run mid-batch and resuming completes without duplicates". A REAL process is SIGKILLed in the window where
// the tracker has committed a create and the process has not heard (so no claim was completed), then a second real process resumes.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fileBackedGithub } = require('./fixtures/file-backed-mock');
const { openLedger } = require('../../scripts/ledger/lib/ledger');
const { cleanEnv } = require('../helpers/node-env');

const CASES_MD = path.join(__dirname, '..', '..', 'demo', 'expected', 'DEMO-101-test-cases.md');
const CHILD = path.join(__dirname, 'fixtures', 'post-and-die.js');
const N = 10;

function setup() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-kill-'));
  const stateFile = path.join(dir, 'tracker-state.json');
  const mock = fileBackedGithub(stateFile);
  const parent = mock.seedTicket({ title: 'DEMO-101: Apply a discount code', description: 'story', acceptance: '1. a' });
  mock.save();
  const config = path.join(dir, 'qa-config.json');
  fs.writeFileSync(config, JSON.stringify({ ticketSource: { type: 'github', github: mock.settings }, ledger: { dir: path.join(dir, 'ledger') } }));
  fs.copyFileSync(CASES_MD, path.join(dir, 'DEMO-101.md'));
  const args = ['--parent', parent, '--cases', path.join(dir, 'DEMO-101.md'), '--keys-file', path.join(dir, 'keys.json'), '--config', config, '--run-id', 'kill-run'];
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const titles = () => state().created.map((n) => state().issues.find(([k]) => Number(k) === n)[1].body.match(/qa-harness-key:(\S+)/)[1]);
  return { dir, stateFile, args, ledger: path.join(dir, 'ledger'), state, titles };
}

function child(w, dieAfter, extra = []) {
  const proc = spawn(process.execPath, [CHILD, w.stateFile, String(dieAfter), ...w.args, ...extra], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  return new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal, out, err, json: out.trim() ? JSON.parse(out) : null })));
}

describe('a run killed mid-batch, then resumed', { timeout: 120000 }, () => {
  test('the case whose create was committed but never heard is adopted, not created again: ten cases on the tracker, each exactly once', { skip: process.platform === 'win32' }, async () => {
    const w = setup();
    const killed = await child(w, 4);
    assert.deepEqual([killed.signal, killed.code], ['SIGKILL', null], `it died by SIGKILL, mid-batch (stderr: ${killed.err})`);
    assert.equal(w.titles().length, 4, 'the tracker had four cases by then, the fourth never acknowledged');

    // what the ledger knows: three finished, and one claimed by a process that no longer exists
    const l = openLedger({ dir: w.ledger });
    const inFlight = l.status().keys.inFlight;
    assert.equal(inFlight.length, 1);
    assert.deepEqual([inFlight[0].runId, inFlight[0].ownerAlive], ['kill-run', false], 'in flight, owner dead: the signal a resume acts on');
    assert.equal(l.status().keys.byState.done, 3);

    const resumed = await child(w, 0);
    assert.equal(resumed.code, 0, `${resumed.out} ${resumed.err}`);
    assert.equal(resumed.json.total, N);
    const byId = Object.fromEntries(resumed.json.tests.map((t) => [t.tcId, t]));
    assert.deepEqual(resumed.json.tests.filter((t) => t.fromLedger).map((t) => t.tcId), ['TC-001', 'TC-002', 'TC-003'], 'the three that finished come from the ledger');
    assert.deepEqual([byId['TC-004'].status, byId['TC-004'].resumed, byId['TC-004'].fromLedger], ['deduplicated', true, undefined], 'the fourth was resumed and adopted by its marker');
    assert.equal(resumed.json.created, N - 4, 'only the six that never reached the tracker were created');

    const keys = w.titles();
    assert.equal(keys.length, N, 'ten cases on the tracker');
    assert.equal(new Set(keys).size, N, 'every idempotency key exactly once: no duplicate');
    assert.equal(openLedger({ dir: w.ledger }).status().keys.byState.done, N);
    assert.deepEqual(openLedger({ dir: w.ledger }).status().keys.inFlight, []);

    const again = await child(w, 0);
    assert.equal(again.code, 0);
    assert.ok(again.json.tests.every((t) => t.fromLedger), 'a further run changes nothing');
    assert.equal(w.titles().length, N);
  });

  test('killed at the very first create, and again during the resume: still ten, still once each', { skip: process.platform === 'win32' }, async () => {
    const w = setup();
    assert.equal((await child(w, 1)).signal, 'SIGKILL');
    assert.equal((await child(w, 3)).signal, 'SIGKILL', 'the resume itself is killed, after the 3rd create it made');
    const done = await child(w, 0);
    assert.equal(done.code, 0, `${done.out} ${done.err}`);
    const keys = w.titles();
    assert.equal(keys.length, N);
    assert.equal(new Set(keys).size, N);
  });

  test('without a ledger the same kill is survived too (the adapter\'s marker), which is why the ledger can only ever add to it', { skip: process.platform === 'win32' }, async () => {
    const w = setup();
    const cfg = JSON.parse(fs.readFileSync(w.args[w.args.indexOf('--config') + 1], 'utf8'));
    delete cfg.ledger;
    fs.writeFileSync(w.args[w.args.indexOf('--config') + 1], JSON.stringify(cfg));
    assert.equal((await child(w, 4)).signal, 'SIGKILL');
    const resumed = await child(w, 0);
    assert.equal(resumed.code, 0, resumed.out);
    assert.equal(new Set(w.titles()).size, N);
    assert.equal(w.titles().length, N);
    assert.equal(fs.existsSync(w.ledger), false);
  });
});
