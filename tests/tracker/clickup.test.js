'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createClickupMock } = require('../mocks/tracker-mock/clickup');
const { createAdapter, run } = require('../../scripts/tracker/adapters');
const { runContractSuite } = require('./contract-suite');
const { assertValid, rejectsWith } = require('./helpers');

runContractSuite('clickup', () => createClickupMock());

describe('clickup: specifics', () => {
  const make = (mock, settings = {}) => createAdapter('clickup', {
    settings: { ...mock.settings, ...settings }, env: { CLICKUP_TOKEN: mock.token }, fetch: mock.fetch, baseUrl: mock.baseUrl, timeoutMs: 500, retryDelayMs: 0,
  });
  const steps = [{ action: 'Add two items', expected: 'Cart shows $36.00' }, { action: 'Apply BREW10', expected: 'Discount is $3.60' }, { action: 'Place order', expected: 'Order confirmed' }];
  const input = (parentId, extra = {}) => ({ parentId, tcId: 'TC-001', title: 'Percent code', priority: 'High', steps, ...extra });

  test('the raw token is the Authorization header (no "Bearer")', async () => {
    const mock = createClickupMock();
    await run(make(mock), 'fetch', { id: mock.seedTicket({ title: 'x' }) });
    assert.ok(mock.calls.every((c) => c.headers.authorization === mock.token));
  });

  test('steps become checklist items of the form "action — Expected: result"', async () => {
    const mock = createClickupMock();
    const created = await run(make(mock), 'create-test', input(mock.seedTicket({ title: 'P' })));
    const [cl] = [...mock.state.checklists.values()].filter((c) => c.task === created.id);
    assert.equal(cl.name, 'Test Steps');
    assert.deepEqual(cl.items.map((i) => i.name), steps.map((s) => `${s.action} — Expected: ${s.expected}`));
  });

  test('priorities map High→1, Medium→2, Low→3, unspecified→4', async () => {
    const mock = createClickupMock();
    const adapter = make(mock);
    const parent = mock.seedTicket({ title: 'P' });
    for (const [priority, expected] of [['High', 1], ['Medium', 2], ['Low', 3], [undefined, 4]]) {
      const c = await run(adapter, 'create-test', { parentId: parent, tcId: 'TC-9', title: 't', priority });
      assert.equal(mock.state.tasks.get(c.id).priorityNum, expected);
    }
  });

  test('the test task is assigned to the current user, unless assignToSelf is false', async () => {
    const mock = createClickupMock();
    const parent = mock.seedTicket({ title: 'P' });
    const a = await run(make(mock), 'create-test', input(parent));
    assert.deepEqual(mock.state.tasks.get(a.id).assignees, [{ id: 183 }]);

    const quiet = createClickupMock();
    const b = await run(make(quiet, { assignToSelf: false }), 'create-test', input(quiet.seedTicket({ title: 'P' })));
    assert.deepEqual(quiet.state.tasks.get(b.id).assignees, []);
    assert.ok(!quiet.calls.some((c) => c.path.endsWith('/user')));
  });

  test('link is a native ClickUp task link', async () => {
    const mock = createClickupMock();
    const parent = mock.seedTicket({ title: 'P' });
    const child = await run(make(mock), 'create-test', input(parent));
    const result = await run(make(mock), 'link', { childId: child.id, parentId: parent });
    assert.deepEqual(result, { linked: true, method: 'native' });
    assert.deepEqual(mock.state.links, [[child.id, parent]]);
  });

  test('bugs are named "[BUG] …" and carry labels as tags', async () => {
    const mock = createClickupMock();
    await run(make(mock), 'create-bug', { title: 'Totals wrong', body: 'details', priority: 'Medium', labels: ['checkout'] });
    const t = mock.state.tasks.get(mock.createdItems()[0].id);
    assert.equal(t.name, '[BUG] Totals wrong');
    assert.deepEqual(t.tags.map((x) => x.name), ['checkout']);
    assert.equal(t.priorityNum, 2);
  });

  test('fetch normalizes subtasks, attachments and epoch-millisecond comment dates', async () => {
    const mock = createClickupMock();
    const parent = mock.seedTicket({ title: 'Parent', comments: [{ author: 'pm', body: 'note' }] });
    mock.seedTask({ name: 'Child task', parent });
    mock.state.tasks.get(parent).attachments = [{ title: 'spec.pdf', url: 'https://files.test/spec.pdf' }];
    const ticket = await run(make(mock), 'fetch', { id: parent });
    assertValid('tracker-ticket', ticket);
    assert.deepEqual(ticket.subtasks.map((s) => s.title), ['Child task']);
    assert.deepEqual(ticket.attachments, [{ name: 'spec.pdf', url: 'https://files.test/spec.pdf' }]);
    assert.equal(ticket.comments[0].created, '2026-01-02T00:00:00.000Z');
  });

  test('search pages through lists longer than one page', async () => {
    const mock = createClickupMock();
    for (let n = 0; n < 150; n += 1) mock.seedTask({ name: `Filler ${n}` });
    const needle = mock.seedTask({ name: 'The needle' });
    const result = await run(make(mock), 'search', { query: 'needle' });
    assert.deepEqual(result.items.map((i) => i.id), [needle]);
    assert.ok(mock.calls.filter((c) => /\/list\/.+\/task$/.test(c.path)).length >= 2);
  });

  test('a path-unsafe task id is rejected without a request', async () => {
    const mock = createClickupMock();
    await rejectsWith(run(make(mock), 'fetch', { id: '../../team' }), 'VALIDATION', false);
    assert.equal(mock.calls.length, 0);
  });

  test('a missing listId is a CONFIG error', () => {
    assert.throws(() => createAdapter('clickup', { settings: {}, env: { CLICKUP_TOKEN: 'x' } }), (e) => e.code === 'CONFIG');
  });

  describe('partial failure: the task is created but its steps are not', () => {
    test('the error says which task was left half-built', async () => {
      const mock = createClickupMock();
      const parent = mock.seedTicket({ title: 'P' });
      mock.inject({ method: 'POST', match: '/checklist/.+/checklist_item', status: 500 });
      await assert.rejects(run(make(mock), 'create-test', input(parent)), (err) => {
        assertValid('tracker-error', err.toJSON());
        assert.equal(err.code, 'UPSTREAM_ERROR');
        assert.equal(err.retriable, true);
        assert.equal(err.details.partial.id, mock.createdItems()[0].id);
        assert.match(err.message, /was created but its steps were not fully added/);
        return true;
      });
      assert.equal(mock.createdItems().length, 1);
    });

    test('retrying with the same key finishes the steps instead of duplicating or accepting a half-built task', async () => {
      const mock = createClickupMock();
      const adapter = make(mock);
      const parent = mock.seedTicket({ title: 'P' });
      mock.inject({ method: 'POST', match: '/checklist/.+/checklist_item', status: 500 });
      await assert.rejects(run(adapter, 'create-test', input(parent, { idempotencyKey: 'DEMO-101-TC-001' })));

      const retry = await run(adapter, 'create-test', input(parent, { idempotencyKey: 'DEMO-101-TC-001' }));
      assertValid('tracker-create-result', retry);
      assert.equal(retry.deduplicated, true);
      assert.equal(retry.repaired, true);
      assert.equal(mock.createdItems().length, 1, 'still exactly one task');
      const [cl] = [...mock.state.checklists.values()];
      assert.equal(cl.items.length, steps.length, 'all steps are present after the retry');
    });

    test('retrying a COMPLETE task is a plain dedupe (not "repaired")', async () => {
      const mock = createClickupMock();
      const adapter = make(mock);
      const parent = mock.seedTicket({ title: 'P' });
      await run(adapter, 'create-test', input(parent, { idempotencyKey: 'k1' }));
      const again = await run(adapter, 'create-test', input(parent, { idempotencyKey: 'k1' }));
      assert.equal(again.deduplicated, true);
      assert.equal(again.repaired, undefined);
    });
  });
});
