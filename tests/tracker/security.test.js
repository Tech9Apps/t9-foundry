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
    // a self-hosted server over https is no longer enough on its own: the person has to allow the host (see "every adapter sends its token only to a host it may")
    throwsCode(() => make('gitlab', { baseUrl: null, settings: { host: 'https://git.corp.example' } }), 'CONFIG');
    const allowed = createAdapter('gitlab', { settings: { projectId: '1', host: 'https://git.corp.example' }, env: { GITLAB_TOKEN: 'x', QA_TRACKER_ALLOW_HOSTS: 'git.corp.example' }, fetch: spyFetch() });
    assert.ok(allowed);
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

// ── Where a token may be sent ───────────────────────────────────────────────────────────────────────────
// checkBaseUrl above only demanded https. But the base URL (and the host, and the variable the token is read from) come from qa-config.json, including
// the committed profiles /switch-project copies in, and from --base-url / $QA_TRACKER_BASE_URL, which a prompt-injected model can set. So "https" alone sent
// `Authorization: Bearer <any env var the config names>` to any https host the config named. Now an adapter sends its token only to its own tracker's host,
// to a host the PERSON allowed in their own shell ($QA_TRACKER_ALLOW_HOSTS), or to a reserved test host / loopback (the mocks).
const DEFAULT_HOST = { github: 'api.github.com', gitlab: 'gitlab.com', azure: 'dev.azure.com', clickup: 'api.clickup.com', bitbucket: 'api.bitbucket.org' };
const TOKEN_ENV = { github: 'GITHUB_TOKEN', gitlab: 'GITLAB_TOKEN', azure: 'AZURE_DEVOPS_PAT', clickup: 'CLICKUP_TOKEN', bitbucket: 'BITBUCKET_TOKEN' };
// the setting that names a host, per adapter (Bitbucket has none: only the --base-url override)
const HOST_SETTING = { github: (u) => ({ apiBaseUrl: u }), gitlab: (u) => ({ host: u }), azure: (u) => ({ host: u }), clickup: (u) => ({ apiBaseUrl: u }), bitbucket: null };
const SETTINGS = { github: { repo: 'o/r' }, gitlab: { projectId: '1' }, azure: { organization: 'o', project: 'p' }, clickup: { listId: '1' }, bitbucket: { workspace: 'w', repo: 'r', username: 'u' } };
const direct = (type, { settings = {}, env = {}, baseUrl, fetch } = {}) => createAdapter(type, { settings: { ...SETTINGS[type], ...settings }, env: { [TOKEN_ENV[type]]: 'sekret-token-value', ...env }, baseUrl, fetch: fetch || spyFetch(), retryDelayMs: 0 });

describe('checkBaseUrl with an allowlist of hosts', () => {
  const opts = { hosts: ['api.github.com'], env: {} };
  test('the adapter\'s own host is accepted: any case, a trailing dot, a port, a path', () => {
    for (const ok of ['https://api.github.com', 'https://API.GITHUB.COM', 'https://api.github.com.', 'https://api.github.com:8443/x', 'https://api.github.com/api/v3']) {
      assert.doesNotThrow(() => checkBaseUrl(ok, 'x', opts), ok);
    }
  });
  test('any other host is refused, naming the host and how a person allows it (and never echoing credentials)', () => {
    for (const bad of ['https://evil.example/x', 'https://api.github.com.evil.example', 'https://evil.example/api.github.com', 'https://notapi.github.com', 'https://api.github.com.evil.test.example.org', 'https://github.com']) {
      assert.throws(() => checkBaseUrl(bad, 'the GitHub API base URL', opts), (e) => e.code === 'CONFIG' && e.message.includes(new URL(bad).hostname) && /QA_TRACKER_ALLOW_HOSTS/.test(e.message), bad);
    }
  });
  test('loopback and the reserved .test domain (what the mocks use) are accepted: nothing public can be reached', () => {
    for (const ok of ['http://localhost:3000', 'https://api.github.test', 'https://mock.test/api', 'http://127.0.0.1:9', 'https://x.localhost']) assert.doesNotThrow(() => checkBaseUrl(ok, 'x', opts), ok);
  });
  test('.example, .invalid and .local are NOT blanket-allowed (an internal DNS could resolve them)', () => {
    for (const bad of ['https://evil.example', 'https://x.invalid', 'https://x.local']) assert.throws(() => checkBaseUrl(bad, 'x', opts), (e) => e.code === 'CONFIG', bad);
  });
  test('a host in $QA_TRACKER_ALLOW_HOSTS is accepted: exact, or *.suffix with at least two labels; junk entries are ignored', () => {
    const env = { QA_TRACKER_ALLOW_HOSTS: ' ghe.corp.example.com , *.git.corp.example.com, *.com, *, bad host!, ,https://x.example.org' };
    assert.doesNotThrow(() => checkBaseUrl('https://ghe.corp.example.com/api/v3', 'x', { hosts: [], env }));
    assert.doesNotThrow(() => checkBaseUrl('https://eu.git.corp.example.com', 'x', { hosts: [], env }));
    for (const bad of ['https://git.corp.example.com', 'https://evil.com', 'https://x.org', 'https://x.example.org', 'https://ghe.corp.example.com.evil.net', 'https://notghe.corp.example.com']) {
      assert.throws(() => checkBaseUrl(bad, 'x', { hosts: [], env }), (e) => e.code === 'CONFIG', bad);
    }
  });
  test('without the option the old behaviour is unchanged (https, no userinfo): the other checks still apply', () => {
    assert.doesNotThrow(() => checkBaseUrl('https://ghe.example.com/api/v3', 'x'));
    assert.throws(() => checkBaseUrl('http://evil.example', 'x', opts), (e) => e.code === 'CONFIG');
    assert.throws(() => checkBaseUrl('https://user:pw@api.github.com', 'x', opts), (e) => e.code === 'CONFIG' && !/pw/.test(e.message));
  });
});

describe('every adapter sends its token only to a host it may', () => {
  for (const type of TYPES) {
    describe(type, () => {
      test('its own default host is accepted with no base URL given', () => {
        assert.doesNotThrow(() => direct(type));
      });
      test('a --base-url / QA_TRACKER_BASE_URL override to any other https host is refused before a request is made', () => {
        const fetch = spyFetch();
        throwsCode(() => direct(type, { baseUrl: 'https://evil.example/x', fetch }), 'CONFIG');
        throwsCode(() => direct(type, { baseUrl: 'https://evil.example.com/x', fetch }), 'CONFIG');
        assert.equal(fetch.calls, 0);
      });
      if (HOST_SETTING[type]) {
        test('a host named in qa-config.json (a committed profile) is refused the same way', () => {
          const fetch = spyFetch();
          throwsCode(() => direct(type, { settings: HOST_SETTING[type]('https://evil.example.com/x'), fetch }), 'CONFIG');
          assert.equal(fetch.calls, 0);
        });
        test('...and the same host is accepted when the PERSON allows it in their environment', () => {
          assert.doesNotThrow(() => direct(type, { settings: HOST_SETTING[type]('https://ghe.corp.example.com'), env: { QA_TRACKER_ALLOW_HOSTS: 'ghe.corp.example.com' } }));
        });
        test('...but an allowlist written in the config itself does nothing (that is where the attacker writes)', () => {
          throwsCode(() => direct(type, { settings: { ...HOST_SETTING[type]('https://evil.example.com/x'), allowHosts: ['evil.example.com'], allowedHosts: ['evil.example.com'], QA_TRACKER_ALLOW_HOSTS: 'evil.example.com' } }), 'CONFIG');
        });
      }
      test('the reserved .test host the mocks use still works, so the suite and the demos are unaffected', () => {
        const { adapter } = make(type);
        assert.ok(adapter);
      });
    });
  }
  test('the CLI refuses an override too: exit 1, CONFIG, and nothing sent', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-sec-'));
    const config = path.join(dir, 'qa-config.json');
    fs.writeFileSync(config, JSON.stringify({ ticketSource: { type: 'github', github: { repo: 'o/r' } } }));
    const fetch = spyFetch();
    for (const args of [['--base-url', 'https://evil.example.com'], []]) {
      let out = '';
      const code = await cli({ argv: ['fetch', '--config', config, '--input', '{"id":"1"}', ...args], env: { GITHUB_TOKEN: 'sekret-token-value', ...(args.length ? {} : { QA_TRACKER_BASE_URL: 'https://evil.example.com' }) }, fetch, stdin: require('node:stream').Readable.from([]), stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
      assert.equal(code, 1);
      assert.equal(JSON.parse(out).error.code, 'CONFIG');
      assert.ok(!/sekret-token-value/.test(out));
    }
    assert.equal(fetch.calls, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the token an adapter reads', () => {
  test('GitHub: a variable the config names is the ONLY one read (it used to fall back to GITHUB_TOKEN or GH_TOKEN, sending a different credential than the one chosen)', () => {
    throwsCode(() => direct('github', { settings: { tokenEnvVar: 'MY_GH_TOKEN' }, env: { GITHUB_TOKEN: 'a-different-credential', GH_TOKEN: 'another' } }), 'CONFIG');
    assert.throws(() => direct('github', { settings: { tokenEnvVar: 'MY_GH_TOKEN' }, env: { GITHUB_TOKEN: 'x'.repeat(10), GH_TOKEN: 'y'.repeat(10) } }), (e) => /MY_GH_TOKEN is not set/.test(e.message) && !/GH_TOKEN\)/.test(e.message));
    const mock = MOCKS.github();
    const seen = [];
    const adapter = createAdapter('github', { settings: { ...mock.settings, tokenEnvVar: 'MY_GH_TOKEN' }, env: { MY_GH_TOKEN: mock.token, GITHUB_TOKEN: 'not-this-one' }, fetch: (u, i) => { seen.push(i.headers.Authorization); return mock.fetch(u, i); }, baseUrl: mock.baseUrl, retryDelayMs: 0 });
    return adapter.search({ query: 'x' }).then(() => assert.deepEqual([...new Set(seen)], [`Bearer ${mock.token}`]));
  });
  test('GitHub: with no variable named, GITHUB_TOKEN then GH_TOKEN are still read, and the message still says so', () => {
    assert.doesNotThrow(() => direct('github', { env: { GITHUB_TOKEN: undefined, GH_TOKEN: 'gh-token-value' } }));
    assert.throws(() => direct('github', { env: { GITHUB_TOKEN: '', GH_TOKEN: '' } }), (e) => /GITHUB_TOKEN \(or GH_TOKEN\) is not set/.test(e.message));
  });
});
