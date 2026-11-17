'use strict';

// Slice 3: the planner consults the run ledger for a bug it filed a short while ago, so that a tracker whose search index lags (GitHub's is eventually
// consistent) does not turn "file the bug" into a second bug. The tracker stays the authority for anything its search does show.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main, LAG_WINDOW_MS, filedByLedger } = require('../../scripts/triage/plan');
const { classify } = require('../../scripts/triage/classify');
const { createAdapter } = require('../../scripts/tracker/adapters');
const { runOnce } = require('../../scripts/tracker/lib/once');
const { openLedger } = require('../../scripts/ledger/lib/ledger');
const { MOCKS } = require('../tracker/workspace');

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-plan-led-'));
const E = (message) => ({ kind: 'failure', message, details: '' });
const failing = (n) => ({ name: `DEMO-101/TC-00${n}: x`, status: 'failed', error: E('a second application of the code should be rejected'), ticket: 'DEMO-101', caseId: `TC-00${n}` });
const R = (...tests) => ({ format: 'tap', totals: {}, tests });
const productBug = (n = 5) => classify({ runs: [R(failing(n)), R(failing(n)), R(failing(n))] });
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-13T10:00:00Z');

let clock = T0;
const ledgerDir = () => path.join(dir, `ledger-${Math.random().toString(36).slice(2)}`);

async function plan(rep, { mock, ledger: led, runId = 'run-2', env, extra = [] }) {
  const cfg = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ ticketSource: { type: 'github', github: mock.settings } }));
  const file = path.join(dir, `report-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ ok: true, data: rep }));
  let out = ''; let err = '';
  const code = await main({
    argv: ['--report', file, '--config', cfg, '--base-url', mock.baseUrl, '--run-id', runId, ...(led ? ['--ledger-dir', led] : []), ...extra],
    env: env || { [mock.tokenEnv]: mock.token }, fetch: mock.fetch, now: () => clock,
    stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
  });
  return { code, err, json: out ? JSON.parse(out) : null };
}

// file the bug the way /file-bug does: through the tracker CLI's write path, under the key the planner handed out, in the ledger
async function fileIt(mock, rep, led, { runId = 'run-1' } = {}) {
  const first = await plan(rep, { mock, ledger: led, runId });
  const action = first.json.data.actions[0];
  assert.equal(action.step, 'file-bug', JSON.stringify(action));
  const adapter = createAdapter('github', { settings: mock.settings, env: { [mock.tokenEnv]: mock.token }, fetch: mock.fetch, baseUrl: mock.baseUrl, timeoutMs: 500, retryDelayMs: 0 });
  const created = await runOnce(adapter, 'create-bug', { title: 'Second code accepted', body: `Steps.\n\n${action.marker}`, idempotencyKey: action.idempotencyKey }, { ledger: openLedger({ dir: led, now: () => clock }), runId });
  return created;
}
const step = (r, n = 0) => r.json.data.actions[n];

describe('the planner and the ledger: a bug filed minutes ago', () => {
  test('the tracker\'s search index lags: WITHOUT the ledger the failure is filed a second time (what this protects against)', async () => {
    clock = T0;
    const mock = MOCKS.github();
    mock.state.searchLag = true;
    const rep = productBug();
    await fileIt(mock, rep, ledgerDir());
    const r = await plan(rep, { mock }); // no ledger
    assert.equal(step(r).step, 'file-bug', 'the search does not show the new bug yet');
  });

  test('WITH the ledger it comments on the bug it filed, and says why', async () => {
    clock = T0;
    const mock = MOCKS.github();
    mock.state.searchLag = true;
    const rep = productBug();
    const led = ledgerDir();
    const bug = await fileIt(mock, rep, led);
    clock = T0 + 10 * 60 * 1000;
    const r = await plan(rep, { mock, ledger: led });
    const a = step(r);
    assert.equal(a.step, 'comment-existing');
    assert.deepEqual([a.existing.id, a.existing.source, a.existing.open], [String(bug.id), 'ledger', true]);
    assert.equal(a.existing.url, bug.url);
    assert.equal(a.commentInput.id, String(bug.id));
    assert.match(a.commentInput.idempotencyKey, /^fp-[0-9a-f]{12}-run-2-comment$/);
    assert.equal(a.lookup.ledger.filedAt, '2026-11-13T10:00:00.000Z');
    assert.ok(r.json.data.warnings.some((w) => new RegExp(`did not show report #${bug.id}, which this ledger filed`).test(w)), JSON.stringify(r.json.data.warnings));
    assert.equal(mock.createdItems().length, 1, 'the planner only plans: nothing was filed');
  });

  test('once the index has caught up the TRACKER answers, as before: no "ledger" source, no warning', async () => {
    clock = T0;
    const mock = MOCKS.github();
    mock.state.searchLag = true;
    const rep = productBug();
    const led = ledgerDir();
    const bug = await fileIt(mock, rep, led);
    mock.settle();
    const r = await plan(rep, { mock, ledger: led });
    const a = step(r);
    assert.equal(a.step, 'comment-existing');
    assert.equal(a.existing.id, String(bug.id));
    assert.equal(a.existing.source, undefined);
    assert.equal((r.json.data.warnings || []).filter((w) => /this ledger filed/.test(w)).length, 0);
  });

  test('the tracker is the authority for what it DOES show: a bug it reports as fixed is a regression, not a place to comment, even if the ledger filed it minutes ago', async () => {
    clock = T0;
    const mock = MOCKS.github();
    mock.state.searchLag = true;
    const rep = productBug();
    const led = ledgerDir();
    const bug = await fileIt(mock, rep, led);
    mock.settle();
    mock.closeItem(bug.id); // fixed
    const r = await plan(rep, { mock, ledger: led });
    assert.equal(step(r).step, 'file-regression');
    assert.equal(step(r).regressionOf.id, String(bug.id));
  });

  test('a bug the ledger filed more than 24 hours ago is not trusted over the tracker: the index has long caught up, so a bug it no longer shows is gone', async () => {
    clock = T0;
    const mock = MOCKS.github();
    const rep = productBug();
    const led = ledgerDir();
    const bug = await fileIt(mock, rep, led);
    mock.state.issues.delete(Number(bug.id)); // deleted on the tracker
    clock = T0 + LAG_WINDOW_MS - HOUR;
    assert.equal(step(await plan(rep, { mock, ledger: led })).step, 'comment-existing', 'inside the window the ledger still fills the gap');
    clock = T0 + LAG_WINDOW_MS + HOUR;
    assert.equal(step(await plan(rep, { mock, ledger: led })).step, 'file-bug', 'past it the tracker alone is asked');
  });

  test('when the tracker cannot be reached at all, the ledger still stops a second report, and the plan says the lookup was not made', async () => {
    clock = T0;
    const mock = MOCKS.github();
    const rep = productBug();
    const led = ledgerDir();
    const bug = await fileIt(mock, rep, led);
    const r = await plan(rep, { mock, ledger: led, env: {} }); // no token: no tracker lookup
    const a = step(r);
    assert.equal(a.step, 'comment-existing');
    assert.equal(a.existing.id, String(bug.id));
    assert.ok(r.json.data.warnings.some((w) => /no tracker lookup/.test(w)));
  });

  test('a different failure, or a bug the ledger filed on a different tracker, is not a match', async () => {
    clock = T0;
    const mock = MOCKS.github();
    mock.state.searchLag = true;
    const led = ledgerDir();
    await fileIt(mock, productBug(5), led);
    assert.equal(step(await plan(productBug(6), { mock, ledger: led })).step, 'file-bug', 'another failure');
    const rep = productBug(7);
    const fp = rep.verdicts[0].fingerprint;
    const l = openLedger({ dir: led, now: () => clock });
    l.claim(`gitlab/create-bug/fp-${fp}-run-1`, { runId: 'run-1' });
    l.complete(`gitlab/create-bug/fp-${fp}-run-1`, { id: '12' });
    assert.equal(step(await plan(rep, { mock, ledger: led })).step, 'file-bug', 'a bug on GitLab says nothing about GitHub');
  });

  test('a claim that is not finished (the filing is still in flight or failed) is not a bug that exists', async () => {
    clock = T0;
    const mock = MOCKS.github();
    const rep = productBug();
    const fp = rep.verdicts[0].fingerprint;
    const led = ledgerDir();
    const l = openLedger({ dir: led, now: () => clock });
    l.claim(`github/create-bug/fp-${fp}-run-1`, { runId: 'run-1' });
    l.claim(`github/create-bug/fp-${fp}-run-0`, { runId: 'run-0' });
    l.fail(`github/create-bug/fp-${fp}-run-0`, { code: 'NETWORK' });
    assert.equal(step(await plan(rep, { mock, ledger: led })).step, 'file-bug');
  });

  test('a COMMENT the ledger posted for the same failure is not a bug it filed (a comment id is not a report id), and neither is a filing with no id', async () => {
    clock = T0;
    const mock = MOCKS.github();
    const rep = productBug();
    const fp = rep.verdicts[0].fingerprint;
    const led = ledgerDir();
    const l = openLedger({ dir: led, now: () => clock });
    l.claim(`github/comment/fp-${fp}-run-1-comment`, { runId: 'run-1' });
    l.complete(`github/comment/fp-${fp}-run-1-comment`, { id: '9001' });
    l.claim(`github/create-test/fp-${fp}-run-1`, { runId: 'run-1' });
    l.complete(`github/create-test/fp-${fp}-run-1`, { id: '9002' });
    l.claim(`github/create-bug/fp-${fp}-run-0`, { runId: 'run-0' });
    l.complete(`github/create-bug/fp-${fp}-run-0`, {}); // done, but the tracker told us no id
    assert.equal(step(await plan(rep, { mock, ledger: led })).step, 'file-bug');
    assert.equal(filedByLedger(l, fp, 'github', () => clock), null);
  });

  test('the newest filing wins when the ledger filed the failure more than once (a regression, a later run)', async () => {
    clock = T0;
    const rep = productBug();
    const fp = rep.verdicts[0].fingerprint;
    const led = ledgerDir();
    const l = openLedger({ dir: led, now: () => clock });
    for (const [run, id, at] of [['run-1', '11', 0], ['run-3', '33', 2 * HOUR], ['run-2', '22', HOUR]]) {
      clock = T0 + at;
      l.claim(`github/create-bug/fp-${fp}-${run}`, { runId: run });
      l.complete(`github/create-bug/fp-${fp}-${run}`, { id, url: `https://tracker.test/${id}` });
    }
    clock = T0 + 3 * HOUR;
    const hit = filedByLedger(l, fp, 'github', () => clock);
    assert.deepEqual([hit.id, hit.url], ['33', 'https://tracker.test/33']);
    assert.equal(filedByLedger(l, fp, 'gitlab', () => clock), null);
    assert.equal(filedByLedger(l, fp, undefined, () => clock).id, '33', 'with no tracker named (it could not be configured) any tracker\'s filing counts');
    assert.equal(filedByLedger(null, fp, 'github', () => clock), null);
    assert.equal(filedByLedger(l, 'f'.repeat(12), 'github', () => clock), null);
  });

  test('a filing "from the future" (a clock that was wrong) is not trusted', async () => {
    const rep = productBug();
    const fp = rep.verdicts[0].fingerprint;
    const l = openLedger({ dir: ledgerDir(), now: () => T0 + 5 * HOUR });
    l.claim(`github/create-bug/fp-${fp}-run-1`, { runId: 'run-1' });
    l.complete(`github/create-bug/fp-${fp}-run-1`, { id: '11' });
    assert.equal(filedByLedger(l, fp, 'github', () => T0), null);
    assert.equal(filedByLedger(l, fp, 'github', () => T0 + 5 * HOUR).id, '11');
  });

  test('low-confidence and non-product-bug verdicts are untouched by the ledger', async () => {
    clock = T0;
    const mock = MOCKS.github();
    mock.state.searchLag = true;
    const rep = productBug();
    const led = ledgerDir();
    await fileIt(mock, rep, led);
    const proposeOnly = { ...rep, verdicts: rep.verdicts.map((v) => ({ ...v, action: 'propose' })) };
    assert.equal(step(await plan(proposeOnly, { mock, ledger: led })).step, 'propose');
  });

  test('without a ledger (none configured, no --ledger-dir) the plan is exactly what it was, with no new field', async () => {
    clock = T0;
    const mock = MOCKS.github();
    const r = await plan(productBug(), { mock });
    const a = step(r);
    assert.equal(a.step, 'file-bug');
    assert.equal(a.lookup.ledger, undefined);
  });
});
