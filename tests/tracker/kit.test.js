'use strict';
// scripts/tracker/lib/kit.js: the pieces every adapter was writing for itself. The adapters' own behaviour is covered by the contract suite;
// these check each piece alone, including the edges the adapters hit (no key, no steps, a short page, a custom token variable).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  LIST_PAGES, PAGE_SIZE, withMarker, requireNumericId, requireToken, testCaseBody, priorityFromLabels, summary, linkByReference,
  isDuplicateLink, eachPage, apiCall,
} = require('../../scripts/tracker/lib/kit');
const { keyMarker } = require('../../scripts/tracker/lib/contract');
const { TrackerError } = require('../../scripts/tracker/lib/errors');

const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e instanceof TrackerError ? [e.code, e.message] : ['NOT_A_TRACKER_ERROR', e.message]; } };

describe('withMarker', () => {
  test('appends the idempotency marker after a blank line', () => {
    assert.equal(withMarker('body', 'k-1'), `body\n\n${keyMarker('k-1')}`);
  });
  test('without a key the text is returned untouched', () => {
    assert.equal(withMarker('body'), 'body');
    assert.equal(withMarker('body', undefined), 'body');
    assert.equal(withMarker('body', ''), 'body');
  });
  test('a key that is not a valid key is refused, never written', () => {
    assert.equal(codeOf(() => withMarker('body', 'has space'))[0], 'VALIDATION');
  });
});

describe('requireNumericId', () => {
  test('accepts digits, as a string or a number, and returns them as a string', () => {
    assert.equal(requireNumericId('GitHub issue', '42'), '42');
    assert.equal(requireNumericId('GitHub issue', 42), '42');
  });
  test('refuses anything else with a VALIDATION error naming the kind of id and the value', () => {
    for (const bad of ['abc', '1/2', '', ' 1', '1 ', '-1', '1.5', '../x', undefined, null]) {
      const [code, message] = codeOf(() => requireNumericId('GitLab issue', bad));
      assert.equal(code, 'VALIDATION', String(bad));
      assert.equal(message, `GitLab issue ids are numbers (got "${bad}")`);
    }
  });
});

describe('requireToken', () => {
  test('reads the default variable', () => {
    assert.equal(requireToken({ settings: {}, env: { GITLAB_TOKEN: 'abc' }, defaultVar: 'GITLAB_TOKEN' }), 'abc');
  });
  test('settings.tokenEnvVar names another variable, and the default is then ignored', () => {
    assert.equal(requireToken({ settings: { tokenEnvVar: 'MY_TOKEN' }, env: { MY_TOKEN: 'mine', GITLAB_TOKEN: 'theirs' }, defaultVar: 'GITLAB_TOKEN' }), 'mine');
    assert.equal(codeOf(() => requireToken({ settings: { tokenEnvVar: 'MY_TOKEN' }, env: { GITLAB_TOKEN: 'theirs' }, defaultVar: 'GITLAB_TOKEN' }))[1], 'MY_TOKEN is not set');
  });
  test('a missing or empty token is a CONFIG error naming the variable', () => {
    assert.deepEqual(codeOf(() => requireToken({ settings: {}, env: {}, defaultVar: 'CLICKUP_TOKEN' })), ['CONFIG', 'CLICKUP_TOKEN is not set']);
    assert.deepEqual(codeOf(() => requireToken({ settings: {}, env: { CLICKUP_TOKEN: '' }, defaultVar: 'CLICKUP_TOKEN' })), ['CONFIG', 'CLICKUP_TOKEN is not set']);
  });
  test('fallback variables are tried in order after the chosen one, and the hint goes into the message', () => {
    const args = { settings: {}, defaultVar: 'GITHUB_TOKEN', fallbacks: ['GITHUB_TOKEN', 'GH_TOKEN'], hint: '(or GH_TOKEN)' };
    assert.equal(requireToken({ ...args, env: { GH_TOKEN: 'gh' } }), 'gh');
    assert.equal(requireToken({ ...args, env: { GITHUB_TOKEN: 'a', GH_TOKEN: 'b' } }), 'a');
    assert.equal(requireToken({ ...args, env: { GITHUB_TOKEN: '', GH_TOKEN: 'gh' } }), 'gh', 'an empty variable counts as unset, so the next one is tried');
    assert.equal(requireToken({ ...args, settings: { tokenEnvVar: 'X' }, env: { X: 'x', GITHUB_TOKEN: 'a' } }), 'x');
    assert.deepEqual(codeOf(() => requireToken({ ...args, env: {} })), ['CONFIG', 'GITHUB_TOKEN (or GH_TOKEN) is not set']);
  });
});

describe('testCaseBody', () => {
  const steps = [{ action: 'Add two items', expected: 'Cart shows $36.00' }, { action: 'Apply BREW10' }];
  test('names the parent, then priority, description and numbered steps', () => {
    assert.equal(testCaseBody({ parentId: '7', priority: 'High', description: 'Checks it.', steps }),
      'Tests #7\n**Priority:** High\n\nChecks it.\n\n### Steps\n1. Add two items — Expected: Cart shows $36.00\n2. Apply BREW10');
  });
  test('leaves out what was not given', () => {
    assert.equal(testCaseBody({ parentId: '7' }), 'Tests #7');
    assert.equal(testCaseBody({ parentId: '7', steps: [] }), 'Tests #7');
    assert.equal(testCaseBody({ parentId: '7', description: '' }), 'Tests #7');
    assert.equal(testCaseBody({ parentId: '7', priority: 'Low' }), 'Tests #7\n**Priority:** Low');
  });
  test('with the marker added, the key sits after a blank line', () => {
    assert.ok(withMarker(testCaseBody({ parentId: '7', description: 'd' }), 'k-1').endsWith(`\n\n${keyMarker('k-1')}`));
  });
});

describe('priorityFromLabels', () => {
  test('reads a "priority:" label, whatever its case or spacing', () => {
    assert.equal(priorityFromLabels(['bug', 'priority:High']), 'High');
    assert.equal(priorityFromLabels(['Priority: Low']), 'Low');
    assert.equal(priorityFromLabels(['PRIORITY:  Medium']), 'Medium');
  });
  test('is empty when there is none, and the first wins when there are several', () => {
    assert.equal(priorityFromLabels(['bug']), '');
    assert.equal(priorityFromLabels([]), '');
    assert.equal(priorityFromLabels(['priority:High', 'priority:Low']), 'High');
    assert.equal(priorityFromLabels(['not-priority:High']), '');
  });
});

describe('summary', () => {
  test('is the same shape for every tracker, with the id as a string', () => {
    assert.deepEqual(summary({ id: 5, title: 'T', url: 'u', status: 'open', open: true }), { id: '5', title: 'T', url: 'u', status: 'open', open: true });
  });
  test('adds createdAt when there is one, and dismissed only when true', () => {
    assert.deepEqual(summary({ id: '1', title: 'T', url: 'u', status: 'closed', open: false, createdAt: '2026-01-01T00:00:00Z', dismissed: true }),
      { id: '1', title: 'T', url: 'u', status: 'closed', open: false, createdAt: '2026-01-01T00:00:00Z', dismissed: true });
    for (const createdAt of [undefined, null, '']) assert.equal('createdAt' in summary({ id: '1', title: 'T', url: 'u', status: 's', open: true, createdAt }), false, String(createdAt));
    for (const dismissed of [false, undefined, 0]) assert.equal('dismissed' in summary({ id: '1', title: 'T', url: 'u', status: 's', open: true, dismissed }), false, String(dismissed));
  });
});

describe('linkByReference', () => {
  test('reports the link as done by the reference already in the body', async () => {
    assert.deepEqual(await linkByReference(), { linked: true, method: 'reference-in-body' });
  });
});

describe('isDuplicateLink', () => {
  test('is true only for a VALIDATION TrackerError whose message matches', () => {
    assert.equal(isDuplicateLink(new TrackerError('VALIDATION', 'relation already exists'), /already exists/i), true);
    assert.equal(isDuplicateLink(new TrackerError('VALIDATION', 'something else'), /already exists/i), false);
    assert.equal(isDuplicateLink(new TrackerError('NOT_FOUND', 'already exists'), /already exists/i), false);
    assert.equal(isDuplicateLink(new Error('already exists'), /already exists/i), false);
    assert.equal(isDuplicateLink(undefined, /already exists/i), false);
  });
});

describe('eachPage', () => {
  const collect = async (gen) => { const batches = []; for await (const b of gen) batches.push(b); return batches; };
  const page = (n) => Array.from({ length: n }, (_, i) => i);
  test('the defaults are the 500-item window every adapter documents', () => {
    assert.deepEqual([LIST_PAGES, PAGE_SIZE], [5, 100]);
  });
  test('stops after the first page that is not full', async () => {
    const asked = [];
    const batches = await collect(eachPage(async (p) => { asked.push(p); return p === 2 ? page(40) : page(100); }));
    assert.deepEqual(asked, [1, 2]);
    assert.deepEqual(batches.map((b) => b.length), [100, 40]);
  });
  test('never asks for more than the page limit', async () => {
    const asked = [];
    await collect(eachPage(async (p) => { asked.push(p); return page(100); }));
    assert.deepEqual(asked, [1, 2, 3, 4, 5]);
    asked.length = 0;
    await collect(eachPage(async (p) => { asked.push(p); return page(100); }, { max: 2 }));
    assert.deepEqual(asked, [1, 2]);
  });
  test('can start at page 0, and then still asks for `max` pages', async () => {
    const asked = [];
    await collect(eachPage(async (p) => { asked.push(p); return page(100); }, { first: 0 }));
    assert.deepEqual(asked, [0, 1, 2, 3, 4]);
  });
  test('a consumer that has what it wanted stops further requests', async () => {
    const asked = [];
    for await (const batch of eachPage(async (p) => { asked.push(p); return page(100); })) { if (batch) break; }
    assert.deepEqual(asked, [1]);
  });
  test('a missing or empty page ends the walk, and is seen as an empty list', async () => {
    assert.deepEqual(await collect(eachPage(async () => undefined)), [[]]);
    assert.deepEqual(await collect(eachPage(async () => null)), [[]]);
    assert.deepEqual(await collect(eachPage(async () => [])), [[]]);
  });
  test('a failed request is thrown to the consumer', async () => {
    await assert.rejects(collect(eachPage(async () => { throw new TrackerError('NETWORK', 'down'); })), (e) => e.code === 'NETWORK');
  });
});

describe('apiCall', () => {
  const response = (status, body) => ({ status, ok: status < 300, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  test('sends to base + path with the fixed headers, the JSON body and the timeout the adapter chose', async () => {
    const seen = [];
    const fetch = async (url, init) => { seen.push({ url, init }); return response(200, { id: 1 }); };
    const call = apiCall({ fetch, base: 'https://api.example.test/v1', headers: { 'PRIVATE-TOKEN': 'sekret-token' }, timeoutMs: 1234, retryDelayMs: 0 });
    const r = await call('POST', '/things', { a: 1 }, 'make a thing');
    assert.deepEqual(r.json, { id: 1 });
    assert.equal(seen[0].url, 'https://api.example.test/v1/things');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.headers['PRIVATE-TOKEN'], 'sekret-token');
    assert.equal(seen[0].init.body, '{"a":1}');
  });
  test('names the operation in a failure, and never repeats the secret', async () => {
    const fetch = async () => response(401, { echoed: 'Bearer sekret-token-value' });
    const call = apiCall({ fetch, base: 'https://api.example.test', headers: { Authorization: 'Bearer sekret-token-value' }, retryDelayMs: 0 });
    await assert.rejects(call('GET', '/me', undefined, 'fetch the current user'), (e) => e.code === 'UNAUTHENTICATED' && /fetch the current user/.test(e.message) && !/sekret-token-value/.test(e.message));
  });
  test('a GET is retried on a retriable failure, a POST never is', async () => {
    const counts = { GET: 0, POST: 0 };
    const fetch = async (url, init) => { counts[init.method] += 1; return response(503, {}); };
    const call = apiCall({ fetch, base: 'https://api.example.test', headers: {}, retryDelayMs: 0 });
    await assert.rejects(call('GET', '/x', undefined, 'read'), (e) => e.code === 'UPSTREAM_ERROR');
    await assert.rejects(call('POST', '/x', {}, 'write'), (e) => e.code === 'UPSTREAM_ERROR');
    assert.deepEqual(counts, { GET: 3, POST: 1 });
  });
});
