'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createGitlabMock } = require('../mocks/tracker-mock/gitlab');
const { createAdapter, run } = require('../../scripts/tracker/adapters');
const { runContractSuite } = require('./contract-suite');
const { assertValid, rejectsWith } = require('./helpers');

runContractSuite('gitlab', () => createGitlabMock());

describe('gitlab: specifics', () => {
  const make = (mock, settings = {}) => createAdapter('gitlab', {
    settings: { ...mock.settings, ...settings }, env: { GITLAB_TOKEN: mock.token }, fetch: mock.fetch, baseUrl: mock.baseUrl, timeoutMs: 500, retryDelayMs: 0,
  });

  test('the token goes in the PRIVATE-TOKEN header and never appears in a URL', async () => {
    const mock = createGitlabMock();
    await run(make(mock), 'fetch', { id: mock.seedTicket({ title: 'x' }) });
    for (const c of mock.calls) {
      assert.equal(c.headers['private-token'], mock.token);
      assert.ok(!c.path.includes(mock.token) && !c.search.includes(mock.token));
    }
  });

  test('test issues carry the test label, the parent number and a priority label, and reference the parent', async () => {
    const mock = createGitlabMock();
    const parent = mock.seedTicket({ title: 'Parent' });
    await run(make(mock), 'create-test', { parentId: parent, tcId: 'TC-003', title: 'Edge', priority: 'Low' });
    const issue = mock.state.issues.get(Number(mock.createdItems()[0].id));
    assert.deepEqual(issue.labels, ['test-case', parent, 'priority:Low']);
    assert.equal(issue.title, 'TC-003: Edge');
    assert.match(issue.description, new RegExp(`Tests #${parent}`));
  });

  test('link creates a native "relates to" link, and a repeat (409) is not an error', async () => {
    const mock = createGitlabMock();
    const parent = mock.seedTicket({ title: 'Parent' });
    const child = await run(make(mock), 'create-test', { parentId: parent, tcId: 'TC-001', title: 't' });
    assert.deepEqual(await run(make(mock), 'link', { childId: child.id, parentId: parent }), { linked: true, method: 'native' });
    assert.deepEqual(await run(make(mock), 'link', { childId: child.id, parentId: parent }), { linked: true, method: 'native' });
    assert.equal(mock.state.links.size, 1);
    const post = mock.calls.find((c) => c.path.endsWith('/links'));
    assert.deepEqual(post.body, { target_project_id: 42, target_issue_iid: Number(parent), link_type: 'relates_to' });
  });

  test('a bug is titled "[BUG] …" and labelled bug + extra labels + priority', async () => {
    const mock = createGitlabMock();
    await run(make(mock), 'create-bug', { title: 'Totals wrong', body: 'details', priority: 'High', labels: ['checkout'] });
    const issue = mock.state.issues.get(Number(mock.createdItems()[0].id));
    assert.equal(issue.title, '[BUG] Totals wrong');
    assert.deepEqual(issue.labels, ['bug', 'checkout', 'priority:High']);
  });

  test('fetch ignores system notes, maps priority:* and bug labels', async () => {
    const mock = createGitlabMock();
    const id = mock.seedTicket({ title: 'Crash', labels: ['bug', 'priority:High'], comments: [{ author: 'pm', body: 'real comment' }] });
    mock.state.notes.get(Number(id)).push({ id: 1, body: 'changed the description', author: { username: 'x' }, system: true, created_at: 'x' });
    const ticket = await run(make(mock), 'fetch', { id });
    assertValid('tracker-ticket', ticket);
    assert.equal(ticket.type, 'Bug');
    assert.equal(ticket.priority, 'High');
    assert.deepEqual(ticket.comments.map((c) => c.body), ['real comment']);
    assert.equal(ticket.url, `https://gitlab.test/acme/shop/-/issues/${id}`);
  });

  test('the key lookup lists by label and does not rely on search', async () => {
    const mock = createGitlabMock();
    const parent = mock.seedTicket({ title: 'Parent' });
    await run(make(mock), 'create-test', { parentId: parent, tcId: 'TC-001', title: 't', idempotencyKey: 'k1' });
    const lists = mock.calls.filter((c) => c.method === 'GET' && c.path.endsWith('/issues'));
    assert.equal(lists[0].query.labels, `test-case,${parent}`);
    assert.equal(lists[0].query.state, 'all');
    assert.ok(!lists[0].query.search);
  });

  test('finds a keyed item that is more than one page old', async () => {
    const mock = createGitlabMock();
    const first = await run(make(mock), 'create-bug', { title: 'old', body: 'x', idempotencyKey: 'old-key' });
    for (let n = 0; n < 130; n += 1) mock.seedIssue({ title: `filler ${n}`, labels: ['bug'] });
    const again = await run(make(mock), 'create-bug', { title: 'old', body: 'x', idempotencyKey: 'old-key' });
    assert.deepEqual([again.deduplicated, again.id], [true, first.id]);
  });

  test('a project path ("group/app") is URL-encoded and resolved to its numeric id before linking', async () => {
    const urls = [];
    const spy = async (url, init) => { urls.push(String(url)); return new Response(JSON.stringify({ id: 42, iid: 1, web_url: 'u', title: 't', description: '', labels: [], state: 'opened' }), { status: 200 }); };
    const adapter = createAdapter('gitlab', { settings: { projectId: 'group/app' }, env: { GITLAB_TOKEN: 'x' }, fetch: spy, baseUrl: 'https://gitlab.test/api/v4', retryDelayMs: 0 });
    await run(adapter, 'link', { childId: '2', parentId: '1' });
    assert.ok(urls[0].endsWith('/projects/group%2Fapp'), `first call resolves the project: ${urls[0]}`);
    assert.ok(urls[1].includes('/projects/group%2Fapp/issues/2/links'), `link call: ${urls[1]}`);
  });

  test('the host setting builds the API root when no override is given', async () => {
    const urls = [];
    const spy = async (url) => { urls.push(String(url)); return new Response(String(url).includes('/notes') ? '[]' : '{"iid":1,"title":"t","state":"opened","labels":[]}', { status: 200 }); };
    const adapter = createAdapter('gitlab', { settings: { projectId: '7', host: 'https://git.example.org/' }, env: { GITLAB_TOKEN: 'x', QA_TRACKER_ALLOW_HOSTS: 'git.example.org' }, fetch: spy, retryDelayMs: 0 });
    await run(adapter, 'fetch', { id: '1' });
    assert.ok(urls[0].startsWith('https://git.example.org/api/v4/projects/7/issues/1'));
  });

  test('a non-numeric issue id is rejected without a request; projectId is required', async () => {
    const mock = createGitlabMock();
    await rejectsWith(run(make(mock), 'fetch', { id: 'ABC-1' }), 'VALIDATION', false);
    assert.equal(mock.calls.length, 0);
    assert.throws(() => createAdapter('gitlab', { settings: {}, env: { GITLAB_TOKEN: 'x' } }), (e) => e.code === 'CONFIG');
  });
});
