'use strict';

// Findings from the third independent review of the triage PR (the one that ran ~310 hand-made mutants). Each test failed on the code it was
// written against. The theme: places where a real PRODUCT bug could be reported as "flaky", "environment" or "test-bug" at a confidence that acts.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../../scripts/triage/classify');
const { infraSignal, testCrash, normalizeSignature, firstSourceFrame } = require('../../scripts/triage/lib/text');

const err = (message, kind = 'failure', details = '') => ({ kind, message, details });
const fail = (name, error, extra) => ({ name, status: 'failed', error, ...extra });
const pass = (name, extra) => ({ name, status: 'passed', ...extra });
const run = (...tests) => ({ format: 'tap', totals: {}, tests });
const only = (report) => { assert.equal(report.verdicts.length, 1, JSON.stringify(report.verdicts.map((v) => v.test.name))); return report.verdicts[0]; };
const twice = (e, opts = {}, extra = {}) => only(classify({ runs: [run(fail('t', e, extra)), run(fail('t', e, extra))], ...opts }));

describe('TST-2 (the test crashed): only a crash that can ONLY be the test\'s fault acts', () => {
  // An API test that reads a response whose shape changed throws a TypeError in the TEST file, because the app is remote: the first frame is always the
  // test. That is a product regression reported as a test bug.
  const shape = err("TypeError: Cannot read properties of undefined (reading 'reduce')", 'error', 'at TestContext.<anonymous> (/work/tests/api/cart.test.js:14:22)');

  test('a TypeError / "is not a function" in the test file is test-bug but only a PROPOSAL (0.65): the same text is what a changed response shape produces', () => {
    const v = twice(shape, { root: '/work' });
    assert.deepEqual([v.class, v.rule, v.confidence, v.action], ['test-bug', 'TST-2', 0.65, 'propose']);
    const nf = twice(err('TypeError: helpers.login is not a function', 'error', 'at (/work/tests/a.test.js:3:3)'), { root: '/work' });
    assert.deepEqual([nf.rule, nf.confidence, nf.action], ['TST-2', 0.65, 'propose']);
  });
  test('a ReferenceError / SyntaxError / missing module / "is not defined" in the test file is still 0.8 and acts: no app response can cause it', () => {
    for (const m of ['ReferenceError: cart is not defined', 'SyntaxError: Unexpected token', "Error: Cannot find module './helpers'", 'NameError: name x is not defined']) {
      const v = twice(err(m, 'error', 'at (/work/tests/a.test.js:3:3)'), { root: '/work' });
      assert.deepEqual([v.rule, v.confidence, v.action], ['TST-2', 0.8, 'act'], m);
    }
  });
  test('with several attempts the verdict is as strong as the WEAKEST one', () => {
    const strong = err('ReferenceError: x is not defined', 'error', 'at (/work/tests/a.test.js:3:3)');
    const v = only(classify({ root: '/work', runs: [run(fail('t', strong)), run(fail('t', shape))] }));
    assert.deepEqual([v.rule, v.confidence], ['TST-2', 0.65]);
  });

  describe('"a test file" is judged on the path below the project root, not on any ancestor directory named tests/', () => {
    const app = (dir) => err("TypeError: Cannot read properties of undefined (reading 'total')", 'error', `at totals (${dir}/src/cart.js:30:11)`);
    test('an app file under a checkout that itself lives in a tests/ directory is app code', () => {
      const e = app('/home/ci/tests/shop');
      assert.equal(testCrash(e, { root: '/home/ci/tests/shop' }), null);
      assert.notEqual(twice(e, { root: '/home/ci/tests/shop' }).rule, 'TST-2');
      assert.equal(testCrash(e, { root: '/home/ci/work/shop' }), null, 'outside the root, only the FILE NAME can say "test"');
    });
    test('inside the root a tests/ (specs/, e2e/, cypress/e2e/) directory still marks a test file; so does a test-looking file name anywhere', () => {
      const at = (f) => err('ReferenceError: x is not defined', 'error', `at run (${f}:1:1)`);
      assert.ok(testCrash(at('/home/ci/tests/shop/tests/cart.js'), { root: '/home/ci/tests/shop' }));
      assert.ok(testCrash(at('/w/e2e/checkout.js'), { root: '/w' }));
      assert.ok(testCrash(at('/w/cypress/e2e/a.js'), { root: '/w' }));
      assert.ok(testCrash(at('/elsewhere/cart.spec.ts'), { root: '/w' }), 'file-name patterns do not need the root');
      assert.ok(testCrash(at('tests/cart.js'), { root: '/w' }), 'a relative path is already below the root');
      assert.equal(testCrash(at('/elsewhere/tests/cart.js'), { root: '/w' }), null);
    });
    test('the root defaults to the current directory', () => {
      const here = process.cwd();
      assert.ok(testCrash(err('ReferenceError: x is not defined', 'error', `at (${here}/tests/a.js:1:1)`)));
      assert.equal(testCrash(err('ReferenceError: x is not defined', 'error', 'at (/nowhere/else/tests/a.js:1:1)')), null);
    });
  });
});

describe('ENV-2 (infrastructure error)', () => {
  test('a data comparison that merely looks like an HTTP status is not a 5xx: only 100-599 on the other side counts', () => {
    for (const m of ['503 !== 600', '502 !== 1000', '504 === 700', '999 !== 503']) assert.equal(infraSignal(m), null, m);
    for (const m of ['503 !== 200', '200 !== 503', '504 === 404', '502 !== 599']) assert.ok(infraSignal(m), m);
  });
  test('a healthy preflight followed by a failure in EVERY attempt that only says an HTTP status or "failed to fetch" is a proposal: a CORS rule or a removed route looks the same', () => {
    for (const m of ['Error: Failed to fetch', 'TypeError: fetch failed', '503 !== 200', 'Expected: 200\nReceived: 503 Service Unavailable']) {
      const ok = twice(err(m), { preflight: 'ok' });
      assert.deepEqual([ok.class, ok.rule, ok.confidence, ok.action], ['environment', 'ENV-2', 0.7, 'propose'], m);
      assert.match(ok.evidence.join(' '), /preflight/, m);
      const unknown = twice(err(m), { preflight: 'unknown' });
      assert.deepEqual([unknown.confidence, unknown.action], [0.9, 'act'], m);
    }
  });
  test('a network-level error (refused, not resolved, TLS) is an outage whatever the preflight said', () => {
    for (const m of ['connect ECONNREFUSED 127.0.0.1:3000', 'getaddrinfo ENOTFOUND qa.invalid', 'self-signed certificate', 'net::ERR_CONNECTION_REFUSED']) {
      const v = twice(err(m, 'error'), { preflight: 'ok' });
      assert.deepEqual([v.rule, v.confidence, v.action], ['ENV-2', 0.9, 'act'], m);
    }
  });
  test('one weak and one strong attempt: the strong one keeps it an outage', () => {
    const v = only(classify({ preflight: 'ok', runs: [run(fail('t', err('Failed to fetch'))), run(fail('t', err('connect ECONNREFUSED x', 'error')))] }));
    assert.deepEqual([v.rule, v.confidence], ['ENV-2', 0.9]);
  });
  test('…but one that came back (a blip) keeps its 0.9: the failure did not persist', () => {
    const v = only(classify({ preflight: 'ok', runs: [run(fail('t', err('connect ECONNREFUSED x', 'error'))), run(pass('t'))] }));
    assert.deepEqual([v.rule, v.confidence], ['ENV-2', 0.9]);
  });
});

describe('TST-1 (stale selector): the DOM evidence must be about THIS failure', () => {
  const stale = (id) => err(`Error: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('${id}')`, 'timeout');
  const ev = (target) => ({ 'ui-1': { locator: { target, present: false, candidates: [{ testid: 'add-to-basket', similarity: 0.67, tag: 'button', text: 'Add' }] } } });
  const runs = (id) => [run(fail('ui-1', stale(id), { file: 'c.spec.ts' })), run(fail('ui-1', stale(id), { file: 'c.spec.ts' }))];
  test('evidence for the id that is in the error → TST-1', () => {
    assert.equal(only(classify({ runs: runs('add-to-cart'), evidence: ev('add-to-cart') })).rule, 'TST-1');
  });
  test('evidence about a DIFFERENT id (an earlier run\'s, or another failure\'s) is ignored, and says so', () => {
    const v = only(classify({ runs: runs('checkout-button'), evidence: ev('add-to-cart') }));
    assert.equal(v.rule, 'UND-1');
    assert.equal(v.action, 'propose');
    assert.match(v.evidence.join(' '), /different locator/);
    assert.match(v.evidence.join(' '), /add-to-cart/);
  });
  test('a prefix is not a match either: "add-to-cart" evidence does not support a failure on "add-to-cart-all"', () => {
    // the id in the error is "add-to-cart-all", which CONTAINS the evidence target as a substring
    const v = only(classify({ runs: runs('add-to-cart-all'), evidence: ev('add-to-cart') }));
    assert.equal(v.rule, 'UND-1');
  });
});

describe('inputs cannot make the text rules quadratic (they are capped before the regexes run)', () => {
  const ms = (fn) => { const t = Date.now(); fn(); return Date.now() - t; };
  test('a long run of path-like text', () => {
    assert.ok(ms(() => normalizeSignature('/a'.repeat(80000))) < 500);
  });
  test('a long word where a source file is looked for', () => {
    assert.ok(ms(() => firstSourceFrame('x'.repeat(40000))) < 300);
  });
});

describe('redactSecrets: what a test failure may have printed must not be copied into a bug or a comment', () => {
  const { redactSecrets } = require('../../scripts/triage/lib/text');
  const gone = (input, ...secrets) => { const out = redactSecrets(input); for (const s of secrets) assert.ok(!out.includes(s), `${JSON.stringify(s)} survived in: ${out}`); return out; };
  test('authorization headers and bearer / basic credentials', () => {
    gone('Authorization: Bearer abc123def456ghi789jkl', 'abc123def456ghi789jkl');
    gone('got header authorization=Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA==');
    gone('sent Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 'eyJhbGci', 'abcdefghijk');
  });
  test('key=value and key: value secrets, any case', () => {
    gone('password=correcthorsebattery&user=x', 'correcthorsebattery');
    gone('API_KEY: sk_live_abcdefghijklmnop', 'sk_live_abcdefghijklmnop');
    gone('"client_secret":"s3cr3t-value-here"', 's3cr3t-value-here');
    gone('Cookie: sid=abcdef123456; theme=dark', 'abcdef123456');
  });
  test('well-known token shapes', () => {
    gone('using ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'ghp_AAAA');
    gone('glpat-abcdefghij1234567890', 'glpat-abcdefghij');
    gone('xoxb-1234-5678-abcdefghij', 'xoxb-1234');
    gone('AKIAABCDEFGHIJKLMNOP is the key', 'AKIAABCDEFGHIJKLMNOP');
  });
  test('credentials embedded in a URL', () => {
    const out = gone('GET https://deploy:hunter2secret@staging.example.test/x failed', 'hunter2secret', 'deploy:');
    assert.match(out, /staging\.example\.test/, 'the host stays: it is the evidence');
  });
  test('ordinary failure text is left alone: assertions, paths, numbers, short words', () => {
    for (const t of ['expected 200 but received 503', 'Cannot read properties of undefined (reading \'total\')', 'at /work/tests/a.test.js:3:3', 'token expired for the session', 'locator getByTestId(\'add-to-cart\') not found', 'password field is required']) {
      assert.equal(redactSecrets(t), t, t);
    }
  });
  test('non-strings and empty input are safe', () => {
    assert.equal(redactSecrets(undefined), '');
    assert.equal(redactSecrets(null), '');
    assert.equal(redactSecrets(''), '');
  });
});

describe('the triage report carries redacted failure text', () => {
  test('error message, details and the evidence lines are masked; the fingerprint is computed from the original, so it does not change', () => {
    const leaky = err('request failed: Authorization: Bearer abc123def456ghi789jkl', 'failure', 'Received: password=correcthorsebattery');
    const plain = err('request failed: Authorization: Bearer abc123def456ghi789jkl', 'failure', 'Received: password=correcthorsebattery');
    const v = twice(leaky);
    const text = JSON.stringify(v);
    for (const s of ['abc123def456ghi789jkl', 'correcthorsebattery']) assert.ok(!text.includes(s), s);
    assert.equal(twice(plain).fingerprint, v.fingerprint);
  });
});

describe('every signal pattern is pinned individually (the review mutated each; most survived because no test depended on one pattern alone)', () => {
  const { INFRA, AUTH, ERROR_PAGE, LOCATOR, evidenceText } = require('../../scripts/triage/lib/text');
  // For a pattern list: every sample is matched by EXACTLY ONE pattern, and every pattern is the unique match of at least one sample. So deleting,
  // narrowing or reordering a single pattern fails a test, and adding a pattern forces a sample for it.
  const pinned = (name, patterns, samples) => {
    test(`${name}: ${samples.length} samples, one per pattern (and per alternative)`, () => {
      const owner = new Set();
      for (const s of samples) {
        const hits = patterns.map((re, i) => (re.test(s) ? i : -1)).filter((i) => i >= 0);
        assert.equal(hits.length, 1, `${JSON.stringify(s)} should match exactly one ${name} pattern, matched [${hits.map((i) => patterns[i].source.slice(0, 40)).join(' | ')}]`);
        owner.add(hits[0]);
      }
      const unowned = patterns.map((re, i) => (owner.has(i) ? null : re.source.slice(0, 60))).filter(Boolean);
      assert.deepEqual(unowned, [], 'patterns with no sample of their own');
    });
  };

  pinned('INFRA', INFRA, [
    'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'getaddrinfo',
    'ERR_CONNECTION_CLOSED', 'ERR_NAME_NOT_RESOLVED', 'ERR_INTERNET_DISCONNECTED', 'ERR_ADDRESS_UNREACHABLE', 'ERR_TIMED_OUT', 'ERR_CERT_DATE_INVALID', 'ERR_SSL_PROTOCOL_ERROR',
    'ERR_BAD_SSL_CLIENT_AUTH_CERT', 'ERR_EMPTY_RESPONSE', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_PROXY_CONNECTION_FAILED', 'ERR_NETWORK_CHANGED',
    'connect ECONN', 'socket hang up',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'self-signed certificate', 'self signed certificate', 'certificate has expired', 'certificate is not yet valid', 'certificate verify failed',
    'Bad Gateway', 'Service Unavailable', 'Gateway Timeout', 'Gateway Time-out', 'HTTP 502', 'HTTP 504', 'code 503', 'status: 502', 'Received: 504',
    'fetch failed', 'Failed to fetch', 'NetworkError when attempting to fetch', 'Load failed', 'Network request failed', '502 !== 200', '200 === 504',
  ]);

  pinned('AUTH', AUTH, [
    'Received: 401', 'Received: 403', 'Received string: "http://app/login"', 'Received: http://app/sign-in', 'Received: http://app/signin', 'Received: http://app/auth', 'Received: http://app/sso', 'Received: http://app/session-expired',
    'status: 401', 'code 403', 'HTTP 401', 'HTTP 403', 'session expired', 'session has timed out', 'token expired', 'credentials has expired', 'unauthorized', 'Unauthorised',
    '401 !== 200', '200 === 403',
  ]);

  pinned('LOCATOR', LOCATOR, [
    'waiting for getByRole', 'waiting for locator', 'waiting for selector', 'locator.click: Timeout 30000ms exceeded', 'locator.fill: element not visible (not found)', 'resolved to 0 elements', '<element(s) not found>',
    'strict mode violation', 'resolved to 3 elements', 'Expected to find element', 'Expected to find content', 'no such element', 'unable to locate element', 'unable to find an element',
    'unable to find css', 'unable to find visible', 'Element not found', 'no element found', 'no elements found', 'locator not found', 'NoSuchElementException', 'Capybara::ElementNotFound',
  ]);

  test('ERROR_PAGE: each status / page-text alternative, and both orders of a comparison', () => {
    for (const s of ['Received: 404', 'Received: 500', 'Received: Not Found', 'Received: Internal Server Error', 'Received: Application Error', 'Received: Something went wrong', '404 !== 200', '200 === 500']) {
      assert.ok(ERROR_PAGE.some((re) => re.test(s)), s);
    }
    for (const s of ['Received: 200', '404 !== 4040', 'Not Found without the Received word']) assert.ok(!ERROR_PAGE.some((re) => re.test(s)), s);
  });
});

describe('ENV-3 (blast radius): the thresholds are pinned at their boundaries', () => {
  // N tests; `same` fail with one error, `other` fail each with a DIFFERENT error; the rest pass. One attempt each, so without ENV-3 the verdict is PRD-3.
  const world = ({ total, same, other = 0 }) => {
    const tests = [];
    for (let i = 0; i < same; i += 1) tests.push(fail(`same ${i}`, err('shared outage message')));
    for (let i = 0; i < other; i += 1) tests.push(fail(`other ${i}`, err(`a different failure number ${String.fromCharCode(97 + i)}${'x'.repeat(i)} ${'y'.repeat(i * 3)}`)));
    while (tests.length < total) tests.push(pass(`ok ${tests.length}`));
    return classify({ runs: [run(...tests)] });
  };
  const rules = (report, prefix) => report.verdicts.filter((v) => v.test.name.startsWith(prefix)).map((v) => v.rule);
  test('half the run failing is enough (>= 0.5, not > 0.5); just under half is not', () => {
    assert.deepEqual([...new Set(rules(world({ total: 10, same: 5 }), 'same'))], ['ENV-3']);
    assert.deepEqual([...new Set(rules(world({ total: 10, same: 4 }), 'same'))], ['PRD-3']);
    assert.deepEqual([...new Set(rules(world({ total: 11, same: 5 }), 'same'))], ['PRD-3'], '5 of 11 is under half');
  });
  test('three failures is the minimum: two of two is not a blast', () => {
    assert.deepEqual([...new Set(rules(world({ total: 3, same: 3 }), 'same'))], ['ENV-3']);
    assert.deepEqual([...new Set(rules(world({ total: 2, same: 2 }), 'same'))], ['PRD-3']);
  });
  test('one error must account for 80% of the failures (>= 0.8): 8 of 10 qualifies, 7 of 10 does not', () => {
    const at80 = world({ total: 10, same: 8, other: 2 });
    assert.deepEqual([...new Set(rules(at80, 'same'))], ['ENV-3']);
    assert.ok(!rules(at80, 'other').includes('ENV-3'), 'the odd ones out are not the blast');
    assert.deepEqual([...new Set(rules(world({ total: 10, same: 7, other: 3 }), 'same'))], ['PRD-3']);
  });
  test('the share is of the FAILED tests, not of the whole run', () => {
    assert.deepEqual([...new Set(rules(world({ total: 40, same: 20 }), 'same'))], ['ENV-3'], 'all 20 failures are one error although half the run passed');
  });
  test('only the failures with that error are called a blast, and only when that is the main run\'s picture', () => {
    const v = world({ total: 10, same: 5 }).verdicts[0];
    assert.equal(v.rule, 'ENV-3');
    assert.deepEqual([v.class, v.confidence, v.action], ['environment', 0.6, 'propose']);
  });
});

describe('classify CLI flags that change what may act', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { main } = require('../../scripts/triage/classify');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-r3-'));
  const write = (name, obj) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
  const cli = (argv) => { let out = ''; let e = ''; const code = main({ argv, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { e += s; } } }); return { code, err: e, json: out ? JSON.parse(out) : null }; };
  const ids = { ticket: 'DEMO-1', caseId: 'TC-1' };
  const m = (format) => write(`m-${format}.json`, { format, totals: {}, tests: [fail('DEMO-1/TC-1: x', err('the answer is wrong'), ids)] });

  test('--trusted-formats none: nothing may act, even TAP; and a format that is listed may', () => {
    const tap = m('tap');
    const none = cli(['--run', tap, '--rerun', tap, '--trusted-formats', 'none']).json.data.verdicts[0];
    assert.deepEqual([none.rule, none.action, none.cap], ['PRD-1', 'propose', 'unverified-format']);
    const dflt = cli(['--run', tap, '--rerun', tap]).json.data.verdicts[0];
    assert.deepEqual([dflt.rule, dflt.action, dflt.cap], ['PRD-1', 'act', undefined]);
    const pw = m('playwright-json');
    assert.equal(cli(['--run', pw, '--rerun', pw]).json.data.verdicts[0].action, 'propose', 'untrusted by default');
    assert.equal(cli(['--run', pw, '--rerun', pw, '--trusted-formats', 'tap,playwright-json']).json.data.verdicts[0].action, 'act');
  });
  test('--root is what "below the project root" means for test-file directories', () => {
    const crash = write('crash.json', { format: 'tap', totals: {}, tests: [fail('t', err('ReferenceError: x is not defined', 'error', 'at (/home/ci/proj/tests/helpers.js:3:3)'))] });
    const rule = (extra) => cli(['--run', crash, '--rerun', crash, ...extra]).json.data.verdicts[0].rule;
    assert.equal(rule(['--root', '/home/ci/proj']), 'TST-2');
    assert.notEqual(rule(['--root', '/somewhere/else']), 'TST-2');
  });
});

describe('testCrash vocabulary and what counts as an assertion', () => {
  const at = (message, details = 'at run (/w/tests/a.test.js:3:3)') => testCrash({ kind: 'error', message, details }, { root: '/w' });
  test('each crash wording is recognised (with its strength)', () => {
    for (const [m, strong] of [['TypeError: x', false], ['ReferenceError: x is not defined', true], ['SyntaxError: bad', true], ["Error: Cannot find module './x'", true], ['x is not a function', false], ['y is not defined', true],
      ['NameError: name z', true], ["AttributeError: 'NoneType' object", false], ["NoMethodError: undefined method 'foo'", false], ["undefined method 'foo' for nil", false]]) {
      const c = at(m);
      assert.ok(c, m);
      assert.equal(c.strong, strong, m);
    }
  });
  test('the assertion test reads the MESSAGE only: an "AssertionError" in the details does not turn a crash into an assertion', () => {
    assert.ok(at('TypeError: x is not a function', 'AssertionError was mentioned here\nat run (/w/tests/a.test.js:3:3)'));
    assert.equal(at('AssertionError: expected 1 to equal 2', 'at (/w/tests/a.test.js:1:1)'), null);
    assert.equal(at('TypeError: expected the value to be a string but got a number', 'at (/w/tests/a.test.js:1:1)'), null);
    assert.equal(at('TypeError: x !== y', 'at (/w/tests/a.test.js:1:1)'), null);
  });
  test('evidence is capped (a whole stack trace is not evidence)', () => {
    const { evidenceText } = require('../../scripts/triage/lib/text');
    assert.equal(evidenceText({ message: 'm', details: 'x'.repeat(10000) }).length, 4000);
  });
});
