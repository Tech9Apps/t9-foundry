'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../scripts/tracker/smoke');
const { MOCKS } = require('./workspace');

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-smoke-'));

// Run the smoke script in-process against a mock; sleeping is instant unless a test says otherwise.
async function smoke(type, { args = ['--yes', '--search-wait-ms', '0'], mock = MOCKS[type](), fetch, env, sleep = async () => {}, random } = {}) {
  const cfg = path.join(dir, `${type}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ ticketSource: { type, [type]: mock.settings } }));
  let out = ''; let err = '';
  const code = await main({
    argv: ['--config', cfg, '--base-url', mock.baseUrl, ...args],
    env: env || { [mock.tokenEnv]: mock.token }, fetch: fetch || mock.fetch, sleep, now: () => Date.UTC(2026, 0, 2), ...(random ? { random } : {}),
    stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err, json: out ? JSON.parse(out) : null, mock };
}
const check = (r, frag) => r.json.checks.find((c) => c.name.includes(frag));

for (const type of Object.keys(MOCKS)) {
  describe(`smoke: ${type}`, () => {
    test('a healthy tracker passes every check, leaves exactly two scratch items, and never prints the token', async () => {
      const r = await smoke(type);
      assert.equal(r.code, 0, r.err);
      assert.equal(r.json.ok, true);
      assert.deepEqual(r.json.summary, { pass: 11, warn: 0, fail: 0, skipped: 0 });
      assert.deepEqual(r.json.leftovers.map((l) => l.kind), ['bug', 'test-case']);
      assert.equal(r.mock.createdItems().length, 2, 'two items exist in the tracker — the retries made no third');
      assert.match(r.json.cleanup, /close or delete/);
      assert.ok(!r.out.includes(r.mock.token) && !r.err.includes(r.mock.token), 'the token must never appear in output');
    });

    test('without --yes nothing is created, and the plan names the target', async () => {
      const r = await smoke(type, { args: [] });
      assert.equal(r.code, 2);
      assert.equal(r.json.error.code, 'NOT_CONFIRMED');
      assert.equal(r.mock.createdItems().length, 0);
      assert.ok(r.json.target.length > 0);
      assert.match(r.err, /--yes/);
    });
  });
}

describe('smoke: failure reporting', () => {
  test('a tracker that makes a second bug on retry FAILS the idempotency check', async () => {
    const mock = MOCKS.github();
    // the key lookup lists issues; make that list come back empty, so a retry cannot see the original
    const blind = (url, init) => (/\/issues\?/.test(String(url)) && (!init || !init.method || init.method === 'GET')
      ? Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
      : mock.fetch(url, init));
    const r = await smoke('github', { mock, fetch: blind });
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(check(r, 'retrying the bug').status, 'fail');
    assert.match(check(r, 'retrying the bug').detail, /idempotency does not hold/);
    assert.equal(check(r, 'retrying the test case').status, 'fail'); // the same blindness fails the test-case retry too
    assert.match(check(r, 'retrying the test case').detail, /second test case/);
  });

  test('a tracker that posts the same comment twice FAILS the comment check', async () => {
    const mock = MOCKS.github();
    const blind = (url, init) => (/\/comments/.test(String(url)) && (!init || !init.method || init.method === 'GET')
      ? Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
      : mock.fetch(url, init));
    const r = await smoke('github', { mock, fetch: blind });
    assert.equal(r.code, 1);
    assert.equal(check(r, 'comment').status, 'fail');
    assert.match(check(r, 'comment').detail, /posted a second comment/);
    assert.equal(check(r, 'retrying the bug').status, 'pass'); // only the comment path was broken
  });

  test('re-running with a reused run id is caught: a brand-new key must not come back deduplicated', async () => {
    const mock = MOCKS.github();
    const same = { mock, random: () => 0 }; // same clock + same randomness = the same run id twice
    const first = await smoke('github', same);
    assert.equal(first.code, 0);
    const second = await smoke('github', same);
    assert.equal(second.code, 1);
    assert.match(check(second, 'create a bug').detail, /brand-new key came back deduplicated/);
  });

  test('a failed create fails that check and SKIPS what depended on it (and leaves nothing)', async () => {
    const mock = MOCKS.github();
    mock.inject({ method: 'POST', match: /\/issues$/, status: 500, times: 99 });
    const r = await smoke('github', { mock });
    assert.equal(r.code, 1);
    assert.equal(check(r, 'create a bug').status, 'fail');
    assert.match(check(r, 'create a bug').detail, /UPSTREAM_ERROR/);
    for (const frag of ['fetch it back', 'search finds it', 'create a test case', 'retrying the bug', 'comment']) {
      assert.equal(check(r, frag).status, 'skipped', frag);
    }
    assert.deepEqual(r.json.leftovers, []);
    assert.equal(r.json.cleanup, undefined);
  });

  test('missing credentials: the connect check fails with CONFIG, everything else is skipped, exit 1', async () => {
    const r = await smoke('github', { env: {} });
    assert.equal(r.code, 1);
    assert.equal(check(r, 'connect').status, 'fail');
    assert.match(check(r, 'connect').detail, /CONFIG/);
    assert.ok(r.json.checks.slice(1).every((c) => c.status === 'skipped'));
    assert.equal(r.mock.createdItems().length, 0);
  });

  test('a lagging search index is a WARNING (not a failure), and a search that catches up passes', async () => {
    const lag = MOCKS.github();
    lag.state.searchLag = true;
    const warned = await smoke('github', { mock: lag });
    assert.equal(warned.code, 0);
    assert.equal(check(warned, 'search finds it').status, 'warn');
    assert.match(check(warned, 'search finds it').detail, /lags writes/);

    const catchUp = MOCKS.github();
    catchUp.state.searchLag = true;
    const r = await smoke('github', { mock: catchUp, args: ['--yes', '--search-wait-ms', '10000'], sleep: async () => catchUp.settle() });
    assert.equal(check(r, 'search finds it').status, 'pass');
    assert.match(check(r, 'search finds it').detail, /found after 2 attempt/);
  });

  test('a body-only marker that search cannot find is a WARNING that names both explanations (lag, or search ignores bodies)', async () => {
    const mock = MOCKS.github();
    // search works for the title (the run id) but never returns anything for the marker token
    const blindToBodies = (url, init) => (/\/search\/issues/.test(String(url)) && /qafp/.test(decodeURIComponent(String(url)))
      ? Promise.resolve(new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      : mock.fetch(url, init));
    const r = await smoke('github', { mock, fetch: blindToBodies });
    assert.equal(r.code, 0);
    assert.equal(check(r, 'search finds it').status, 'pass');
    assert.equal(check(r, 'marker that is only in the body').status, 'warn');
    assert.match(check(r, 'marker that is only in the body').detail, /lags, or this tracker's search does not look in bodies/);
  });

  test('if fetch does not return the body marker, that FAILS (a search hit could never be confirmed)', async () => {
    const mock = MOCKS.github();
    const noBodies = async (url, init) => {
      const res = await mock.fetch(url, init);
      if (/\/issues\/\d+$/.test(String(url)) && (!init || !init.method || init.method === 'GET')) {
        const json = await res.json();
        return new Response(JSON.stringify({ ...json, body: '' }), { status: res.status, headers: { 'content-type': 'application/json' } });
      }
      return res;
    };
    const r = await smoke('github', { mock, fetch: noBodies });
    assert.equal(check(r, 'marker that is only in the body').status, 'fail');
    assert.match(check(r, 'marker that is only in the body').detail, /fetch did not return the marker/);
  });

  test('an unknown id that is not NOT_FOUND is a warning that names what the tracker said', async () => {
    const mock = MOCKS.github();
    mock.inject({ method: 'GET', match: /\/issues\/999999999$/, status: 422, times: 1 });
    const r = await smoke('github', { mock });
    assert.equal(r.code, 0);
    assert.equal(check(r, 'unknown id').status, 'warn');
    assert.match(check(r, 'unknown id').detail, /answers an unknown id with/);
  });

  test('a tracker that accepts an invalid token produces a warning, not a silent pass', async () => {
    const mock = MOCKS.github();
    const lenient = (url, init = {}) => {
      const headers = { ...(init.headers || {}) };
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') headers[k] = `Bearer ${mock.token}`;
      return mock.fetch(url, { ...init, headers });
    };
    const r = await smoke('github', { mock, fetch: lenient });
    assert.equal(check(r, 'bad token').status, 'warn');
    assert.match(check(r, 'bad token').detail, /invalid token/);
  });

  test('--skip-bad-token skips that drill', async () => {
    const r = await smoke('github', { args: ['--yes', '--search-wait-ms', '0', '--skip-bad-token'] });
    assert.equal(check(r, 'bad token').status, 'skipped');
    assert.equal(r.code, 0);
  });

  test('usage errors exit 2', async () => {
    for (const args of [['--bogus'], ['--timeout-ms'], ['--source']]) {
      const r = await smoke('github', { args });
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(r.json, null);
    }
  });
});

describe('smoke: the target it prints', () => {
  test('a host in the config is shown as scheme://host: user:password@ in it never reaches the terminal or the result JSON', async () => {
    const mock = MOCKS.gitlab();
    const cfg = path.join(dir, `leak-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(cfg, JSON.stringify({ ticketSource: { type: 'gitlab', gitlab: { ...mock.settings, host: 'https://deploy:hunter2secret@gitlab.corp.example/x' } } }));
    let out = ''; let err = '';
    const code = await main({
      argv: ['--config', cfg], env: { [mock.tokenEnv]: mock.token }, fetch: mock.fetch,
      stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
    });
    assert.equal(code, 2);
    assert.ok(!/hunter2secret|deploy:/.test(out + err), 'credentials must not be echoed');
    assert.match(JSON.parse(out).target, /host=https:\/\/gitlab\.corp\.example /);
  });
});
