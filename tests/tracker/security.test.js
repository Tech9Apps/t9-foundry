'use strict';

// Where credentials may go, and what an error may say. Every property is checked on every adapter, because each has its own auth style
// (Bearer, a raw token, Basic with an empty user, Basic with a username) and its own way of building the URL it calls.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdapter, run } = require('../../scripts/tracker/adapters');
const { checkBaseUrl } = require('../../scripts/tracker/lib/base-url');
const { main: cli } = require('../../scripts/tracker/cli');
const { MOCKS } = require('./workspace');

const TYPES = Object.keys(MOCKS);
const make = (type, { baseUrl, settings = {}, fetch, token } = {}) => {
  const mock = MOCKS[type]();
  const env = { [mock.tokenEnv]: token || mock.token };
  return { mock, adapter: createAdapter(type, { settings: { ...mock.settings, ...settings }, env, fetch: fetch || mock.fetch, baseUrl: baseUrl === undefined ? mock.baseUrl : baseUrl, timeoutMs: 500, retryDelayMs: 0 }), env };
};
const spyFetch = () => { const f = async () => { f.calls += 1; throw new Error('the network must not be reached'); }; f.calls = 0; return f; };
const rejects = async (promiseOrFn, code) => assert.rejects(Promise.resolve().then(promiseOrFn), (e) => e.code === code, code);
const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code, code);

describe('checkBaseUrl', () => {
  test('https is accepted, and so is plain http for loopback only', () => {
    for (const ok of ['https://api.github.com', 'https://ghe.example.com/api/v3', 'http://localhost:3000', 'http://127.0.0.1:8080/api', 'http://127.1.2.3', 'http://[::1]:9000', 'http://mock.localhost:4000']) {
      assert.equal(checkBaseUrl(ok, 'x'), ok);
    }
  });
  test('plain http anywhere else is refused (the token would cross a network in cleartext)', () => {
    for (const bad of ['http://attacker.example:8080', 'http://api.github.com', 'http://localhost.evil.com', 'http://127.0.0.1.evil.com', 'http://localhostfoo', 'http://10.0.0.5', 'http://192.168.1.2']) {
      throwsCode(() => checkBaseUrl(bad, 'the base URL'), 'CONFIG');
    }
  });
  test('other schemes, credentials in the URL, a query string and a fragment are refused', () => {
    for (const bad of ['ftp://x.example', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw@api.example.com', 'https://token@api.example.com', 'https://api.example.com/?a=b', 'https://api.example.com/#frag']) {
      throwsCode(() => checkBaseUrl(bad, 'the base URL'), 'CONFIG');
    }
    for (const notUrl of ['', 'api.example.com', 'not a url', undefined]) throwsCode(() => checkBaseUrl(notUrl, 'the base URL'), 'CONFIG');
  });
  test('the error never echoes embedded credentials back', () => {
    try { checkBaseUrl('https://user:SECRETpw@api.example.com', 'the base URL'); assert.fail('should have thrown'); } catch (e) { assert.doesNotMatch(e.message, /SECRETpw|user:/); }
  });
});

describe('every adapter refuses an unsafe base URL BEFORE making any request', () => {
  for (const type of TYPES) {
    test(`${type}: http to a non-loopback host, embedded credentials, a query string`, () => {
      for (const bad of ['http://attacker.example:8080', 'https://u:p@api.example.test', 'https://api.example.test/?x=1']) {
        const spy = spyFetch();
        throwsCode(() => make(type, { baseUrl: bad, fetch: spy }), 'CONFIG');
        assert.equal(spy.calls, 0, 'no request is made');
      }
    });
    test(`${type}: https and loopback http are accepted`, () => {
      for (const ok of ['https://tracker.example.test', 'http://localhost:4010', 'http://127.0.0.1:4010']) assert.doesNotThrow(() => make(type, { baseUrl: ok }), ok);
    });
  }

  test('the same rule applies to the values read from qa-config.json (apiBaseUrl, host), not just the flag', () => {
    throwsCode(() => make('github', { baseUrl: null, settings: { apiBaseUrl: 'http://attacker.example/api' } }), 'CONFIG');
    throwsCode(() => make('clickup', { baseUrl: null, settings: { apiBaseUrl: 'http://attacker.example/api/v2' } }), 'CONFIG');
    throwsCode(() => make('gitlab', { baseUrl: null, settings: { host: 'http://git.attacker.example' } }), 'CONFIG');
    throwsCode(() => make('azure', { baseUrl: null, settings: { host: 'http://devops.attacker.example' } }), 'CONFIG');
    assert.doesNotThrow(() => make('gitlab', { baseUrl: null, settings: { host: 'https://git.corp.example' } }));
  });

  test('the CLI: --base-url and $QA_TRACKER_BASE_URL are refused too, and the token is never sent', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-sec-'));
    const cfg = path.join(dir, 'cfg.json');
    fs.writeFileSync(cfg, JSON.stringify({ ticketSource: { type: 'github', github: { repo: 'acme/shop' } } }));
    for (const style of ['flag', 'env']) {
      const spy = spyFetch();
      let out = '';
      const code = await cli({
        argv: ['search', '--config', cfg, '--input', '{"query":"x"}', ...(style === 'flag' ? ['--base-url', 'http://attacker.example:8080'] : [])],
        env: { GITHUB_TOKEN: 'ghp_SECRET123456', ...(style === 'env' ? { QA_TRACKER_BASE_URL: 'http://attacker.example:8080' } : {}) },
        fetch: spy, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} },
      });
      const json = JSON.parse(out);
      assert.equal(code, 1, style);
      assert.equal(json.error.code, 'CONFIG', style);
      assert.equal(spy.calls, 0, `${style}: nothing was sent`);
      assert.doesNotMatch(out, /ghp_SECRET123456/);
    }
  });
});

describe('a redirect is never followed (the credentials would go with it)', () => {
  for (const type of TYPES) {
    test(`${type}: reads and writes both stop at the redirect, name the new host, retry nothing, and leak nothing`, async () => {
      const token = 'tok_SECRET_ABCDEF123456';
      let calls = 0; let inits = [];
      const redirecting = async (url, init) => { calls += 1; inits.push(init); return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }); };
      const { adapter } = make(type, { fetch: redirecting, token });
      const read = await assert.rejects(run(adapter, 'fetch', { id: '1' }), (e) => {
        assert.equal(e.code, 'CONFIG');
        assert.equal(e.retriable, false);
        assert.match(e.message, /redirected \(HTTP 302\) to evil\.example/);
        assert.match(e.message, /never sent anywhere else/);
        assert.doesNotMatch(e.message, new RegExp(token));
        return true;
      });
      assert.equal(read, undefined);
      assert.equal(calls, 1, 'a GET is not retried, and the redirect is not followed');
      assert.ok(inits.every((i) => i.redirect === 'manual'), 'fetch is told not to follow redirects');
      calls = 0;
      await assert.rejects(run(adapter, 'create-bug', { title: 'x', body: 'y' }), (e) => e.code === 'CONFIG');
      assert.equal(calls, 1, 'a write is not retried either');
    });
  }
});

describe('error messages never contain the credential, even when the response body echoes it', () => {
  // Every form a body might echo: the header value, the token after its scheme, Basic's base64, the decoded user:password, the password.
  // Each is the WHOLE (short) body, because an error quotes only the first 200 characters of it — a secret buried deeper would test nothing.
  const forms = (headers) => {
    const value = headers.Authorization || headers['PRIVATE-TOKEN'];
    const out = new Set([value]);
    const m = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(value);
    if (m) {
      out.add(m[2]);
      if (/^Basic/i.test(value)) {
        const decoded = Buffer.from(m[2], 'base64').toString('utf8');
        out.add(decoded); out.add(decoded.slice(decoded.indexOf(':') + 1));
      }
    }
    return [...out].filter((x) => x && x.length >= 6);
  };

  for (const type of TYPES) {
    test(`${type}: a 400/401/403/404/500 body that is each form of the credential is quoted with the credential removed`, async () => {
      let headers = {};
      const echoing = (status, body) => async (url, init) => { headers = init.headers; return new Response(typeof body === 'function' ? body(init.headers) : body, { status }); };
      // first learn which forms this adapter's credential takes
      const probe = make(type, { fetch: echoing(500, 'x') });
      await assert.rejects(run(probe.adapter, 'fetch', { id: '1' }));
      const secrets = forms(headers);
      assert.ok(secrets.length >= 1, 'the adapter sent a credential');
      for (const status of [400, 401, 403, 404, 500]) {
        for (const secret of secrets) {
          const { adapter } = make(type, { fetch: echoing(status, `upstream said: ${secret} (end)`) });
          let error;
          try { await run(adapter, 'fetch', { id: '1' }); } catch (e) { error = e; }
          assert.ok(error, `${status} threw`);
          const everything = `${error.message} ${JSON.stringify(error.toJSON())}`;
          assert.ok(!everything.includes(secret), `${type} ${status}: the error leaked "${secret.slice(0, 10)}…"`);
          assert.match(error.message, /\[redacted\]/, `${type} ${status}: the excerpt says something was removed`);
          assert.match(error.message, /upstream said: .*\(end\)/, 'the rest of the body is still quoted');
        }
      }
    });
  }

  test('Basic credentials are removed in every form: the base64, the decoded user:password, and the password alone', async () => {
    const password = 'bb_app_password_9f3a1c';
    const { adapter } = make('bitbucket', { token: password, fetch: async (url, init) => new Response(`${init.headers.Authorization} :: bob:${password} :: ${password}`, { status: 500 }) });
    await assert.rejects(run(adapter, 'fetch', { id: '1' }), (e) => {
      assert.doesNotMatch(e.message, new RegExp(password));
      assert.doesNotMatch(e.message, new RegExp(Buffer.from(`bob:${password}`).toString('base64')));
      return true;
    });
  });

  test('a body that does not mention the credential is quoted unchanged (redaction is not a blanket scrub)', async () => {
    const { adapter } = make('github', { fetch: async () => new Response('{"message":"Not Found","documentation_url":"https://docs.example/x"}', { status: 404 }) });
    await assert.rejects(run(adapter, 'fetch', { id: '1' }), (e) => /Not Found/.test(e.message) && !/\[redacted\]/.test(e.message));
  });

  test('very short header values are not redacted (they would mangle ordinary words), real tokens are', async () => {
    const { adapter } = make('clickup', { token: 'abc', fetch: async () => new Response('abc is a common prefix', { status: 500 }) });
    await assert.rejects(run(adapter, 'fetch', { id: '1' }), (e) => /abc is a common prefix/.test(e.message));
  });
});
