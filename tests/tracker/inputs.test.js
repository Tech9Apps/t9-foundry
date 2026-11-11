'use strict';
// What the adapters accept as input, and how an HTTP failure is classified. schemas/tracker-inputs.schema.json says what a valid input is and its
// header says it is "validated at runtime by contract.js"; until these tests it was not, for most fields: a `limit` of "10&page=9" went straight into a
// query string, a `parentId` of "../../list/999/task?x=" into a URL path. The table below is checked against the code AND against the schema, so the
// two cannot disagree again.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('../node_modules/ajv');
const { validate } = require('../../scripts/tracker/lib/contract');
const { fromStatus } = require('../../scripts/tracker/lib/errors');
const { request } = require('../../scripts/tracker/lib/http');
const { createAdapter, run } = require('../../scripts/tracker/adapters');
const { createGithubMock } = require('../mocks/tracker-mock/github');
const { createGitlabMock } = require('../mocks/tracker-mock/gitlab');
const { createClickupMock } = require('../mocks/tracker-mock/clickup');

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(require('../../schemas/tracker-inputs.schema.json'));
const schemaAccepts = (op, input) => ajv.compile({ $ref: `tracker-inputs.schema.json#/definitions/${op}` })(input);
const codeAccepts = (op, input) => { try { validate(op, input); return true; } catch (e) { if (e.code !== 'VALIDATION') throw e; return false; } };

const STEPS = [{ action: 'Add two items', expected: 'Cart shows $36.00' }, { action: 'Apply BREW10' }];
const TEST = { parentId: 'DEMO-101', tcId: 'TC-001', title: 'A valid code takes 10% off' };
const BUG = { title: 'Coupon stacks', body: 'Steps: apply twice.' };

// [operation, input, ok?, what it shows]
const CASES = [
  ['fetch', { id: 'DEMO-101' }, true], ['fetch', { id: 101 }, true], ['fetch', { id: '86abc12de' }, true], ['fetch', { id: 'a_b-c' }, true],
  ['fetch', { id: '../x' }, false, 'path traversal'], ['fetch', { id: 'a b' }, false, 'a space'], ['fetch', { id: 'x?y=1' }, false, 'a query string'],
  ['fetch', { id: 'x/y' }, false, 'a slash'], ['fetch', { id: '' }, false], ['fetch', { id: {} }, false], ['fetch', { id: 1.5 }, false], ['fetch', { id: ['1'] }, false],
  ['fetch', { id: 'a'.repeat(65) }, false, 'too long'], ['fetch', {}, false, 'missing'],

  ['search', { query: 'x' }, true], ['search', { query: 'x', kind: 'bug', limit: 100 }, true], ['search', { query: 'x', kind: 'test', limit: 1 }, true], ['search', { query: 'x', kind: 'any' }, true],
  ['search', { query: 'x', limit: '10&page=9' }, false, 'query-parameter injection through limit'], ['search', { query: 'x', limit: 0 }, false], ['search', { query: 'x', limit: 101 }, false],
  ['search', { query: 'x', limit: 1.5 }, false], ['search', { query: 'x', limit: -1 }, false], ['search', { query: 'x', limit: '5' }, false, 'a string is not an integer'],
  ['search', { query: 'x', kind: 'weird' }, false], ['search', { query: 'x', kind: 5 }, false], ['search', { query: '' }, false], ['search', { query: 5 }, false], ['search', {}, false],

  ['create-test', TEST, true], ['create-test', { ...TEST, priority: 'Low', description: 'd', steps: STEPS, idempotencyKey: 'DEMO-101-TC-001' }, true],
  ['create-test', { ...TEST, parentId: 101 }, true], ['create-test', { ...TEST, tcId: 'TC-A1-b' }, true],
  ['create-test', { ...TEST, parentId: '../../list/999/task?x=' }, false, 'path injection through the parent id'], ['create-test', { ...TEST, parentId: 'a b' }, false],
  ['create-test', { ...TEST, tcId: 'tc-001' }, false], ['create-test', { ...TEST, tcId: 'TC-' }, false], ['create-test', { ...TEST, tcId: 'TC-1/../x' }, false], ['create-test', { ...TEST, tcId: 'TC-1 2' }, false],
  ['create-test', { ...TEST, title: '' }, false], ['create-test', { ...TEST, title: 5 }, false], ['create-test', { ...TEST, title: { a: 1 } }, false], ['create-test', { ...TEST, description: 5 }, false],
  ['create-test', { ...TEST, steps: 'one' }, false], ['create-test', { ...TEST, steps: [5] }, false], ['create-test', { ...TEST, steps: [{}] }, false], ['create-test', { ...TEST, steps: [{ action: 5 }] }, false],
  ['create-test', { ...TEST, steps: [{ action: 'a', expected: 5 }] }, false], ['create-test', { ...TEST, priority: 'Urgent' }, false], ['create-test', { ...TEST, idempotencyKey: 'has space' }, false],
  ['create-test', { tcId: 'TC-001', title: 't' }, false, 'missing parent'],

  ['link', { childId: 'DEMO-102', parentId: 'DEMO-101' }, true], ['link', { childId: 2, parentId: 1 }, true],
  ['link', { childId: 'abc', parentId: '../../list/999/task?x=' }, false, 'path injection through the parent id'], ['link', { childId: 'a/b', parentId: 'c' }, false], ['link', { childId: 'a' }, false],

  ['comment', { id: 'DEMO-101', body: 'hello' }, true], ['comment', { id: 7, body: 'hello', idempotencyKey: 'results-DEMO-101-20260102T030405Z' }, true],
  ['comment', { id: 'x/y', body: 'hello' }, false], ['comment', { id: 'a', body: '' }, false], ['comment', { id: 'a', body: 5 }, false], ['comment', { id: 'a', body: 'b', idempotencyKey: 'a:b' }, false],

  ['create-bug', BUG, true], ['create-bug', { ...BUG, priority: 'High', labels: ['a', 'b'], idempotencyKey: 'bug-1' }, true],
  ['create-bug', { ...BUG, title: '' }, false], ['create-bug', { ...BUG, title: 5 }, false], ['create-bug', { ...BUG, body: '' }, false], ['create-bug', { ...BUG, body: [] }, false],
  ['create-bug', { ...BUG, labels: 'bug' }, false], ['create-bug', { ...BUG, labels: [5] }, false], ['create-bug', { ...BUG, priority: 'urgent' }, false],
];

describe('validate() accepts and refuses what the table says', () => {
  for (const [op, input, ok, why] of CASES) {
    test(`${op} ${JSON.stringify(input).slice(0, 90)} → ${ok ? 'accepted' : `refused${why ? ` (${why})` : ''}`}`, () => {
      assert.equal(codeAccepts(op, input), ok);
    });
  }
  test('a refusal is a VALIDATION TrackerError that names the field, so a caller can fix it', () => {
    for (const [op, input, field] of [['search', { query: 'x', limit: '10&page=9' }, 'limit'], ['fetch', { id: '../x' }, 'id'], ['create-test', { ...TEST, tcId: 'tc-1' }, 'tcId'], ['search', { query: 'x', kind: 'weird' }, 'kind'], ['link', { childId: 'a', parentId: 'b/c' }, 'parentId']]) {
      assert.throws(() => validate(op, input), (e) => e.name === 'TrackerError' && e.code === 'VALIDATION' && e.message.includes(field), `${op} ${field}`);
    }
  });
});

describe('the schema and validate() give the same answer for every case in the table', () => {
  for (const [op, input, ok] of CASES) {
    test(`${op} ${JSON.stringify(input).slice(0, 90)}`, () => {
      assert.equal(schemaAccepts(op, input), ok, 'schema');
      assert.equal(schemaAccepts(op, input), codeAccepts(op, input), 'schema vs code');
    });
  }
});

// ── input that reaches a URL ───────────────────────────────────────────────────────────────────────────
describe('adapters: input that would change the request is refused or neutralized before any request is made', () => {
  test('GitHub: a search qualifier typed into the query cannot widen the search to another repository', async () => {
    const mock = createGithubMock();
    const adapter = createAdapter('github', { settings: mock.settings, env: { [mock.tokenEnv]: mock.token }, fetch: mock.fetch, baseUrl: mock.baseUrl, retryDelayMs: 0 });
    await run(adapter, 'search', { query: 'foo repo:victim/private org:other user:x label:secret', kind: 'bug' });
    const q = mock.calls.find((c) => /\/search\/issues/.test(c.path)).query.q;
    assert.ok(!/(repo|org|user|label):/.test(q.replace(/repo:acme\/shop|label:bug|is:issue/g, '')), q);
    assert.match(q, /repo:acme\/shop/, 'the configured repository is still the only one searched');
    assert.match(q, /foo/);
  });
  test('GitLab: a parent id that is not a number is refused before anything is sent (it became target_issue_iid: null)', async () => {
    const mock = createGitlabMock();
    const adapter = createAdapter('gitlab', { settings: mock.settings, env: { [mock.tokenEnv]: mock.token }, fetch: mock.fetch, baseUrl: mock.baseUrl, retryDelayMs: 0 });
    const child = mock.seedTicket({ title: 'c' });
    const calls = mock.calls.length;
    await assert.rejects(run(adapter, 'link', { childId: child, parentId: 'abc' }), (e) => e.code === 'VALIDATION');
    assert.equal(mock.calls.length, calls, 'no request was made');
  });
  test('ClickUp: link cannot be steered to another path through the parent id', async () => {
    const mock = createClickupMock();
    const adapter = createAdapter('clickup', { settings: mock.settings, env: { [mock.tokenEnv]: mock.token }, fetch: mock.fetch, baseUrl: mock.baseUrl, retryDelayMs: 0 });
    const child = mock.seedTicket({ title: 'c' });
    await assert.rejects(run(adapter, 'link', { childId: child, parentId: '../../list/999/task?x=' }), (e) => e.code === 'VALIDATION');
    assert.equal(mock.calls.filter((c) => /link/.test(c.path)).length, 0);
  });
});

// ── HTTP failures ──────────────────────────────────────────────────────────────────────────────────────
describe('an HTTP failure is classified by what repeating it can achieve', () => {
  const classify = (status, body = '') => { const e = fromStatus(status, body, 'do a thing'); return [e.code, e.retriable]; };
  test('the statuses with a specific meaning keep it', () => {
    assert.deepEqual(classify(401), ['UNAUTHENTICATED', false]);
    assert.deepEqual(classify(403), ['FORBIDDEN', false]);
    assert.deepEqual(classify(403, 'API rate limit exceeded'), ['RATE_LIMITED', true]);
    assert.deepEqual(classify(404), ['NOT_FOUND', false]);
    assert.deepEqual(classify(429), ['RATE_LIMITED', true]);
    for (const s of [400, 409, 422]) assert.deepEqual(classify(s), ['VALIDATION', false], String(s));
  });
  test('a request that timed out at the server, or was sent too early, may be repeated', () => {
    assert.deepEqual(classify(408), ['TIMEOUT', true]);
    assert.deepEqual(classify(425), ['RATE_LIMITED', true]);
  });
  test('every OTHER 4xx (405, 410 issues disabled, 413 body too large, 451, 418 ...) is a refusal repeating will not change: not retriable', () => {
    for (const s of [402, 405, 406, 410, 411, 412, 413, 414, 415, 416, 417, 418, 423, 424, 426, 428, 431, 451]) assert.deepEqual(classify(s), ['VALIDATION', false], String(s));
  });
  test('5xx is the tracker\'s fault and may be repeated', () => {
    for (const s of [500, 502, 503, 504, 507, 599]) assert.deepEqual(classify(s), ['UPSTREAM_ERROR', true], String(s));
  });
  test('the status is kept on the error, and the message names it', () => {
    const e = fromStatus(410, 'Issues are disabled for this repo', 'create GitHub bug');
    assert.equal(e.status, 410);
    assert.match(e.message, /create GitHub bug failed with HTTP 410: Issues are disabled/);
  });
  const response = (status) => ({ status, ok: status < 300, headers: { get: () => null }, text: async () => '{}' });
  test('end to end: a GET that gets a refusal is made once; one that gets a 503 is repeated; a POST is never repeated either way', async () => {
    for (const [status, gets] of [[410, 1], [405, 1], [413, 1], [503, 3], [429, 3], [408, 3]]) {
      const seen = { GET: 0, POST: 0 };
      const fetch = async (url, init) => { seen[init.method] += 1; return response(status); };
      await assert.rejects(request({ fetch, method: 'GET', url: 'https://api.example.test/x', retryDelayMs: 0, what: 'read' }));
      await assert.rejects(request({ fetch, method: 'POST', url: 'https://api.example.test/x', body: {}, retryDelayMs: 0, what: 'write' }));
      assert.deepEqual(seen, { GET: gets, POST: 1 }, `HTTP ${status}`);
    }
  });
});
