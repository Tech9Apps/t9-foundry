'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createAzureMock } = require('../mocks/tracker-mock/azure');
const { createAdapter, run } = require('../../scripts/tracker/adapters');
const { runContractSuite } = require('./contract-suite');
const { assertValid, rejectsWith } = require('./helpers');

runContractSuite('azure', () => createAzureMock());

describe('azure: specifics', () => {
  const make = (mock, over = {}) => createAdapter('azure', {
    settings: { ...mock.settings, ...(over.settings || {}) }, env: { AZURE_DEVOPS_PAT: mock.pat }, fetch: mock.fetch, baseUrl: mock.baseUrl, timeoutMs: 500, retryDelayMs: 0,
  });
  const steps = [{ action: 'Add <two> items & go', expected: 'Cart shows $36.00' }, { action: 'Apply BREW10', expected: 'Discount is $3.60' }];

  test('auth is Basic with an empty username and the PAT as the password', async () => {
    const mock = createAzureMock();
    await run(make(mock), 'fetch', { id: mock.seedTicket({ title: 'x' }) });
    const expected = `Basic ${Buffer.from(`:${mock.pat}`).toString('base64')}`;
    assert.ok(mock.calls.every((c) => c.headers.authorization === expected));
    assert.ok(mock.calls.every((c) => !c.path.includes(mock.pat) && !c.search.includes(mock.pat)));
  });

  test('writes use application/json-patch+json', async () => {
    const mock = createAzureMock();
    await run(make(mock), 'create-bug', { title: 'x', body: 'y' });
    const post = mock.calls.find((c) => c.method === 'POST');
    assert.match(post.headers['content-type'], /json-patch\+json/);
  });

  test('a test case inherits area and iteration from its parent and gets steps as XML (escaped)', async () => {
    const mock = createAzureMock();
    const parent = mock.seedTicket({ title: 'Parent' });
    mock.state.items.get(Number(parent)).fields['System.AreaPath'] = 'shop\\Payments';
    mock.state.items.get(Number(parent)).fields['System.IterationPath'] = 'shop\\Sprint 9';
    const created = await run(make(mock), 'create-test', { parentId: parent, tcId: 'TC-001', title: 'Percent code', priority: 'Medium', steps });
    const f = mock.state.items.get(Number(created.id)).fields;
    assert.equal(f['System.WorkItemType'], 'Test Case');
    assert.equal(f['System.AreaPath'], 'shop\\Payments');
    assert.equal(f['System.IterationPath'], 'shop\\Sprint 9');
    assert.equal(f['Microsoft.VSTS.Common.Priority'], 2);
    const xml = f['Microsoft.VSTS.TCM.Steps'];
    assert.match(xml, /^<steps id="0" last="2">/);
    assert.match(xml, /Add &lt;two&gt; items &amp; go/, 'special characters must be escaped, or the XML is invalid');
  });

  test('link adds a TestedBy-Reverse relation, and linking twice is not an error', async () => {
    const mock = createAzureMock();
    const parent = mock.seedTicket({ title: 'Parent' });
    const child = await run(make(mock), 'create-test', { parentId: parent, tcId: 'TC-001', title: 't' });
    assert.deepEqual(await run(make(mock), 'link', { childId: child.id, parentId: parent }), { linked: true, method: 'native' });
    assert.deepEqual(await run(make(mock), 'link', { childId: child.id, parentId: parent }), { linked: true, method: 'native' });
    const rels = mock.state.items.get(Number(child.id)).relations;
    assert.equal(rels.length, 1);
    assert.equal(rels[0].rel, 'Microsoft.VSTS.Common.TestedBy-Reverse');
    assert.match(rels[0].url, new RegExp(`/workitems/${parent}$`));
  });

  test('the idempotency key is stored as a tag, alongside any labels', async () => {
    const mock = createAzureMock();
    const bug = await run(make(mock), 'create-bug', { title: 'x', body: 'y', labels: ['checkout'], idempotencyKey: 'run-1' });
    assert.equal(mock.state.items.get(Number(bug.id)).fields['System.Tags'], 'checkout; qa-key-run-1');
  });

  test('bugs keep their title as given (the work item type already says "Bug") and put the report in ReproSteps', async () => {
    const mock = createAzureMock();
    const bug = await run(make(mock), 'create-bug', { title: 'Coupon stacks', body: 'line one\nline two <b>', priority: 'High' });
    const f = mock.state.items.get(Number(bug.id)).fields;
    assert.equal(f['System.WorkItemType'], 'Bug');
    assert.equal(f['System.Title'], 'Coupon stacks');
    assert.equal(f['Microsoft.VSTS.TCM.ReproSteps'], '<div>line one<br>line two &lt;b&gt;</div>');
    assert.equal(f['Microsoft.VSTS.Common.Priority'], 1);
  });

  test('fetch strips HTML, prefers the AcceptanceCriteria field, and normalizes tags, attachments and children', async () => {
    const mock = createAzureMock();
    const id = mock.seedTicket({ title: 'Story', description: 'Plain <b>bold</b> &amp; text', acceptance: '1. First\n2. Second' });
    const wi = mock.state.items.get(Number(id));
    wi.fields['System.Tags'] = 'alpha; beta';
    wi.relations = [
      { rel: 'AttachedFile', url: 'https://files.test/a.png', attributes: { name: 'a.png' } },
      { rel: 'System.LinkTypes.Hierarchy-Forward', url: `${mock.baseUrl}/acme/shop/_apis/wit/workItems/555` },
    ];
    const ticket = await run(make(mock), 'fetch', { id });
    assertValid('tracker-ticket', ticket);
    assert.equal(ticket.description, 'Plain bold & text');
    assert.match(ticket.acceptanceCriteria, /1\. First\n2\. Second/);
    assert.deepEqual(ticket.labels, ['alpha', 'beta']);
    assert.deepEqual(ticket.attachments, [{ name: 'a.png', url: 'https://files.test/a.png' }]);
    assert.deepEqual(ticket.subtasks, [{ id: '555', title: '' }]);
    assert.equal(ticket.type, 'User Story');
    assert.equal(ticket.priority, '2');
  });

  test('quotes in a search query cannot break out of the WIQL string', async () => {
    const mock = createAzureMock();
    mock.seedTicket({ title: "O'Brien's checkout" });
    const result = await run(make(mock), 'search', { query: "O'Brien" });
    assert.equal(result.items.length, 1);
    const wiql = mock.calls.find((c) => /wiql/.test(c.path)).body.query;
    assert.match(wiql, /CONTAINS 'O''Brien'/);
  });

  test('search(kind: test) only returns Test Case work items', async () => {
    const mock = createAzureMock();
    const parent = mock.seedTicket({ title: 'discount story' });
    await run(make(mock), 'create-test', { parentId: parent, tcId: 'TC-001', title: 'discount case' });
    const result = await run(make(mock), 'search', { query: 'discount', kind: 'test' });
    assert.equal(result.items.length, 1);
    assert.match(result.items[0].title, /^TC-001/);
  });

  test('a non-numeric work item id is rejected without a request', async () => {
    const mock = createAzureMock();
    await rejectsWith(run(make(mock), 'fetch', { id: 'ABC-1' }), 'VALIDATION', false);
    assert.equal(mock.calls.length, 0);
  });

  test('organization and project are required, and are URL-encoded', async () => {
    const mock = createAzureMock();
    assert.throws(() => createAdapter('azure', { settings: { organization: 'acme' }, env: { AZURE_DEVOPS_PAT: 'x' } }), (e) => e.code === 'CONFIG');
    const tricky = createAzureMock({ project: 'My Project' });
    const id = tricky.seedTicket({ title: 'x' });
    await run(make(tricky, { settings: { project: 'My Project' } }), 'fetch', { id });
    assert.ok(tricky.calls[0].path.startsWith('/acme/My Project/_apis/wit/workitems/'));
    void mock;
  });
});
