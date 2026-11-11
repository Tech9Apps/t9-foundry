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
const R = (...tests) => ({ format: 'tap', totals: {}, tests });
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
async function seedBug(type, mock, token, { title = '[BUG] Second code accepted', close = false, dismiss = false, inTitleOnly = false } = {}) {
  const adapter = createAdapter(type, { settings: mock.settings, env: { [mock.tokenEnv]: mock.token }, fetch: mock.fetch, baseUrl: mock.baseUrl, timeoutMs: 500, retryDelayMs: 0 });
  const created = await callAdapter(adapter, 'create-bug', { title: inTitleOnly ? `${title} ${token}` : title, body: `Steps: apply BREW10 twice.\n\nqa-harness-fingerprint: ${inTitleOnly ? 'none' : token}`, priority: 'High' });
  if (close) mock.closeItem(created.id);       // closed because it was fixed
  if (dismiss) mock.dismissItem(created.id);   // closed because nobody will fix it (the tracker's native "won't fix")
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

    test('only a DISMISSED report matches (closed as won\'t fix) → report it, file nothing, comment nothing: it is not a regression of a fix', async () => {
      const mock = MOCKS[type]();
      const rep = report(productBug());
      const wont = await seedBug(type, mock, tokenOf(rep), { dismiss: true });
      const before = mock.createdItems().length;
      const r = await plan(type, rep, { mock });
      const a = stepOf(r);
      assert.equal(a.step, 'report-dismissed');
      assert.equal(a.dismissedAs.id, wont.id);
      assert.match(a.reason, new RegExp(`report #${wont.id} .* closed WITHOUT a fix`));
      assert.equal(a.commentInput, undefined, 'no comment is prepared');
      assert.equal(a.idempotencyKey, undefined, 'and no bug is prepared');
      assert.equal(mock.createdItems().length, before);
    });

    test('a dismissed report AND a fixed one: the fix came back, so it IS a regression (of the fixed one)', async () => {
      const mock = MOCKS[type]();
      const rep = report(productBug());
      await seedBug(type, mock, tokenOf(rep), { dismiss: true, title: '[BUG] Old, dismissed' });
      const fixed = await seedBug(type, mock, tokenOf(rep), { close: true, title: '[BUG] Old, fixed' });
      const a = stepOf(await plan(type, rep, { mock }));
      assert.equal(a.step, 'file-regression');
      assert.equal(a.regressionOf.id, fixed.id);
    });

    test('a FIXED report, then a later report closed without a fix (the regression was dismissed): report it, do not file the regression again', async () => {
      const mock = MOCKS[type]();
      const rep = report(productBug());
      await seedBug(type, mock, tokenOf(rep), { close: true, title: '[BUG] First, fixed' });
      const wont = await seedBug(type, mock, tokenOf(rep), { dismiss: true, title: '[BUG] The regression, then dismissed' });
      const before = mock.createdItems().length;
      const a = stepOf(await plan(type, rep, { mock }));
      assert.equal(a.step, 'report-dismissed');
      assert.equal(a.dismissedAs.id, wont.id);
      assert.equal(mock.createdItems().length, before, 'the plan writes nothing');
    });

    test('a dismissed report AND an open one: the open one gets the comment', async () => {
      const mock = MOCKS[type]();
      const rep = report(productBug());
      await seedBug(type, mock, tokenOf(rep), { dismiss: true, title: '[BUG] Old, dismissed' });
      const live = await seedBug(type, mock, tokenOf(rep), { title: '[BUG] Live' });
      const a = stepOf(await plan(type, rep, { mock }));
      assert.equal(a.step, 'comment-existing');
      assert.equal(a.existing.id, live.id);
    });

    test('comment-existing comes with its input already written, named by the fingerprint token', async () => {
      const mock = MOCKS[type]();
      const rep = report(productBug());
      await seedBug(type, mock, tokenOf(rep));
      const commentsDir = path.join(dir, `comments-${type}-${Math.random().toString(36).slice(2)}`);
      const a = stepOf(await plan(type, rep, { mock, args: ['--comments-dir', commentsDir] }));
      assert.equal(a.commentInputFile, path.join(commentsDir, `${tokenOf(rep)}.json`));
      assert.deepEqual(JSON.parse(fs.readFileSync(a.commentInputFile, 'utf8')), a.commentInput);
      assertValidInput('comment', JSON.parse(fs.readFileSync(a.commentInputFile, 'utf8')));
    });

    test('nothing matches → file-bug, with the marker to include and a run-scoped idempotency key', async () => {
      const rep = report(productBug());
      const a = stepOf(await plan(type, rep));
      assert.equal(a.step, 'file-bug');
      assert.equal(a.marker, `qa-harness-fingerprint: ${tokenOf(rep)}`);
      assert.match(a.idempotencyKey, /^[A-Za-z0-9._-]{1,80}$/);
      assert.deepEqual(a.lookup, { open: [], closed: [], dismissed: [] });
    });

    test('a search hit whose BODY lacks the token (it was only in the title) does not count', async () => {
      const mock = MOCKS[type]();
      const rep = report(productBug());
      await seedBug(type, mock, tokenOf(rep), { inTitleOnly: true });
      assert.equal(stepOf(await plan(type, rep, { mock })).step, 'file-bug');
    });
  });
}

describe('plan: comment input files and held verdicts', () => {
  // a test whose key is free text from a test title: slash, pipe, space, apostrophe — it must never reach a file name or a shell
  const NASTY = "login.spec.ts|user can't log in / see \"home\"";
  const nastyBug = () => [R(failing(NASTY, ASSERT, { file: 'login.spec.ts' })), R(failing(NASTY, ASSERT, { file: 'login.spec.ts' })), R(failing(NASTY, ASSERT, { file: 'login.spec.ts' }))];
  // no manual case id, so this is PRD-2 at 0.75: lower the threshold so it acts and reaches the comment path
  const nastyReport = () => report(nastyBug(), { threshold: 0.7 });

  test('the file is named by the fingerprint token, never by the test key (which can hold / | spaces and quotes)', async () => {
    const mock = MOCKS.github();
    const rep = nastyReport();
    assert.equal(rep.verdicts[0].action, 'act');
    assert.match(rep.verdicts[0].key, /['|\/ "]/, 'the key really is unsafe as a file name');
    await seedBug('github', mock, tokenOf(rep));
    const commentsDir = path.join(dir, 'comments-nasty');
    const a = stepOf(await plan('github', rep, { mock, args: ['--comments-dir', commentsDir] }));
    assert.equal(path.basename(a.commentInputFile), `${tokenOf(rep)}.json`);
    assert.match(path.basename(a.commentInputFile), /^qafp[0-9a-f]{12}\.json$/);
    assert.deepEqual(fs.readdirSync(commentsDir), [path.basename(a.commentInputFile)], 'nothing else was written');
  });

  test('without --out or --comments-dir nothing is written and no file is promised', async () => {
    const mock = MOCKS.github();
    const rep = report(productBug());
    await seedBug('github', mock, tokenOf(rep));
    const a = stepOf(await plan('github', rep, { mock }));
    assert.equal(a.step, 'comment-existing');
    assert.equal(a.commentInputFile, undefined);
    assert.ok(a.commentInput, 'the input is still in the plan');
  });

  test('with --out, the inputs go to a comments/ directory next to the plan', async () => {
    const mock = MOCKS.github();
    const rep = report(productBug());
    await seedBug('github', mock, tokenOf(rep));
    const outDir = path.join(dir, 'out-next-to'); const out = path.join(outDir, 'plan.json');
    const a = stepOf(await plan('github', rep, { mock, args: ['--out', out] }));
    assert.equal(a.commentInputFile, path.join(outDir, 'comments', `${tokenOf(rep)}.json`));
    assert.ok(fs.existsSync(a.commentInputFile));
  });

  test('a verdict held at propose because its runner format is unverified says so, and is never filed or commented on', async () => {
    const mock = MOCKS.github();
    const rep = report(productBug().map((r) => ({ ...r, format: 'playwright-json' })));
    assert.equal(rep.verdicts[0].cap, 'unverified-format');
    await seedBug('github', mock, tokenOf(rep));
    const before = mock.createdItems().length;
    const a = stepOf(await plan('github', rep, { mock }));
    assert.equal(a.step, 'propose');
    assert.match(a.reason, /held at propose: classification of this runner format has not been verified/);
    assert.equal(a.commentInput, undefined);
    assert.equal(mock.createdItems().length, before);
  });
  test('a held TEST-bug (a stale selector with DOM evidence, from an unverified format) is proposed with the same reason — nothing is offered as a fix to act on', async () => {
    const stale = E("locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByTestId('add-btn')");
    const evidence = { 'DEMO-101/TC-005': { locator: { target: 'add-btn', present: false, candidates: [{ testid: 'add-button', similarity: 0.8, tag: 'button', text: 'Add' }] } } };
    const runs = [1, 2, 3].map(() => ({ format: 'playwright-json', totals: {}, tests: [failing('DEMO-101/TC-005: x', stale, ids(5))] }));
    const rep = report(runs, { evidence });
    assert.deepEqual([rep.verdicts[0].class, rep.verdicts[0].rule, rep.verdicts[0].cap], ['test-bug', 'TST-1', 'unverified-format']);
    const a = stepOf(await plan('github', rep));
    assert.equal(a.step, 'propose', 'not propose-test-fix: that step means "the cause is established"');
    assert.match(a.reason, /held at propose: classification of this runner format has not been verified/);
  });
});

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
    const crash = E('ReferenceError: x is not defined', 'error', 'at run (/work/tests/a.test.js:3:3)'); // a crash only the test can cause: acts. (A TypeError is 0.65: only proposed.)
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
    const crash = E('ReferenceError: x is not defined', 'error', 'at run (/work/tests/a.test.js:3:3)');
    const tb = report([R(failing('t', crash)), R(failing('t', crash))]);
    const closedMock = MOCKS.github(); await seedBug('github', closedMock, tokenOf(pb), { close: true });
    const dismissedMock = MOCKS.github(); await seedBug('github', dismissedMock, tokenOf(pb), { dismiss: true });
    const openMock = MOCKS.github(); await seedBug('github', openMock, tokenOf(pb));
    const seen = new Set();
    for (const [rep, mock] of [[flaky], [env], [tb], [lowPb], [dup], [pb, closedMock], [pb, dismissedMock], [pb, openMock]]) {
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
    const long = await k(['--run-id', 'x'.repeat(128)]); // the longest id the CLI accepts
    assert.match(long, /^[A-Za-z0-9._-]{1,80}$/);
    assert.ok(long.length < `fp-${rep.verdicts[0].fingerprint}-${'x'.repeat(128)}`.length, 'shortened');
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
    for (const argv of [[], ['--bogus'], ['--report'], ['--report', 'x', '--run-id', '']]) assert.equal((await cli(argv)).code, 2, argv.join(' '));
  });
});

describe('plan: what the third review of PR #9 found', () => {
  const key = (rep, runId) => stepOf(rep).idempotencyKey;
  const keyFor = async (runId) => stepOf(await plan('github', report(productBug()), { args: ['--run-id', runId] })).idempotencyKey;

  test('the idempotency key tells run ids apart however long or odd they are (it used to keep 40 characters and fold every other character to "-")', async () => {
    const long1 = 'ci-build-1234567890-abcdefghijklmnopqrstuvwxyz-1';
    const long2 = 'ci-build-1234567890-abcdefghijklmnopqrstuvwxyz-2';
    assert.notEqual(await keyFor(long1), await keyFor(long2), 'ids that differ only after character 40');
    assert.equal(await keyFor(long1), await keyFor(long1), 'the same id gives the same key every time (that is what makes a retry safe)');
    assert.equal(await keyFor('run42'), `fp-${report(productBug()).verdicts[0].fingerprint}-run42`, 'a plain short id is used as it is');
  });
  test('keys stay valid (at most 80 characters of the allowed alphabet) for the longest ids, including the comment form', async () => {
    const rep = report(productBug());
    const id = 'x'.repeat(64);
    const mock = MOCKS.github();
    const bug = await seedBug('github', mock, tokenOf(rep));
    const a = stepOf(await plan('github', rep, { mock, args: ['--run-id', id] }));
    assert.equal(a.step, 'comment-existing');
    assert.match(a.commentInput.idempotencyKey, /^[A-Za-z0-9._-]{1,80}$/);
    assertValidInput('comment', a.commentInput);
    assert.ok(bug);
  });
  test('--run-id accepts what orchestrate.js accepts (odd ids are hashed into the key) and refuses empty, over-long and control characters (exit 2)', async () => {
    for (const bad of ['', 'a'.repeat(129), 'a\nb', 'a\u0000b']) assert.equal((await plan('github', report(productBug()), { args: ['--run-id', bad] })).code, 2, JSON.stringify(bad));
    for (const ok of ['refs/heads/main', 'build#42', '2026-11-11 18:15', '!!!', 'a b', '../x']) {
      const r = await plan('github', report(productBug()), { args: ['--run-id', ok] });
      assert.equal(r.code, 0, ok);
      assert.match(stepOf(r).idempotencyKey, /^fp-[0-9a-f]{12}-[A-Za-z0-9._-]+$/, ok);
    }
  });
  test('keys never collide: distinct odd ids, and a literal id that equals another id\'s HASHED form', async () => {
    const fp = report(productBug()).verdicts[0].fingerprint;
    const long = 'ci-build-1234567890-abcdefghijklmnopqrstuvwxyz-1';
    const hashedPart = (await keyFor(long)).slice(`fp-${fp}-`.length);
    assert.notEqual(await keyFor(hashedPart), await keyFor(long), 'a run literally named like the hashed form must not share its key');
    const set = new Set([await keyFor('a/b'), await keyFor('a-b'), await keyFor('a b'), await keyFor('a_b'), await keyFor(long), await keyFor(`${long.slice(0, -1)}2`), await keyFor(hashedPart)]);
    assert.equal(set.size, 7);
    for (const id of ['x'.repeat(128), '!'.repeat(128), 'a/b', hashedPart]) assert.ok((await keyFor(id)).length + '-comment'.length <= 80, id.slice(0, 20));
  });

  describe('the tracker lookup', () => {
    // wrap a mock's fetch so that GET of one specific issue fails for good (a 500 on every try)
    const breakIssue = (mock, id) => async (url, init) => (new RegExp(`/issues/${id}$`).test(String(url)) && (!init || !init.method || init.method === 'GET')
      ? new Response('{"message":"boom"}', { status: 500 }) : mock.fetch(url, init));
    test('one candidate that cannot be read does not discard the others: an open report that WAS read still gets the comment, and the skip is reported', async () => {
      const mock = MOCKS.github();
      const rep = report(productBug());
      const first = await seedBug('github', mock, tokenOf(rep), { title: '[BUG] Unreadable' });
      const second = await seedBug('github', mock, tokenOf(rep), { title: '[BUG] Readable' });
      const r = await plan('github', rep, { mock, fetch: breakIssue(mock, first.id) });
      const a = stepOf(r);
      assert.equal(a.step, 'comment-existing');
      assert.equal(a.existing.id, second.id);
      assert.ok(r.json.data.warnings.some((w) => /could not be read/.test(w) && new RegExp(`#?${first.id}\\b`).test(w)), JSON.stringify(r.json.data.warnings));
      assert.ok(a.lookup.partial, 'the step says the lookup was partial');
    });
    test('when the only candidate cannot be read, filing is still the step but it SAYS an existing report may exist', async () => {
      const mock = MOCKS.github();
      const rep = report(productBug());
      const only = await seedBug('github', mock, tokenOf(rep));
      const r = await plan('github', rep, { mock, fetch: breakIssue(mock, only.id) });
      const a = stepOf(r);
      assert.equal(a.step, 'file-bug');
      assert.match(a.note, /could not be read/);
      assert.ok(r.json.data.warnings.some((w) => /could not be read/.test(w)));
    });
    test('hitting the candidate limit is reported: a report ranked below it could not have been seen', async () => {
      const mock = MOCKS.github();
      const rep = report(productBug());
      for (let i = 0; i < 6; i += 1) await seedBug('github', mock, tokenOf(rep), { title: `[BUG] copy ${i}`, close: true });
      const r = await plan('github', rep, { mock });
      assert.ok(r.json.data.warnings.some((w) => /only the first 5/.test(w)), JSON.stringify(r.json.data.warnings));
      assert.ok(stepOf(r).lookup.truncated);
    });
    test('every step that FILES or REPORTS carries the lookup caveat, not only file-bug: a regression or a dismissal decided from a partial lookup says so', async () => {
      const rep = report(productBug());
      // (a) a closed match plus an unreadable candidate (which might be the open one) -> file-regression
      const m1 = MOCKS.github();
      await seedBug('github', m1, tokenOf(rep), { title: '[BUG] old', close: true });
      const hidden = await seedBug('github', m1, tokenOf(rep), { title: '[BUG] maybe open' });
      const a = stepOf(await plan('github', rep, { mock: m1, fetch: breakIssue(m1, hidden.id) }));
      assert.equal(a.step, 'file-regression');
      assert.match(a.note, /could not be read/);
      assert.match(a.note, /regression/, 'the regression explanation is still there');
      // (b) a dismissed match plus an unreadable candidate -> report-dismissed
      const m2 = MOCKS.github();
      await seedBug('github', m2, tokenOf(rep), { title: '[BUG] wontfix', dismiss: true });
      const hidden2 = await seedBug('github', m2, tokenOf(rep), { title: '[BUG] maybe open' });
      const b = stepOf(await plan('github', rep, { mock: m2, fetch: breakIssue(m2, hidden2.id) }));
      assert.equal(b.step, 'report-dismissed');
      assert.match(b.note, /could not be read/);
      // (c) the candidate limit was hit -> file-regression / file-bug say only the first 5 were checked
      const m3 = MOCKS.github();
      for (let i = 0; i < 6; i += 1) await seedBug('github', m3, tokenOf(rep), { title: `[BUG] copy ${i}`, close: true });
      const c = stepOf(await plan('github', rep, { mock: m3 }));
      assert.equal(c.step, 'file-regression');
      assert.match(c.note, /only the first 5/);
    });
    test('fewer candidates than the limit: no warning and no partial flag', async () => {
      const mock = MOCKS.github();
      const rep = report(productBug());
      await seedBug('github', mock, tokenOf(rep));
      const r = await plan('github', rep, { mock });
      assert.deepEqual(r.json.data.warnings, []);
      assert.equal(stepOf(r).lookup.partial, undefined);
      assert.equal(stepOf(r).lookup.truncated, undefined);
    });
  });

  describe('what a comment says', () => {
    test('secrets in the recorded error text are masked in the comment body (and the comment still carries the marker)', async () => {
      const mock = MOCKS.github();
      const leaky = E('request failed: Authorization: Bearer abc123def456ghi789jkl token=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA https://deploy:hunter2secret@staging.example.test/x');
      const rep = report(productBug(5, leaky));
      await seedBug('github', mock, tokenOf(rep));
      const a = stepOf(await plan('github', rep, { mock }));
      assert.equal(a.step, 'comment-existing');
      for (const secret of ['abc123def456ghi789jkl', 'ghp_AAAA', 'hunter2secret']) assert.ok(!a.commentInput.body.includes(secret), secret);
      assert.match(a.commentInput.body, new RegExp(`qa-harness-fingerprint: ${tokenOf(rep)}`));
    });
    test('a hand-edited report with a secret in it is masked too (the plan does not trust the report to have been cleaned)', async () => {
      const mock = MOCKS.github();
      const rep = report(productBug());
      await seedBug('github', mock, tokenOf(rep));
      rep.verdicts[0].error = { kind: 'failure', message: 'password=correcthorsebattery in the form' };
      const a = stepOf(await plan('github', rep, { mock }));
      assert.ok(!a.commentInput.body.includes('correcthorsebattery'));
    });
  });

  test('a verdict whose token is not a fingerprint token is refused before anything is written: it names a FILE (comments/<token>.json)', async () => {
    const mock = MOCKS.github();
    const rep = report(productBug());
    await seedBug('github', mock, tokenOf(rep));
    rep.verdicts[0].token = '../../evil';
    const outDir = fs.mkdtempSync(path.join(dir, 'out-'));
    const r = await plan('github', rep, { mock, args: ['--out', path.join(outDir, 'plan.json')] });
    assert.equal(r.code, 2);
    assert.match(r.err, /token/);
    assert.equal(fs.existsSync(path.join(outDir, 'plan.json')), false);
    assert.equal(fs.existsSync(path.join(outDir, '..', 'evil.json')), false);
  });
});
