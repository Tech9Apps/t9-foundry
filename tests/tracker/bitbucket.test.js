'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createBitbucketMock, evaluateBbql } = require('../mocks/tracker-mock/bitbucket');
const { createAdapter, run } = require('../../scripts/tracker/adapters');
const { runContractSuite } = require('./contract-suite');
const { assertValid, rejectsWith } = require('./helpers');

runContractSuite('bitbucket', () => createBitbucketMock());

describe('bitbucket: specifics', () => {
  const make = (mock, settings = {}) => createAdapter('bitbucket', {
    settings: { ...mock.settings, ...settings }, env: { BITBUCKET_TOKEN: mock.token }, fetch: mock.fetch, baseUrl: mock.baseUrl, timeoutMs: 500, retryDelayMs: 0,
  });

  test('auth is Basic username:app-password, and neither appears in a URL', async () => {
    const mock = createBitbucketMock();
    await run(make(mock), 'fetch', { id: mock.seedTicket({ title: 'x' }) });
    const expected = `Basic ${Buffer.from(`qa-bot:${mock.token}`).toString('base64')}`;
    for (const c of mock.calls) {
      assert.equal(c.headers.authorization, expected);
      assert.ok(!c.path.includes(mock.token) && !c.search.includes(mock.token));
    }
  });

  test('a missing username is a CONFIG error that explains why (app passwords need it)', () => {
    const mock = createBitbucketMock();
    assert.throws(() => createAdapter('bitbucket', { settings: { workspace: 'acme', repo: 'shop' }, env: { BITBUCKET_TOKEN: 'x' } }), (e) => e.code === 'CONFIG' && /username:app_password/.test(e.message));
    assert.equal(mock.calls.length, 0);
  });

  test('workspace and repo are required', () => {
    assert.throws(() => createAdapter('bitbucket', { settings: { username: 'u' }, env: { BITBUCKET_TOKEN: 'x' } }), (e) => e.code === 'CONFIG');
  });

  test('a test case is a "task" titled with its TC id; its priority maps High→major, Medium→minor, Low→trivial', async () => {
    const mock = createBitbucketMock();
    const adapter = make(mock);
    const parent = mock.seedTicket({ title: 'Parent' });
    for (const [priority, expected] of [['High', 'major'], ['Medium', 'minor'], ['Low', 'trivial'], [undefined, 'minor']]) {
      const c = await run(adapter, 'create-test', { parentId: parent, tcId: 'TC-9', title: 't', priority });
      assert.equal(mock.state.issues.get(Number(c.id)).priority, expected);
      assert.equal(mock.state.issues.get(Number(c.id)).kind, 'task');
    }
    assert.match(mock.state.issues.get(Number(mock.createdItems()[0].id)).content.raw, new RegExp(`Tests #${parent}`));
  });

  test('a bug is a "bug" with its own priority scale (High→critical, Medium→major, Low→minor) and an unprefixed title', async () => {
    const mock = createBitbucketMock();
    const adapter = make(mock);
    for (const [priority, expected] of [['High', 'critical'], ['Medium', 'major'], ['Low', 'minor']]) {
      const b = await run(adapter, 'create-bug', { title: `Bug ${priority}`, body: 'details', priority });
      const issue = mock.state.issues.get(Number(b.id));
      assert.deepEqual([issue.kind, issue.priority, issue.title], ['bug', expected, `Bug ${priority}`]);
    }
  });

  test('link is by reference in the body (Bitbucket has no link API) and makes no request', async () => {
    const mock = createBitbucketMock();
    assert.deepEqual(await run(make(mock), 'link', { childId: '2', parentId: '1' }), { linked: true, method: 'reference-in-body' });
    assert.equal(mock.calls.length, 0);
  });

  test('fetch normalizes kind, state, priority, component, and skips deleted comments', async () => {
    const mock = createBitbucketMock();
    const id = mock.seedTicket({ title: 'Crash', description: 'd', acceptance: '1. a\n2. b', comments: [{ author: 'pm', body: 'kept' }] });
    const issue = mock.state.issues.get(Number(id));
    Object.assign(issue, { kind: 'bug', priority: 'critical', state: 'open', component: { name: 'checkout' } });
    mock.state.comments.get(Number(id)).push({ id: 1, content: { raw: 'removed' }, user: { display_name: 'x' }, deleted: true, created_on: 'x' });
    const ticket = await run(make(mock), 'fetch', { id });
    assertValid('tracker-ticket', ticket);
    assert.deepEqual([ticket.type, ticket.status, ticket.priority, ticket.labels], ['Bug', 'open', 'critical', ['checkout']]);
    assert.deepEqual(ticket.comments.map((c) => c.body), ['kept']);
    assert.match(ticket.acceptanceCriteria, /1\. a\n2\. b/);
  });

  test('quotes and backslashes in a search query cannot break out of the BBQL string', async () => {
    const mock = createBitbucketMock();
    mock.seedTicket({ title: 'He said "stop" \\ now' });
    const result = await run(make(mock), 'search', { query: 'said "stop" \\ now' });
    assert.equal(result.items.length, 1);
    assert.match(decodeURIComponent(mock.calls[0].search), /title ~ "said \\"stop\\" \\\\ now"/);
  });

  test('search(kind: test) returns only TC-titled tasks; search(kind: bug) only bugs', async () => {
    const mock = createBitbucketMock();
    const parent = mock.seedTicket({ title: 'discount story' });
    await run(make(mock), 'create-test', { parentId: parent, tcId: 'TC-001', title: 'discount case' });
    await run(make(mock), 'create-bug', { title: 'discount bug', body: 'x' });
    assert.deepEqual((await run(make(mock), 'search', { query: 'discount', kind: 'test' })).items.map((i) => i.title), ['TC-001: discount case']);
    assert.deepEqual((await run(make(mock), 'search', { query: 'discount', kind: 'bug' })).items.map((i) => i.title), ['discount bug']);
  });

  test('the key lookup lists newest-first by kind (test cases narrowed by TC id) and finds items past page one', async () => {
    const mock = createBitbucketMock();
    const adapter = make(mock);
    const first = await run(adapter, 'create-bug', { title: 'old', body: 'x', idempotencyKey: 'old-key' });
    for (let n = 0; n < 130; n += 1) mock.seedIssue({ title: `filler ${n}`, kind: 'bug' });
    const again = await run(adapter, 'create-bug', { title: 'old', body: 'x', idempotencyKey: 'old-key' });
    assert.deepEqual([again.deduplicated, again.id], [true, first.id]);

    const parent = mock.seedTicket({ title: 'P' });
    await run(adapter, 'create-test', { parentId: parent, tcId: 'TC-004', title: 't', idempotencyKey: 'k4' });
    const lookup = mock.calls.filter((c) => c.method === 'GET' && c.query.q && c.query.q.includes('TC-004')).pop();
    assert.match(lookup.query.q, /kind = "task" AND title ~ "TC-004:"/);
    assert.equal(lookup.query.sort, '-created_on');
  });

  test('a non-numeric issue id is rejected without a request', async () => {
    const mock = createBitbucketMock();
    await rejectsWith(run(make(mock), 'fetch', { id: 'ABC-1' }), 'VALIDATION', false);
    assert.equal(mock.calls.length, 0);
  });

  test('a repository with its issue tracker disabled / wrong repo is NOT_FOUND', async () => {
    const mock = createBitbucketMock();
    await rejectsWith(run(make(mock, { repo: 'nope' }), 'fetch', { id: '1' }), 'NOT_FOUND', false);
  });
});

describe('bitbucket mock: the BBQL evaluator the tests rely on', () => {
  const issue = { kind: 'bug', title: 'Totals wrong', state: 'new', content: { raw: 'qa-harness-key:abc' } };
  test('= != ~ AND OR and parentheses', () => {
    assert.equal(evaluateBbql('kind = "bug"', issue), true);
    assert.equal(evaluateBbql('kind != "bug"', issue), false);
    assert.equal(evaluateBbql('title ~ "TOTALS"', issue), true, '~ is case-insensitive contains');
    assert.equal(evaluateBbql('kind = "task" OR title ~ "wrong"', issue), true);
    assert.equal(evaluateBbql('(kind = "task" OR title ~ "wrong") AND state = "new"', issue), true);
    assert.equal(evaluateBbql('kind = "bug" AND (title ~ "nope" OR content.raw ~ "zzz")', issue), false);
    assert.equal(evaluateBbql('content.raw ~ "qa-harness-key:abc"', issue), true);
  });
});
