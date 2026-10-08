'use strict';
// The behavior EVERY tracker adapter must have, run against each adapter's in-process mock.
// Adapter-specific behavior (how a tracker models links, steps, tags...) lives in <adapter>.test.js.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter, run } = require('../../scripts/tracker/adapters');
const { assertValid, assertValidInput, rejectsWith } = require('./helpers');

function runContractSuite(name, makeMock) {
  const build = (mock, over = {}) => createAdapter(mock.source, {
    settings: mock.settings,
    env: over.env !== undefined ? over.env : { [mock.tokenEnv]: mock.token },
    fetch: mock.fetch,
    baseUrl: mock.baseUrl,
    timeoutMs: over.timeoutMs || 500,
    retryDelayMs: 0,
  });
  const fresh = (over) => { const mock = makeMock(); return { mock, adapter: build(mock, over) }; };
  const testInput = (parentId, extra = {}) => ({
    parentId, tcId: 'TC-001', title: 'A valid code takes 10% off', description: 'Checks the percentage discount.',
    priority: 'High', steps: [{ action: 'Add two items', expected: 'Cart shows $36.00' }, { action: 'Apply BREW10', expected: 'Discount is $3.60' }], ...extra,
  });
  const bugInput = (extra = {}) => ({ title: 'Coupon stacks when re-applied', body: 'Steps: apply BREW10 twice.\nActual: 20% off.', priority: 'High', ...extra });
  const seed = (mock) => mock.seedTicket({
    title: 'Apply a discount code', description: 'Shoppers can enter a code.', acceptance: '1. Valid code reduces the order.\n2. Only one code per order.',
    comments: [{ author: 'pm', body: 'Marketing launches Monday.' }],
  });

  describe(`${name}: tracker contract`, () => {
    test('fetch returns a schema-valid normalized ticket', async () => {
      const { mock, adapter } = fresh();
      const id = seed(mock);
      const ticket = await run(adapter, 'fetch', { id });
      assertValid('tracker-ticket', ticket);
      assert.equal(ticket.source, mock.source);
      assert.equal(ticket.id, id);
      assert.equal(ticket.title, 'Apply a discount code');
      assert.match(ticket.description, /Shoppers can enter a code/);
      assert.match(ticket.acceptanceCriteria, /Only one code per order/);
      assert.deepEqual(ticket.comments.map((c) => c.body), ['Marketing launches Monday.']);
    });

    test('fetch of an unknown id is NOT_FOUND (not retried)', async () => {
      const { mock, adapter } = fresh();
      await rejectsWith(run(adapter, 'fetch', { id: mock.missingId }), 'NOT_FOUND', false);
      assert.equal(mock.calls.filter((c) => new RegExp(mock.paths.ticket).test(c.path)).length, 1, 'a 404 must not be retried');
    });

    test('a wrong token is UNAUTHENTICATED', async () => {
      const mock = makeMock();
      const adapter = build(mock, { env: { [mock.tokenEnv]: 'not-the-token' } });
      await rejectsWith(run(adapter, 'fetch', { id: seed(mock) }), 'UNAUTHENTICATED', false);
    });

    test('a missing token fails fast with CONFIG, before any request', () => {
      const mock = makeMock();
      assert.throws(() => build(mock, { env: {} }), (e) => e.code === 'CONFIG' && e.retriable === false);
      assert.equal(mock.calls.length, 0);
    });

    test('search finds items and returns schema-valid results', async () => {
      const { mock, adapter } = fresh();
      const id = seed(mock);
      const result = await run(adapter, 'search', { query: 'discount code' });
      assertValid('tracker-search-result', result);
      assert.ok(result.items.some((i) => i.id === id));
    });

    test('create-test creates a schema-valid item that carries the TC id, title and steps', async () => {
      const { mock, adapter } = fresh();
      const parent = seed(mock);
      const input = testInput(parent);
      assertValidInput('create-test', input);
      const created = await run(adapter, 'create-test', input);
      assertValid('tracker-create-result', created);
      assert.equal(created.deduplicated, false);
      const [item] = mock.createdItems();
      assert.equal(item.id, created.id);
      assert.match(item.title, /TC-001/);
      assert.match(item.title + item.text, /A valid code takes 10% off/);
      assert.match(item.text, /Apply BREW10/);
    });

    test('link returns a schema-valid result', async () => {
      const { mock, adapter } = fresh();
      const parent = seed(mock);
      const created = await run(adapter, 'create-test', testInput(parent));
      const linked = await run(adapter, 'link', { childId: created.id, parentId: parent });
      assertValid('tracker-link-result', linked);
      assert.equal(linked.linked, true);
    });

    test('create-bug creates an item that search(kind: bug) can find', async () => {
      const { mock, adapter } = fresh();
      const input = bugInput();
      assertValidInput('create-bug', input);
      const created = await run(adapter, 'create-bug', input);
      assertValid('tracker-create-result', created);
      const found = await run(adapter, 'search', { query: 'Coupon stacks', kind: 'bug' });
      assert.ok(found.items.some((i) => i.id === created.id));
      assert.equal(mock.createdItems().length, 1);
    });

    test('search says whether each item is open, and still returns closed ones (a recurrence must be recognizable)', async () => {
      const { mock, adapter } = fresh();
      const live = await run(adapter, 'create-bug', bugInput({ title: 'Receipt total is wrong on refunds' }));
      const old = await run(adapter, 'create-bug', bugInput({ title: 'Receipt rounding is wrong on refunds' }));
      mock.closeItem(old.id); // the tracker's NATIVE closed state (closed / resolved / done …)
      const { items } = await run(adapter, 'search', { query: 'Receipt', kind: 'bug' });
      assertValid('tracker-search-result', { items });
      const byId = Object.fromEntries(items.map((i) => [i.id, i]));
      assert.equal(byId[live.id].open, true, 'a live bug is open');
      assert.equal(byId[old.id].open, false, 'a closed bug is still returned, marked not open');
    });

    test('comment adds a comment and returns a schema-valid result', async () => {
      const { mock, adapter } = fresh();
      const id = seed(mock);
      const result = await run(adapter, 'comment', { id, body: 'Run finished: 20 passed, 2 failed.' });
      assertValid('tracker-comment-result', result);
      assert.ok(mock.commentsOn(id).some((b) => /20 passed, 2 failed/.test(b)));
    });

    // ── Idempotency ────────────────────────────────────────────────────────────

    test('comment with an idempotencyKey is posted once, however often it is re-run', async () => {
      const { mock, adapter } = fresh();
      const id = seed(mock);
      const first = await run(adapter, 'comment', { id, body: 'Run 42: 20 passed, 2 failed.', idempotencyKey: 'run-42-summary' });
      const again = await run(adapter, 'comment', { id, body: 'Run 42: 20 passed, 2 failed.', idempotencyKey: 'run-42-summary' });
      assertValid('tracker-comment-result', again);
      assert.equal(first.deduplicated, false);
      assert.equal(again.deduplicated, true);
      assert.equal(again.id, first.id);
      assert.equal(mock.commentsOn(id).filter((b) => /Run 42/.test(b)).length, 1);
      // a different key is a different comment
      await run(adapter, 'comment', { id, body: 'Run 43: all green.', idempotencyKey: 'run-43-summary' });
      assert.equal(mock.commentsOn(id).filter((b) => /Run 4[23]/.test(b)).length, 2);
    });

    test('create-bug with an idempotencyKey does not create a duplicate on repeat', async () => {
      const { mock, adapter } = fresh();
      const first = await run(adapter, 'create-bug', bugInput({ idempotencyKey: 'run-42-bug-1' }));
      const second = await run(adapter, 'create-bug', bugInput({ idempotencyKey: 'run-42-bug-1' }));
      assert.equal(first.deduplicated, false);
      assert.equal(second.deduplicated, true);
      assert.equal(second.id, first.id);
      assert.equal(mock.createdItems().length, 1);
    });

    test('create-test with an idempotencyKey does not create a duplicate on repeat', async () => {
      const { mock, adapter } = fresh();
      const parent = seed(mock);
      const first = await run(adapter, 'create-test', testInput(parent, { idempotencyKey: 'DEMO-101-TC-001' }));
      const second = await run(adapter, 'create-test', testInput(parent, { idempotencyKey: 'DEMO-101-TC-001' }));
      assert.equal(second.deduplicated, true);
      assert.equal(second.id, first.id);
      assert.equal(mock.createdItems().length, 1);
    });

    test('a lost response after a successful write is safe to retry with the same key', async () => {
      const { mock, adapter } = fresh();
      // The tracker creates the bug, then the connection drops before we hear about it.
      mock.inject({ method: 'POST', match: mock.paths.create, networkError: true, afterCommit: true });
      await rejectsWith(run(adapter, 'create-bug', bugInput({ idempotencyKey: 'run-7-bug-1' })), 'NETWORK', true);
      assert.equal(mock.createdItems().length, 1, 'the write did happen');

      const retry = await run(adapter, 'create-bug', bugInput({ idempotencyKey: 'run-7-bug-1' }));
      assert.equal(retry.deduplicated, true);
      assert.equal(retry.id, mock.createdItems()[0].id);
      assert.equal(mock.createdItems().length, 1, 'no duplicate');
    });

    test('keys are validated before any request', async () => {
      const { mock, adapter } = fresh();
      await rejectsWith(run(adapter, 'create-bug', bugInput({ idempotencyKey: 'has spaces!' })), 'VALIDATION', false);
      assert.equal(mock.calls.length, 0);
    });

    // ── Failure handling ───────────────────────────────────────────────────────

    test('writes are never retried automatically', async () => {
      const { mock, adapter } = fresh();
      mock.inject({ method: 'POST', match: mock.paths.create, status: 500 });
      await rejectsWith(run(adapter, 'create-bug', bugInput()), 'UPSTREAM_ERROR', true);
      assert.equal(mock.calls.filter((c) => c.method === 'POST').length, 1);
      assert.equal(mock.createdItems().length, 0);
    });

    test('reads are retried on transient failures', async () => {
      const { mock, adapter } = fresh();
      const id = seed(mock);
      mock.inject({ method: 'GET', match: mock.paths.ticket, status: 503, times: 2 });
      const ticket = await run(adapter, 'fetch', { id });
      assert.equal(ticket.id, id);
      assert.equal(mock.calls.filter((c) => c.method === 'GET' && new RegExp(mock.paths.ticket).test(c.path)).length, 3);
    });

    test('a search (a read, even where the tracker makes it a POST) retries transient failures', async () => {
      const { mock, adapter } = fresh();
      const id = seed(mock);
      mock.inject({ method: mock.searchMethod || 'GET', match: mock.paths.search, status: 503, times: 2 });
      const result = await run(adapter, 'search', { query: 'discount' });
      assert.ok(result.items.some((i) => i.id === id));
    });

    test('linking the same pair twice is harmless', async () => {
      const { mock, adapter } = fresh();
      const parent = seed(mock);
      const child = await run(adapter, 'create-test', testInput(parent));
      assert.equal((await run(adapter, 'link', { childId: child.id, parentId: parent })).linked, true);
      assert.equal((await run(adapter, 'link', { childId: child.id, parentId: parent })).linked, true);
    });

    test('a persistent read failure gives up as a retriable error', async () => {
      const { mock, adapter } = fresh();
      const id = seed(mock);
      mock.inject({ method: 'GET', match: mock.paths.ticket, status: 503, times: 50 });
      await rejectsWith(run(adapter, 'fetch', { id }), 'UPSTREAM_ERROR', true);
    });

    test('a slow write is TIMEOUT (retriable), not a hang', async () => {
      const { mock, adapter } = fresh({ timeoutMs: 40 });
      mock.inject({ method: 'POST', match: mock.paths.create, delayMs: 1000 });
      await rejectsWith(run(adapter, 'create-bug', bugInput()), 'TIMEOUT', true);
    });

    test('rate limiting is RATE_LIMITED (retriable)', async () => {
      const { mock, adapter } = fresh();
      mock.inject({ method: mock.searchMethod || 'GET', match: mock.paths.search, status: 429, times: 50 });
      await rejectsWith(run(adapter, 'search', { query: 'anything' }), 'RATE_LIMITED', true);
    });

    test('a dropped connection on a read is NETWORK (retriable) after retries', async () => {
      const { mock, adapter } = fresh();
      const id = seed(mock);
      mock.inject({ method: 'GET', match: mock.paths.ticket, networkError: true, times: 50 });
      await rejectsWith(run(adapter, 'fetch', { id }), 'NETWORK', true);
    });

    test('invalid input is rejected before any request', async () => {
      const { mock, adapter } = fresh();
      await rejectsWith(run(adapter, 'create-test', { parentId: '1', tcId: 'TC-001' }), 'VALIDATION', false);
      await rejectsWith(run(adapter, 'create-bug', { title: 'x' }), 'VALIDATION', false);
      await rejectsWith(run(adapter, 'create-test', testInput('1', { priority: 'Urgent' })), 'VALIDATION', false);
      await rejectsWith(run(adapter, 'frobnicate', {}), 'VALIDATION', false);
      assert.equal(mock.calls.length, 0);
    });
  });
}

module.exports = { runContractSuite };
