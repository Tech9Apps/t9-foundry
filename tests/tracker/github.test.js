'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createGithubMock } = require('../mocks/tracker-mock/github');
const { createAdapter, run } = require('../../scripts/tracker/adapters');
const { runContractSuite } = require('./contract-suite');

runContractSuite('github', () => createGithubMock());

describe('github: specifics', () => {
  const make = (mock) => createAdapter('github', { settings: mock.settings, env: { GITHUB_TOKEN: mock.token }, fetch: mock.fetch, baseUrl: mock.baseUrl, timeoutMs: 500, retryDelayMs: 0 });

  test('test issues are labelled with the test label and the parent id, and reference the parent', async () => {
    const mock = createGithubMock();
    const parent = mock.seedTicket({ title: 'Parent story' });
    await run(make(mock), 'create-test', { parentId: parent, tcId: 'TC-003', title: 'Edge', priority: 'Low' });
    const issue = mock.state.issues.get(Number(mock.createdItems()[0].id));
    assert.deepEqual(issue.labels.map((l) => l.name).sort(), ['1', 'test-case']);
    assert.match(issue.body, new RegExp(`Tests #${parent}`));
    assert.equal(issue.title, 'TC-003: Edge');
  });

  test('link is by reference in the body (GitHub has no link API) and makes no request', async () => {
    const mock = createGithubMock();
    const before = mock.calls.length;
    const result = await run(make(mock), 'link', { childId: '2', parentId: '1' });
    assert.deepEqual(result, { linked: true, method: 'reference-in-body' });
    assert.equal(mock.calls.length, before);
  });

  test('bugs get the bug label plus any extra labels, and a [BUG] title prefix', async () => {
    const mock = createGithubMock();
    await run(make(mock), 'create-bug', { title: 'Totals wrong', body: 'details', labels: ['checkout'] });
    const issue = mock.state.issues.get(Number(mock.createdItems()[0].id));
    assert.equal(issue.title, '[BUG] Totals wrong');
    assert.deepEqual(issue.labels.map((l) => l.name), ['bug', 'checkout']);
  });

  test('priority:* labels become the ticket priority; a bug label makes it a Bug', async () => {
    const mock = createGithubMock();
    const id = mock.seedTicket({ title: 'Crash', labels: ['bug', 'priority: High'] });
    const ticket = await run(make(mock), 'fetch', { id });
    assert.equal(ticket.type, 'Bug');
    assert.equal(ticket.priority, 'High');
  });

  test('a non-numeric issue id is rejected without a request', async () => {
    const mock = createGithubMock();
    await assert.rejects(run(make(mock), 'fetch', { id: 'ABC-1' }), (e) => e.code === 'VALIDATION');
    assert.equal(mock.calls.length, 0);
  });

  test('a malformed repo setting is a CONFIG error', () => {
    const mock = createGithubMock();
    assert.throws(() => createAdapter('github', { settings: { repo: 'not-a-repo' }, env: { GITHUB_TOKEN: 'x' }, fetch: mock.fetch }), (e) => e.code === 'CONFIG');
  });

  test('GH_TOKEN is accepted as a fallback for GITHUB_TOKEN', async () => {
    const mock = createGithubMock();
    const adapter = createAdapter('github', { settings: mock.settings, env: { GH_TOKEN: mock.token }, fetch: mock.fetch, baseUrl: mock.baseUrl, retryDelayMs: 0 });
    const id = mock.seedTicket({ title: 'x' });
    assert.equal((await run(adapter, 'fetch', { id })).id, id);
  });

  test('the token is sent as a Bearer header and never appears in a URL', async () => {
    const mock = createGithubMock();
    const id = mock.seedTicket({ title: 'x' });
    await run(make(mock), 'fetch', { id });
    for (const c of mock.calls) {
      assert.equal(c.headers.authorization, `Bearer ${mock.token}`);
      assert.ok(!c.path.includes(mock.token) && !c.search.includes(mock.token));
    }
  });
});
