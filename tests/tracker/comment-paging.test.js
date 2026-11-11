'use strict';

// "Has this run already posted its comment?" is answered by reading the ticket's comments. Read ONE page and the answer is wrong on any busy ticket
// (GitHub's default page is 30): the marker is on page 2, the lookup says "not posted", and the results comment goes up twice. The mocks page like the
// real servers, so these fail against a client that reads a single page.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter, run } = require('../../scripts/tracker/adapters');
const { keyMarker } = require('../../scripts/tracker/lib/contract');
const { MOCKS } = require('./workspace');

const KEY = 'run-42-TC-001';
const filler = (n) => Array.from({ length: n }, (_, i) => ({ author: 'someone', body: `chatter ${i}` }));
const marked = { author: 'harness', body: `results\n\n${keyMarker(KEY)}` };

function setup(type, comments, wrapFetch) {
  const mock = MOCKS[type]();
  const id = mock.seedTicket({ title: 'T', description: 'd', acceptance: '1. a', comments });
  const fetch = wrapFetch ? wrapFetch(mock.fetch) : mock.fetch;
  const adapter = createAdapter(type, { settings: mock.settings, env: { [mock.tokenEnv]: mock.token }, fetch, baseUrl: mock.baseUrl, retryDelayMs: 0 });
  return { mock, id, adapter };
}
const post = (adapter, id) => run(adapter, 'comment', { id, body: 'results', idempotencyKey: KEY });

for (const type of ['github', 'gitlab', 'bitbucket']) {
  describe(`${type}: the idempotency lookup reads every page of comments`, () => {
    test('a marker on the second page is found: nothing is posted again', async () => {
      const { mock, id, adapter } = setup(type, [...filler(130), marked, ...filler(20)]);
      const before = mock.commentsOn(id).length;
      const r = await post(adapter, id);
      assert.equal(r.deduplicated, true);
      assert.equal(mock.commentsOn(id).length, before);
    });
    test('a marker on the last page that is read (page 10) is still found', async () => {
      const { mock, id, adapter } = setup(type, [...filler(999), marked]);
      assert.equal((await post(adapter, id)).deduplicated, true);
      assert.equal(mock.commentsOn(id).length, 1000);
    });
    test('a full last page with no marker ends the lookup cleanly (an empty next page is not an error) and the comment is posted', async () => {
      const { mock, id, adapter } = setup(type, filler(100));
      const r = await post(adapter, id);
      assert.equal(r.deduplicated, false);
      assert.equal(mock.commentsOn(id).length, 101);
    });
    test('with no marker anywhere, a short list is read and the comment is posted once', async () => {
      const { mock, id, adapter } = setup(type, filler(3));
      assert.equal((await post(adapter, id)).deduplicated, false);
      assert.equal((await post(adapter, id)).deduplicated, true);
      assert.equal(mock.commentsOn(id).length, 4);
    });
    test('past the pages it will read it REFUSES rather than guess "not posted": VALIDATION (not retriable), and nothing is posted', async () => {
      const { mock, id, adapter } = setup(type, [...filler(1000), marked]);
      await assert.rejects(post(adapter, id), (e) => e.code === 'VALIDATION' && e.retriable === false && /1000 comments/.test(e.message) && /nothing was posted/.test(e.message));
      assert.equal(mock.commentsOn(id).length, 1001);
    });
  });
}

describe('bitbucket: a "next" link from the server is a signal, never a URL to fetch', () => {
  test('every request goes to the configured base URL even when the response points "next" at another host', async () => {
    const urls = [];
    const evil = (fetch) => async (url, init) => {
      urls.push(String(url));
      const res = await fetch(url, init);
      const text = await res.text();
      let body = text;
      try { const j = JSON.parse(text); if (j.next) { j.next = 'https://evil.example/steal?page=2'; body = JSON.stringify(j); } } catch { /* not JSON */ }
      return new Response(body, { status: res.status, headers: res.headers });
    };
    const { mock, id, adapter } = setup('bitbucket', [...filler(130), marked], evil);
    assert.equal((await post(adapter, id)).deduplicated, true);
    assert.ok(urls.every((u) => u.startsWith(mock.baseUrl)), urls.join('\n'));
  });
});
