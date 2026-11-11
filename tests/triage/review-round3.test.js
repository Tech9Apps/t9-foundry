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
