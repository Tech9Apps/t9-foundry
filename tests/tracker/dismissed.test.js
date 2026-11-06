'use strict';
// "Closed" is not one thing. A bug closed because it was FIXED that later reappears is a regression; a bug closed because nobody will
// fix it ("won't fix", "not planned", "rejected", "duplicate") that reappears is not — filing it again every run, or commenting on it
// forever, is noise. Each tracker says "dismissed" in its own words; these tests pin each adapter's reading of them.
// (The behavior every adapter shares is in contract-suite.js; this is the per-tracker vocabulary.)

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter, run } = require('../../scripts/tracker/adapters');
const { createGithubMock } = require('../mocks/tracker-mock/github');
const { createGitlabMock } = require('../mocks/tracker-mock/gitlab');
const { createBitbucketMock } = require('../mocks/tracker-mock/bitbucket');
const { createClickupMock } = require('../mocks/tracker-mock/clickup');
const { createAzureMock } = require('../mocks/tracker-mock/azure');

const build = (mock) => createAdapter(mock.source, { settings: mock.settings, env: { [mock.tokenEnv]: mock.token }, fetch: mock.fetch, baseUrl: mock.baseUrl, timeoutMs: 500, retryDelayMs: 0 });

// file a bug through the adapter, let the test put it in a state, and read it back through search
async function stateOf(make, setState) {
  const mock = make(); const adapter = build(mock);
  const bug = await run(adapter, 'create-bug', { title: 'Receipt total is wrong on refunds', body: 'Steps: refund an order.', priority: 'High' });
  setState(mock, bug.id);
  const { items } = await run(adapter, 'search', { query: 'Receipt', kind: 'bug' });
  const item = items.find((i) => i.id === bug.id);
  assert.ok(item, 'the bug is found');
  return { open: item.open, dismissed: item.dismissed === true };
}
const expectState = async (make, setState, expected) => assert.deepEqual(await stateOf(make, setState), expected);
const OPEN = { open: true, dismissed: false };
const FIXED = { open: false, dismissed: false };
const DISMISSED = { open: false, dismissed: true };

describe('github: "Close as not planned" and the default wontfix/invalid/duplicate labels', () => {
  const closeWith = (reason, labels = []) => (mock, id) => { const i = mock.state.issues.get(Number(id)); i.state = 'closed'; i.state_reason = reason; i.labels = [...i.labels, ...labels.map((name) => ({ name }))]; }; // ADD labels: the "bug" label is what search(kind: bug) looks for
  test('closed as completed is fixed', () => expectState(createGithubMock, closeWith('completed'), FIXED));
  test('closed with no reason at all (older issues) is fixed', () => expectState(createGithubMock, closeWith(null), FIXED));
  test('closed as not planned is dismissed', () => expectState(createGithubMock, closeWith('not_planned'), DISMISSED));
  for (const label of ['wontfix', 'WontFix', 'invalid', 'duplicate']) {
    test(`closed and labelled "${label}" is dismissed even when the reason says completed`, () => expectState(createGithubMock, closeWith('completed', [label]), DISMISSED));
  }
  test('an OPEN issue labelled wontfix is still open (nobody has closed it), so it is commented on, not skipped', () => expectState(createGithubMock, (mock, id) => { const i = mock.state.issues.get(Number(id)); i.labels = [...i.labels, { name: 'wontfix' }]; }, OPEN));
  test('an unrelated label does not dismiss', () => expectState(createGithubMock, closeWith('completed', ['bug', 'priority: high']), FIXED));
});

describe('gitlab: no resolution exists, so the team\'s own labels are the signal', () => {
  const closeWith = (labels) => (mock, id) => { const i = mock.state.issues.get(Number(id)); i.state = 'closed'; i.labels = [...i.labels, ...labels]; };
  test('closed with no label is fixed', () => expectState(createGitlabMock, closeWith([]), FIXED));
  for (const label of ['wontfix', 'invalid', 'duplicate', 'Not a bug']) {
    test(`closed and labelled "${label}" is dismissed`, () => expectState(createGitlabMock, closeWith([label]), DISMISSED));
  }
  test('an opened issue labelled wontfix is still open', () => expectState(createGitlabMock, (mock, id) => { const i = mock.state.issues.get(Number(id)); i.labels = [...i.labels, 'wontfix']; }, OPEN));
});

describe('bitbucket: its own resolutions', () => {
  const setState = (st) => (mock, id) => { mock.state.issues.get(Number(id)).state = st; };
  for (const [st, expected] of [['new', OPEN], ['open', OPEN], ['on hold', OPEN], ['resolved', FIXED], ['closed', FIXED], ['wontfix', DISMISSED], ['invalid', DISMISSED], ['duplicate', DISMISSED]]) {
    test(`state "${st}" is ${expected === OPEN ? 'open' : expected === FIXED ? 'fixed' : 'dismissed'}`, () => expectState(createBitbucketMock, setState(st), expected));
  }
});

describe('clickup: statuses are whatever the workspace named them (type "custom"), so the wording decides', () => {
  const setStatus = (status, type = 'custom') => (mock, id) => { mock.state.tasks.get(String(id)).status = { status, type }; };
  for (const status of ['Rejected', "Won't do", 'Wont fix', 'Cancelled', 'Canceled', 'Declined', 'Invalid', 'Duplicate', 'Not a bug', 'By design', 'Obsolete', 'Dismissed']) {
    test(`"${status}" is dismissed — it used to read as OPEN, so a bug that came back was commented on forever`, () => expectState(createClickupMock, setStatus(status), DISMISSED));
  }
  for (const status of ['to do', 'In progress', 'In review', 'Blocked', 'Will do']) {
    test(`"${status}" is open`, () => expectState(createClickupMock, setStatus(status), OPEN));
  }
  for (const [status, type] of [['complete', 'closed'], ['Done', 'done'], ['Closed', 'closed'], ['Shipped', 'done']]) {
    test(`"${status}" (${type}) is fixed, not dismissed`, () => expectState(createClickupMock, setStatus(status, type), FIXED));
  }
});

describe('azure: State plus the close Reason', () => {
  const set = (state, reason) => (mock, id) => { const w = mock.state.items.get(Number(id)); w.fields['System.State'] = state; w.fields['System.Reason'] = reason; };
  test('Active is open', () => expectState(createAzureMock, set('Active', 'New defect reported'), OPEN));
  test('Closed / Fixed is fixed', () => expectState(createAzureMock, set('Closed', 'Fixed'), FIXED));
  test('Resolved / Fixed is fixed', () => expectState(createAzureMock, set('Resolved', 'Fixed'), FIXED));
  for (const reason of ['Will not Fix', 'As Designed', 'Duplicate', 'Obsolete', 'Not a Bug']) {
    test(`Resolved / ${reason} is dismissed`, () => expectState(createAzureMock, set('Resolved', reason), DISMISSED));
  }
  test('Removed (taken off the backlog) is dismissed whatever the reason', () => expectState(createAzureMock, set('Removed', ''), DISMISSED));
  test('"Cannot Reproduce" and "Deferred" are NOT dismissed: a recurrence there is worth a new report', () => {
    return Promise.all([
      expectState(createAzureMock, set('Resolved', 'Cannot Reproduce'), FIXED),
      expectState(createAzureMock, set('Resolved', 'Deferred'), FIXED),
    ]);
  });
  test('a "won\'t fix" reason on an item that is still Active does not dismiss it (nobody closed it)', () => expectState(createAzureMock, set('Active', 'Will not Fix'), OPEN));
});
