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
  test('a ReferenceError / SyntaxError / "is not defined" in the test file is still 0.8 and acts', () => {
    for (const m of ['ReferenceError: cart is not defined', 'SyntaxError: Unexpected token }', 'NameError: name x is not defined']) {
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
    for (const m of ['503 !== 200', '200 !== 503', '504 === 404', '502 !== 404']) assert.ok(infraSignal(m), m);
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
    for (const [m, strong] of [['TypeError: x', false], ['ReferenceError: x is not defined', true], ['SyntaxError: bad', true], ["Error: Cannot find module './x'", false], ['x is not a function', false], ['y is not defined', true],
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

describe('TST-2 "strong": only a crash that NO response from the app can cause acts (second look)', () => {
  const frame = 'at TestContext.<anonymous> (/repo/tests/api/cart.spec.ts:14:22)';
  const strength = (message, details = frame) => { const c = testCrash({ kind: 'error', message, details }, { root: '/repo' }); return c && c.strong; };
  test('a SyntaxError / ReferenceError the app can cause is only 0.65: a response that is not JSON, a removed global inside page.evaluate, an error from the application\'s own code', () => {
    for (const m of [
      "SyntaxError: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
      'SyntaxError: Unexpected end of JSON input',
      'SyntaxError: JSON.parse: unexpected character at line 1 column 1',
      'page.evaluate: ReferenceError: appStore is not defined',
      'locator.evaluate: ReferenceError: cart is not defined',
      'The following error originated from your application code, not from Cypress.\n\n  > checkout is not defined',
    ]) assert.equal(strength(m), false, m);
  });
  test('a missing module is only 0.65 as well (a test that imports the app\'s file fails when the app renames it)', () => {
    assert.equal(strength("Error: Cannot find module '../src/server'"), false);
    assert.equal(strength("Error: Cannot find module './helpers'"), false);
  });
  test('what only the test can cause stays strong: a plain ReferenceError / SyntaxError / NameError in the test\'s own code', () => {
    for (const m of ['ReferenceError: cart is not defined', 'ReferenceError: expect is not defined', 'SyntaxError: Unexpected token }', 'SyntaxError: missing ) after argument list', 'NameError: name \'x\' is not defined']) assert.equal(strength(m), true, m);
  });
  test('a root of "/" (or none that means anything) switches directory patterns OFF: only the file name can say "test"', () => {
    const e = (f) => ({ kind: 'error', message: 'ReferenceError: x is not defined', details: `at (${f}:1:1)` });
    assert.equal(testCrash(e('/home/ci/tests/shop/src/cart.js'), { root: '/' }), null);
    assert.equal(testCrash(e('/home/ci/tests/shop/src/cart.js'), { root: '' }), null);
    assert.ok(testCrash(e('/home/ci/tests/shop/cart.spec.js'), { root: '/' }), 'a .spec. file name is still a test file');
  });
});

describe('ENV-2 status comparisons: the other side must be a status code that exists', () => {
  test('a count or quantity in the 100-599 range that is not an HTTP status is not a gateway error', () => {
    for (const m of ['503 !== 450', '502 !== 150', '504 === 333', '450 !== 503', '999 !== 503']) assert.equal(infraSignal(m), null, m);
  });
  test('real status codes still are, in either order', () => {
    for (const m of ['503 !== 200', '200 !== 503', '504 === 404', '502 !== 301', '429 !== 502', '502 !== 204', '500 !== 504']) assert.ok(infraSignal(m), m);
  });
});

describe('redactSecrets, second pass: the shapes the review found leaking, and the assertion text it must not destroy', () => {
  const { redactSecrets } = require('../../scripts/triage/lib/text');
  const masked = (input, ...secrets) => { const out = redactSecrets(input); for (const x of secrets) assert.ok(!out.includes(x), `${JSON.stringify(x)} survived in ${JSON.stringify(out)}`); return out; };
  test('a letters-only bearer token', () => { masked('Authorization header was Bearer abcdefghijklmnopqrstuvwx', 'abcdefghijklmnopqrstuvwx'); masked('sent Bearer abcdefghijklmnopqrstuv', 'abcdefghijklmnopqrstuv'); });
  test('keys with a prefix attached by _ or -', () => {
    masked('aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI');
    masked('csrf_token=abc123xyz789', 'abc123xyz789');
    masked('sessionid=9f8e7d6c5b4a', '9f8e7d6c5b4a');
    masked('session_id: 9f8e7d6c5b4a3210', '9f8e7d6c5b4a3210');
    masked('apiToken: "tok_abcdefghijklmnop"', 'tok_abcdefghijklmnop');
    masked('X-Amz-Signature=0123456789abcdef0123', '0123456789abcdef0123');
    masked('my-service-password=hunter2hunter2', 'hunter2hunter2');
  });
  test('a PEM private key block, whole, even when it is cut off', () => {
    masked('key:\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\nafter', 'MIIEvQIB');
    masked('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn', 'MIIEowIB');
    assert.match(redactSecrets('before -----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY----- after'), /before .* after/);
  });
  test('more token shapes: Stripe keys, npm tokens, Slack/Discord webhooks, a key in a query string', () => {
    masked('sk_live_abcdefghijklmnopqrstu', 'sk_live_abcdef');
    masked('rk_test_abcdefghijklmnopqrstu', 'rk_test_abcdef');
    masked('npm_abcdefghijklmnopqrstuvwxyz0123456789', 'npm_abcdef');
    masked('POST https://hooks.slack.com/services/T0000000/B0000000/XXXXXXXXXXXXXXXXXXXXXXXX failed', 'XXXXXXXXXXXXXXXX', 'B0000000');
    masked('https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF', 'abcdefghijklmnopqrstuvwxyz');
    masked('GET /v1/places?key=AIzaSyDabcdefghijklmnopqrstu&q=x', 'AIzaSyDabcdefghijklmnopqrstu');
  });
  test('short values and multi-word passphrases', () => {
    masked('password=ab', 'ab');
    masked('{"password":"xy"}', 'xy');
    masked('password: my secret passphrase', 'my', 'secret passphrase', 'passphrase');
    masked("passphrase: 'correct horse battery staple'", 'correct horse', 'staple');
  });
  test('assertion text ABOUT a field (validation messages, expected/received values) is left alone', () => {
    for (const t of ['Expected: "Password: required"', 'Received: "Password: too short"', 'expected token: expired to equal token: valid', 'Received: cookie: accepted', 'expected authorization: granted',
      'expected password: invalid to be shown', 'the password: field is required', 'Secret: none']) assert.equal(redactSecrets(t), t, t);
  });
  test('a cookie or authorization header with a real value is still masked', () => {
    masked('Cookie: sid=abcdef123456; theme=dark', 'abcdef123456');
    masked('Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz');
    masked('authorization: Token abcdef0123456789', 'abcdef0123456789');
    masked('Authorization: 0123456789abcdef0123456789', '0123456789abcdef');
  });
});

describe('what is shown is masked BEFORE it is cut, so a secret at the cut cannot leak its first characters', () => {
  test('the details kept in the report (cut at 1000) and the signature (cut at 300)', () => {
    // the cut lands one character into the value: "password=S" is all that is left of it, and a rule that needs three characters would let it through
    const details = `${'x'.repeat(989)} password=SuperSecret123456 trailing`; // 989 + space + len('password=') = 999: the 1000-character cut keeps 'password=S'
    const message = `${'a'.repeat(289)} password=abcdefghijklmnop`; // the signature's 300-character cut keeps 'password=a'
    const v = twice(err(message, 'failure', details));
    const text = JSON.stringify(v);
    for (const leak of ['password=S', 'password=a', 'SuperSecret', 'abcdefgh']) assert.ok(!text.includes(leak), `${leak} leaked`);
  });
  test('a token SHAPE that is only recognised at full length (a GitHub token needs 20+ characters) is not left half-visible by the cut', () => {
    const token = `ghp_${'A'.repeat(36)}`;
    // the 1000-character cut of the details keeps only 'ghp_' plus 10 characters, which no pattern would recognise on its own
    const details = `${'x'.repeat(985)} ${token}`;
    const message = `${'a'.repeat(285)} ${token}`; // and the 300-character cut of the signature
    const v = twice(err(message, 'failure', details));
    const text = JSON.stringify(v);
    assert.ok(!text.includes('ghp_AAAA'), `leaked: ${text.slice(0, 120)}`);
    assert.ok(!text.includes('AAAAAAAA'));
  });
});

describe('plan: the test title in a comment is masked too', () => {
  test('a title that carries a secret', () => {
    const { plan } = require('../../scripts/triage/plan');
    const ids = { ticket: 'DEMO-1', caseId: 'TC-1' };
    const title = 'DEMO-1/TC-1: login with password=hunter2hunter2 works';
    const report = classify({ runs: [run(fail(title, err('the answer is wrong'), ids)), run(fail(title, err('the answer is wrong'), ids))] });
    const adapter = { async search() { return { items: [{ id: '1', title: 't', status: 'open', open: true, url: 'u' }] }; }, async fetchTicket() { return { description: `qa-harness-fingerprint: ${report.verdicts[0].token}` }; } };
    return plan({ report, runId: 'r1', adapter }).then((p) => {
      const body = p.actions[0].commentInput.body;
      assert.ok(!body.includes('hunter2hunter2'), body);
    });
  });
});

describe('redactSecrets stays fast on hostile input (it runs on text a test printed)', () => {
  const { redactSecrets } = require('../../scripts/triage/lib/text');
  for (const [name, input] of Object.entries({ 'dashed run': 'a-'.repeat(10000), 'prefixed key spam': 'my-'.repeat(7000) + 'token', 'scheme-like run': 'a+a+a.'.repeat(3000), 'dotted run': 'a.a.'.repeat(5000), 'colon spam': 'password: '.repeat(2000) })) {
    test(name, () => {
      const t = Date.now();
      redactSecrets(input);
      assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`); // a quadratic blow-up is seconds; a slow CI machine is not
    });
  }
});

describe('redactSecrets, last pass: remaining leaks, evidence it must keep, and stable fingerprints', () => {
  const { redactSecrets } = require('../../scripts/triage/lib/text');
  const { fingerprint } = require('../../scripts/triage/fingerprint');
  const masked = (input, ...secrets) => { const out = redactSecrets(input); for (const x of secrets) assert.ok(!out.includes(x), `${JSON.stringify(x)} survived in ${JSON.stringify(out)}`); return out; };
  test('the common Django / framework names and lower-case bearer', () => {
    masked('SECRET_KEY=abcdef123456ghij', 'abcdef123456ghij');
    masked('DJANGO_SECRET_KEY=django-insecure-xyz123', 'django-insecure-xyz123');
    masked('SIGNING_KEY=abcdef123456', 'abcdef123456'); masked('ENCRYPTION_KEY=abcdef123456', 'abcdef123456');
    masked("headers: [ 'x', 'bearer abcdefghijklmnop1234' ]", 'abcdefghijklmnop1234');
    masked("headers: [ 'x', 'bearer abcdefghijklmnopqrstuvwx' ]", 'abcdefghijklmnopqrstuvwx'); // letters only: only the long-bearer rule can catch it
  });
  test('"label value" prose with no separator, when the value is token-shaped', () => {
    masked('using api key abcd1234efgh5678 for the call', 'abcd1234efgh5678');
    masked('token 8f14e45fceea167a5a36dedd4bea2543 rejected', '8f14e45fceea167a5a36dedd4bea2543');
    masked('secret access key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI');
  });
  test('a comparison of values is evidence, not a secret: the assertion survives', () => {
    for (const t of ['Error: secret: 42 !== 43', 'Expected: "secret: 42"', 'secret: 7 === 8', 'token: 123 != 456']) assert.equal(redactSecrets(t), t, t);
  });
  test('a benign value on an assignment is kept (undefined, null, true, false, none)', () => {
    for (const t of ['password=undefined', 'token=null', 'access_token=undefined', 'secret=false', 'api_key=none', 'password=']) assert.equal(redactSecrets(t), t, t);
  });
  test('an authorization header masks the credential, not the rest of the line (the assertion after it is evidence)', () => {
    const out = redactSecrets('Authorization: Bearer abc.def.ghi1234 expected 1 to equal 2');
    assert.ok(!out.includes('abc.def.ghi1234'));
    assert.match(out, /expected 1 to equal 2/);
    const basic = redactSecrets('Authorization: Basic dXNlcjpwYXNz received 401');
    assert.ok(!basic.includes('dXNlcjpwYXNz'));
    assert.match(basic, /received 401/);
  });
  test('a quoted value keeps its closing quote when it is masked', () => {
    assert.equal(redactSecrets('Expected: "password: hunter2hunter2"'), 'Expected: "password: <redacted>"');
  });
  test('a per-run secret does not change the fingerprint: the same defect is one report however the token rotates (and PRD-1 still sees the same error twice)', () => {
    const t = (tok) => ({ name: 'DEMO-1/TC-1: calls the api', ticket: 'DEMO-1', caseId: 'TC-1', error: { kind: 'failure', message: `request failed: Authorization: Bearer ${tok}`, details: `Received: password=${tok}` } });
    assert.equal(fingerprint(t('aaaa1111bbbb2222cccc3333')).fingerprint, fingerprint(t('zzzz9999yyyy8888xxxx7777')).fingerprint);
    const v = only(classify({ runs: [run(fail(t('aaaa1111bbbb2222cccc3333').name, t('aaaa1111bbbb2222cccc3333').error, { ticket: 'DEMO-1', caseId: 'TC-1' })), run(fail(t('zzzz9999yyyy8888xxxx7777').name, t('zzzz9999yyyy8888xxxx7777').error, { ticket: 'DEMO-1', caseId: 'TC-1' }))] }));
    assert.equal(v.rule, 'PRD-1', 'two attempts whose only difference is the rotated secret are the same failure');
  });
});
