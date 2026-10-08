'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main, STEPS } = require('../../scripts/triage/plan');
const { classify } = require('../../scripts/triage/classify');
const { createAdapter, run: callAdapter } = require('../../scripts/tracker/adapters');
const { MOCKS } = require('../tracker/workspace');
const { assertValidInput } = require('../tracker/helpers');

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-plan-'));

// ── realistic reports, built by the real classifier from visible runs ────────────────────────────
const E = (message, kind = 'failure', details = '') => ({ kind, message, details });
const T = (name, status, error, extra = {}) => ({ name, status, ...(error ? { error } : {}), ...extra });
const R = (...tests) => ({ format: 'junit', totals: {}, tests });
const failing = (name, error, extra = {}) => T(name, 'failed', error, extra);
const ids = (n) => ({ ticket: 'DEMO-101', caseId: `TC-00${n}` });
const ASSERT = E('a second application of the code should be rejected');

// a test that fails the same way every time → product-bug, PRD-1, act
const productBug = (n = 5, msg = ASSERT) => [R(failing(`DEMO-101/TC-00${n}: x`, msg, ids(n))), R(failing(`DEMO-101/TC-00${n}: x`, msg, ids(n))), R(failing(`DEMO-101/TC-00${n}: x`, msg, ids(n)))];
const report = (runs, opts) => classify({ runs, ...opts });
const tokenOf = (rep, n = 0) => rep.verdicts[n].token;

async function plan(type, rep, { mock = MOCKS[type](), args = [], env, fetch, now } = {}) {
  const cfg = path.join(dir, `${type}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ ticketSource: { type, [type]: mock.settings } }));
  const file = path.join(dir, `report-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ ok: true, data: rep }));
  let out = ''; let err = '';
  const code = await main({
    argv: ['--report', file, '--config', cfg, '--base-url', mock.baseUrl, '--run-id', 'run42', ...args],
    env: env || { [mock.tokenEnv]: mock.token }, fetch: fetch || mock.fetch, ...(now ? { now } : {}),
    stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
  });
  return { code, err, json: out ? JSON.parse(out) : null, mock, cfg };
}
// file a bug the way the orchestrator would: with the fingerprint marker in the body
async function seedBug(type, mock, token, { title = '[BUG] Second code accepted', close = false, inTitleOnly = false } = {}) {
  const adapter = createAdapter(type, { settings: mock.settings, env: { [mock.tokenEnv]: mock.token }, fetch: mock.fetch, baseUrl: mock.baseUrl, timeoutMs: 500, retryDelayMs: 0 });
  const created = await callAdapter(adapter, 'create-bug', { title: inTitleOnly ? `${title} ${token}` : title, body: `Steps: apply BREW10 twice.\n\nqa-harness-fingerprint: ${inTitleOnly ? 'none' : token}`, priority: 'High' });
  if (close) mock.closeItem(created.id);
  return created;
}
const stepOf = (r, n = 0) => r.json.data.actions[n];

for (const type of Object.keys(MOCKS)) {
  describe(`plan: ${type}`, () => {
    test('an OPEN report with this fingerprint → comment on it (a valid comment input, not a new bug)', async () => {
      const mock = MOCKS[type]();
      const rep = report(productBug());
      const bug = await seedBug(type, mock, tokenOf(rep));
      const before = mock.createdItems().length;
      const r = await plan(type, rep, { mock });
      assert.equal(r.code, 0, r.err);
      const a = stepOf(r);
      assert.equal(a.step, 'comment-existing');
      assert.equal(a.existing.id, bug.id);
      assertValidInput('comment', a.commentInput);
      assert.equal(a.commentInput.id, bug.id);
      assert.match(a.commentInput.body, new RegExp(tokenOf(rep)));
      assert.equal(a.commentInput.idempotencyKey, `fp-${rep.verdicts[0].fingerprint}-run42-comment`);
      assert.equal(mock.createdItems().length, before, 'planning writes nothing');
    });

    test('only a CLOSED report matches → file a NEW bug that links it (a regression, not a duplicate)', async () => {
      const mock = MOCKS[type]();
      const rep = report(productBug());
      const old = await seedBug(type, mock, tokenOf(rep), { close: true });
      const a = stepOf(await plan(type, rep, { mock }));
      assert.equal(a.step, 'file-regression');
      assert.equal(a.regressionOf.id, old.id);
      assert.equal(a.idempotencyKey, `fp-${rep.verdicts[0].fingerprint}-run42`);
      assert.equal(a.marker, `qa-harness-fingerprint: ${tokenOf(rep)}`);
    });

    test('an open AND a closed report: the open one gets the comment', async () => {
      const mock = MOCKS[type]();
      const rep = report(productBug());
      await seedBug(type, mock, tokenOf(rep), { close: true, title: '[BUG] Old report' });
      const live = await seedBug(type, mock, tokenOf(rep), { title: '[BUG] Live report' });
      const a = stepOf(await plan(type, rep, { mock }));
      assert.equal(a.step, 'comment-existing');
      assert.equal(a.existing.id, live.id);
    });

    test('nothing matches → file-bug, with the marker to include and a run-scoped idempotency key', async () => {
      const rep = report(productBug());
      const a = stepOf(await plan(type, rep));
      assert.equal(a.step, 'file-bug');
      assert.equal(a.marker, `qa-harness-fingerprint: ${tokenOf(rep)}`);
      assert.match(a.idempotencyKey, /^[A-Za-z0-9._-]{1,80}$/);
      assert.deepEqual(a.lookup, { open: [], closed: [] });
    });

    test('a search hit whose BODY lacks the token (it was only in the title) does not count', async () => {
      const mock = MOCKS[type]();
      const rep = report(productBug());
      await seedBug(type, mock, tokenOf(rep), { inTitleOnly: true });
      assert.equal(stepOf(await plan(type, rep, { mock })).step, 'file-bug');
    });
  });
}

describe('plan: behavior that does not depend on the tracker', () => {
  test('GitHub search lags writes: a fresh bug is NOT found (the documented limit), and is once the index catches up', async () => {
    const mock = MOCKS.github();
    mock.state.searchLag = true;
    const rep = report(productBug());
    await seedBug('github', mock, tokenOf(rep));
    assert.equal(stepOf(await plan('github', rep, { mock })).step, 'file-bug', 'a duplicate is possible while the index lags');
    mock.settle();
    assert.equal(stepOf(await plan('github', rep, { mock })).step, 'comment-existing');
  });

  test('two failures with the same fingerprint in one run: one bug covers both', async () => {
    const both = () => R(failing('DEMO-101/TC-001: a', ASSERT, ids(1)), failing('DEMO-101/TC-002: b', ASSERT, ids(2)));
    const rep = report([both(), both(), both()]);
    const fp = rep.verdicts.map((v) => v.fingerprint);
    assert.notEqual(fp[0], fp[1], 'different tests have different fingerprints, so this scenario needs a forced collision');
    rep.verdicts[1].fingerprint = rep.verdicts[0].fingerprint; rep.verdicts[1].token = rep.verdicts[0].token;
    const r = await plan('github', rep);
    assert.deepEqual(r.json.data.actions.map((a) => a.step), ['file-bug', 'duplicate-in-run']);
    assert.equal(r.json.data.actions[1].duplicateOf, rep.verdicts[0].key);
  });

  test('a tracker failure degrades the plan with a warning; it does not stop it', async () => {
    const mock = MOCKS.github();
    mock.inject({ method: 'GET', match: '/search/issues', status: 500, times: 99 });
    const a = await plan('github', report(productBug()), { mock });
    assert.equal(a.code, 0);
    assert.equal(stepOf(a).step, 'file-bug');
    assert.match(stepOf(a).note, /not checked \(failed: UPSTREAM_ERROR\)/);
    assert.match(a.json.data.warnings[0], /existing report could not be ruled out/);
  });

  test('no credentials: still plans, says duplicates cannot be ruled out, and touches the tracker not at all', async () => {
    const mock = MOCKS.github();
    const r = await plan('github', report(productBug()), { mock, env: {} });
    assert.equal(r.code, 0);
    assert.match(r.json.data.warnings[0], /no tracker lookup/);
    assert.equal(stepOf(r).step, 'file-bug');
    assert.equal(mock.calls.length, 0);
  });

  test('a report with no product bug needs no tracker and no credentials', async () => {
    const rep = report([R(failing('t', E('connect ECONNREFUSED 127.0.0.1:1', 'error'))), R(failing('t', E('connect ECONNREFUSED 127.0.0.1:1', 'error')))]);
    const mock = MOCKS.github();
    const r = await plan('github', rep, { mock, env: {} });
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.data.warnings, []);
    assert.equal(mock.calls.length, 0);
  });

  test('each class maps to its step: flaky and environment are reported, test-bug is only proposed, undetermined is proposed', async () => {
    const flaky = report([R(failing('f', ASSERT)), R(T('f', 'passed'))]);
    const env = report([R(failing('e', E('connect ECONNREFUSED 127.0.0.1:1', 'error'))), R(failing('e', E('connect ECONNREFUSED 127.0.0.1:1', 'error')))]);
    const crash = E('TypeError: x is not a function', 'error', 'at run (/work/tests/a.test.js:3:3)');
    const testBug = report([R(failing('t', crash)), R(failing('t', crash))]);
    const und = report([R(failing('u', E('Timeout 30000ms exceeded.', 'timeout'))), R(failing('u', E('Timeout 30000ms exceeded.', 'timeout')))]);
    const steps = {};
    for (const [name, rep] of Object.entries({ flaky, env, testBug, und })) steps[name] = stepOf(await plan('github', rep, { env: {} })).step;
    assert.deepEqual(steps, { flaky: 'report-flaky', env: 'report-environment', testBug: 'propose-test-fix', und: 'propose' });
  });

  test('a low-confidence product bug (no re-run) is only PROPOSED, and still shows what the tracker holds', async () => {
    const mock = MOCKS.github();
    const rep = report([R(failing('DEMO-101/TC-005: x', ASSERT, ids(5)))]);
    const old = await seedBug('github', mock, tokenOf(rep));
    const a = stepOf(await plan('github', rep, { mock }));
    assert.equal(a.step, 'propose');
    assert.equal(a.lookup.open[0].id, old.id);
    assert.equal(a.commentInput, undefined);
    assert.equal(a.idempotencyKey, undefined);
  });

  test('planning is read-only: no issue is created and no comment is posted', async () => {
    const mock = MOCKS.github();
    const rep = report(productBug());
    const bug = await seedBug('github', mock, tokenOf(rep));
    const before = JSON.stringify([mock.createdItems(), mock.commentsOn(bug.id)]);
    const callsBefore = mock.calls.length; // seeding above used POSTs; only what planning does matters
    await plan('github', rep, { mock });
    assert.equal(JSON.stringify([mock.createdItems(), mock.commentsOn(bug.id)]), before);
    const during = mock.calls.slice(callsBefore);
    assert.ok(during.length > 0, 'planning did consult the tracker');
    assert.ok(during.every((c) => c.method === 'GET'), `only reads: ${during.map((c) => c.method).join(',')}`);
  });

  test('every documented step is produced by some plan, and no plan produces an undocumented one', async () => {
    const flaky = report([R(failing('f', ASSERT)), R(T('f', 'passed'))]);
    const pb = report(productBug());
    const lowPb = report([R(failing('DEMO-101/TC-005: x', ASSERT, ids(5)))]);
    const both = () => R(failing('DEMO-101/TC-001: a', ASSERT, ids(1)), failing('DEMO-101/TC-002: b', ASSERT, ids(2)));
    const dup = report([both(), both(), both()]); dup.verdicts[1].fingerprint = dup.verdicts[0].fingerprint; dup.verdicts[1].token = dup.verdicts[0].token;
    const env = report([R(failing('e', E('connect ECONNREFUSED 127.0.0.1:1', 'error'))), R(failing('e', E('connect ECONNREFUSED 127.0.0.1:1', 'error')))]);
    const crash = E('TypeError: x is not a function', 'error', 'at run (/work/tests/a.test.js:3:3)');
    const tb = report([R(failing('t', crash)), R(failing('t', crash))]);
    const closedMock = MOCKS.github(); await seedBug('github', closedMock, tokenOf(pb), { close: true });
    const openMock = MOCKS.github(); await seedBug('github', openMock, tokenOf(pb));
    const seen = new Set();
    for (const [rep, mock] of [[flaky], [env], [tb], [lowPb], [dup], [pb, closedMock], [pb, openMock]]) {
      for (const a of (await plan('github', rep, mock ? { mock } : {})).json.data.actions) seen.add(a.step);
    }
    for (const step of seen) assert.ok(STEPS.includes(step), `undocumented step: ${step}`);
    for (const step of STEPS) assert.ok(seen.has(step), `no plan produced: ${step}`);
    assert.equal(new Set(STEPS).size, STEPS.length);
  });

  test('keys: same run id → same keys (a retry is safe); a different run id → different keys; long ids are shortened', async () => {
    const rep = report(productBug());
    const k = async (args) => stepOf(await plan('github', rep, { args })).idempotencyKey;
    assert.equal(await k(['--run-id', 'r1']), await k(['--run-id', 'r1']));
    assert.notEqual(await k(['--run-id', 'r1']), await k(['--run-id', 'r2']));
    const long = await k(['--run-id', `${'x'.repeat(200)}!!`]);
    assert.match(long, /^[A-Za-z0-9._-]{1,80}$/);
  });

  test('without --run-id a UTC timestamp id is used', async () => {
    const cfg = path.join(dir, 'c.json');
    const rep = report(productBug());
    const file = path.join(dir, 'r.json');
    fs.writeFileSync(file, JSON.stringify(rep));
    let out = '';
    const mock = MOCKS.github();
    fs.writeFileSync(cfg, JSON.stringify({ ticketSource: { type: 'github', github: mock.settings } }));
    await main({ argv: ['--report', file, '--config', cfg, '--base-url', mock.baseUrl], env: { [mock.tokenEnv]: mock.token }, fetch: mock.fetch, now: () => Date.UTC(2026, 9, 8, 22, 30, 5), stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    assert.equal(JSON.parse(out).data.runId, '20261008T223005Z');
  });
});

describe('plan CLI', () => {
  const cli = async (argv, env = {}) => { let out = ''; let e = ''; const code = await main({ argv, env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { e += s; } } }); return { code, err: e, json: out ? JSON.parse(out) : null }; };

  test('--out and --flaky-out write the plan and the flaky list', async () => {
    const rep = report([R(failing('f', ASSERT)), R(T('f', 'passed'))]);
    const file = path.join(dir, 'flaky-report.json');
    fs.writeFileSync(file, JSON.stringify(rep));
    const out = path.join(dir, 'nested', 'plan.json'); const flakyOut = path.join(dir, 'nested', 'flaky.json');
    const r = await cli(['--report', file, '--run-id', 'r9', '--out', out, '--flaky-out', flakyOut]);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), r.json);
    const flaky = JSON.parse(fs.readFileSync(flakyOut, 'utf8'));
    assert.equal(flaky.runId, 'r9');
    assert.equal(flaky.flaky.length, 1);
    assert.deepEqual(flaky.flaky[0].attempts, [{ run: 0, status: 'failed' }, { run: 1, status: 'passed' }]);
  });

  test('unreadable or wrong input → exit 1 naming the file; bad invocation → exit 2', async () => {
    assert.equal((await cli(['--report', path.join(dir, 'nope.json')])).json.error.code, 'UNREADABLE');
    const bad = path.join(dir, 'bad.json'); fs.writeFileSync(bad, '{"hello":1}');
    assert.match((await cli(['--report', bad])).json.error.message, /no "verdicts" array/);
    for (const argv of [[], ['--bogus'], ['--report'], ['--report', 'x', '--run-id', '!!!']]) assert.equal((await cli(argv)).code, 2, argv.join(' '));
  });
});
