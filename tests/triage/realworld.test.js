'use strict';

// Failures as a REAL reporter emits them, run through the REAL parser — not hand-built objects.
//
// Review of the first version found that Playwright (and Jest) put a one-line summary in `error.message` and the diagnosis in
// `error.details`. The classifier read only the message, so a stale selector, an expired session, a 503 and a 404 page were all
// "an assertion failed" → product-bug at 0.85 → `act` → a bug filed. The seeded scenarios use node:test TAP, whose message is
// whole, so nothing exercised that path. These tests do.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('../node_modules/ajv');
const { classify, DEFAULT_TRUSTED_FORMATS } = require('../../scripts/triage/classify');
const { parseText } = require('../../scripts/results/normalize');

const validateReport = new Ajv({ allErrors: true, strict: false }).compile(require('../../schemas/triage-report.schema.json'));
const ESC = '\u001b';
const dim = (s) => `${ESC}[2m${s}${ESC}[22m`;

// one Playwright JSON document holding one failing test, shaped the way the JSON reporter writes it (ANSI and all)
function playwrightRun(title, message) {
  const body = message.replace(/^(\S+)/, (first) => `${dim(first)}`); // the reporter colours parts of the text; the parser must see through it
  const doc = {
    config: {}, stats: {},
    suites: [{ title: 'checkout.spec.ts', file: 'checkout.spec.ts', specs: [], suites: [{ title: 'checkout', specs: [{
      title, file: 'checkout.spec.ts', line: 9,
      tests: [{ projectName: 'chromium', status: 'unexpected', results: [{ status: 'failed', duration: 5000, error: { message: body, stack: `${body}\n    at /repo/tests/checkout.spec.ts:9:5` } }] }],
    }], suites: [] }] }],
  };
  return parseText(JSON.stringify(doc), 'playwright-json', {});
}

const TITLE = 'DEMO-101/TC-005: a second code is rejected';
// the main run plus two identical re-runs, which is what a consistent failure looks like to the classifier
const threeRuns = (message, title = TITLE) => [playwrightRun(title, message), playwrightRun(title, message), playwrightRun(title, message)];
const verdictOf = (message, opts = {}) => {
  const report = classify({ runs: threeRuns(message), ...opts });
  assert.ok(validateReport(report), JSON.stringify(validateReport.errors));
  assert.equal(report.verdicts.length, 1);
  return report.verdicts[0];
};

// ── every message below is what Playwright writes (the multi-line text the old classifier never read) ──
const STALE_SELECTOR = `expect(locator).toBeVisible()\n\nLocator: getByTestId('add-btn')\nExpected: visible\nReceived: <element(s) not found>\nCall log:\n  - expect.toBeVisible with timeout 5000ms\n  - waiting for getByTestId('add-btn')\n`;
// the same failure with no call log (it is trimmed or absent in some reporters/configs): only "Received: <element(s) not found>" says what happened
const STALE_SELECTOR_NO_LOG = `expect(locator).toBeVisible()\n\nLocator: getByTestId('add-btn')\nExpected: visible\nReceived: <element(s) not found>\n`;
const STRICT_MODE = `expect.toBeVisible: Error: strict mode violation: getByRole('button', { name: 'Add' }) resolved to 3 elements:\n    1) <button>Add</button> aka getByTestId('add-1')\n    2) <button>Add</button> aka getByTestId('add-2')\n`;
const LOGIN_REDIRECT = `expect(page).toHaveURL(expected)\n\nExpected pattern: /dashboard/\nReceived string:  "http://localhost:3000/login"\n`;
const STATUS_503 = `expect(received).toBe(expected) // Object.is equality\n\nExpected: 200\nReceived: 503\n`;
const STATUS_401 = `expect(received).toBe(expected) // Object.is equality\n\nExpected: 200\nReceived: 401\n`;
const CERT = `page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://staging.example.com/\nCall log:\n  - navigating to "https://staging.example.com/", waiting until "load"\n`;
const SSL = `page.goto: net::ERR_SSL_PROTOCOL_ERROR at https://staging.example.com/\n`;
const EMPTY = `page.goto: net::ERR_EMPTY_RESPONSE at https://staging.example.com/\n`;
const NOT_FOUND_PAGE = `expect(locator).toHaveText(expected)\n\nLocator: locator('h1')\nExpected: "Welcome back"\nReceived: "404 Not Found"\n`;
const SERVER_ERROR_PAGE = `expect(locator).toHaveText(expected)\n\nLocator: locator('h1')\nExpected: "Order placed"\nReceived: "Internal Server Error"\n`;
const REFUSED = `page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/\n`;
const COUNT = `expect(locator).toHaveCount(expected)\n\nLocator: getByTestId('cart-line')\nExpected: 3\nReceived: 0\n`;
const WRONG_VALUE = `expect(locator).toHaveText(expected)\n\nLocator: getByTestId('currency')\nExpected: "EUR"\nReceived: "USD"\n`;

describe('failures that were misfiled as product bugs at 0.85 / act (review of PR #9)', () => {
  const NEVER_A_PRODUCT_BUG_THAT_ACTS = [
    ['a stale selector (Received: <element(s) not found>)', STALE_SELECTOR, 'undetermined', /locator/i],
    ['a stale selector when the reporter gave no call log', STALE_SELECTOR_NO_LOG, 'undetermined', /locator/i],
    ['a strict-mode violation (the locator matches 3 elements)', STRICT_MODE, 'undetermined', /locator/i],
    ['a bounce to the login page (an expired session)', LOGIN_REDIRECT, 'undetermined', /authentication or session/],
    ['a 401 where 200 was expected', STATUS_401, 'undetermined', /authentication or session/],
    ['a 503 where 200 was expected', STATUS_503, 'environment', /infrastructure error/],
    ['an untrusted certificate (ERR_CERT_AUTHORITY_INVALID)', CERT, 'environment', /infrastructure error/],
    ['a TLS protocol error (ERR_SSL_PROTOCOL_ERROR)', SSL, 'environment', /infrastructure error/],
    ['an empty response (ERR_EMPTY_RESPONSE)', EMPTY, 'environment', /infrastructure error/],
    ['a "404 Not Found" page where the heading should be', NOT_FOUND_PAGE, 'undetermined', /error page/],
    ['an "Internal Server Error" page where the heading should be', SERVER_ERROR_PAGE, 'undetermined', /error page/],
    ['connection refused', REFUSED, 'environment', /infrastructure error/],
  ];
  for (const [what, message, klass, evidence] of NEVER_A_PRODUCT_BUG_THAT_ACTS) {
    test(`${what} is ${klass}, not a product bug`, () => {
      const v = verdictOf(message);
      assert.equal(v.class, klass, `${v.class} ${v.rule} ${v.confidence}: ${v.evidence.join(' | ')}`);
      assert.match(v.evidence.join(' '), evidence);
      assert.ok(!(v.class === 'product-bug' && v.action === 'act'));
    });
  }

  test('the cause was reading only the first line: the very same failure WITHOUT its details looks like a clean assertion', () => {
    // This is what the old classifier saw. It documents why every signal now reads message + details.
    const runs = threeRuns(STALE_SELECTOR).map((r) => ({ ...r, format: 'tap', tests: r.tests.map((t) => ({ ...t, error: { kind: t.error.kind, message: t.error.message } })) }));
    const v = classify({ runs }).verdicts[0];
    assert.deepEqual([v.class, v.rule, v.action], ['product-bug', 'PRD-1', 'act']);
  });

  test('the parser keeps the diagnosis in details (so this test would notice if that stopped being true)', () => {
    const run = playwrightRun(TITLE, STALE_SELECTOR);
    assert.equal(run.tests[0].error.message, 'expect(locator).toBeVisible()');
    assert.match(run.tests[0].error.details, /Received: <element\(s\) not found>/);
  });

  test('an ordinary value assertion is still a product-bug candidate — the signals do not swallow real defects', () => {
    const v = verdictOf(WRONG_VALUE, { trustedFormats: ['playwright-json'] });
    assert.deepEqual([v.class, v.rule, v.action], ['product-bug', 'PRD-1', 'act']);
  });

  test('a locator that IS reported with DOM evidence still reaches TST-1 (the evidence path is not broken by reading details)', () => {
    const key = 'DEMO-101/TC-005';
    const evidence = { [key]: { locator: { target: 'add-btn', present: false, candidates: [{ testid: 'add-button', similarity: 0.8, tag: 'button', text: 'Add' }] } } };
    const v = verdictOf(STALE_SELECTOR, { evidence, trustedFormats: ['playwright-json'] });
    assert.deepEqual([v.class, v.rule, v.action], ['test-bug', 'TST-1', 'act']);
  });
});

describe('formats whose classification has not been verified on real output cannot act on a product-bug (the trust gate)', () => {
  test('by default only TAP is trusted', () => {
    assert.deepEqual(DEFAULT_TRUSTED_FORMATS, ['tap']);
  });

  test('a genuine-looking product bug from Playwright output reaches the threshold but is held at propose, and says why', () => {
    const v = verdictOf(COUNT);
    assert.deepEqual([v.class, v.rule, v.confidence], ['product-bug', 'PRD-1', 0.85]);
    assert.equal(v.action, 'propose');
    assert.equal(v.cap, 'unverified-format');
    assert.match(v.evidence.at(-1), /capped at propose: classification of playwright-json output has not been verified/);
  });

  test('the report says which format it rests on and whether that format is trusted', () => {
    const report = classify({ runs: threeRuns(COUNT) });
    assert.deepEqual([report.format, report.trusted, report.trustedFormats], ['playwright-json', false, ['tap']]);
    assert.equal(report.summary.act, 0);
    assert.equal(report.summary.propose, 1);
  });

  test('widening trust (a format someone has verified on real failures) lets the same verdict act', () => {
    const v = verdictOf(COUNT, { trustedFormats: ['tap', 'playwright-json'] });
    assert.equal(v.action, 'act');
    assert.equal(v.cap, undefined);
  });

  test('every other format is capped by default: junit, jest-json', () => {
    for (const format of ['junit', 'jest-json']) {
      const runs = threeRuns(COUNT).map((r) => ({ ...r, format }));
      const v = classify({ runs }).verdicts[0];
      assert.equal(v.action, 'propose', format);
      assert.equal(v.cap, 'unverified-format', format);
    }
  });

  test('TAP acts on the very same verdict', () => {
    const runs = threeRuns(COUNT).map((r) => ({ ...r, format: 'tap' }));
    assert.equal(classify({ runs }).verdicts[0].action, 'act');
  });

  test('a result that does not say what it was parsed from is untrusted (fail safe), not trusted', () => {
    const runs = threeRuns(COUNT).map(({ format, ...rest }) => rest);
    const report = classify({ runs });
    assert.equal(report.format, 'unknown');
    assert.equal(report.verdicts[0].action, 'propose');
  });

  test('an empty trusted list means nothing may act, not "everything may"', () => {
    const runs = threeRuns(COUNT).map((r) => ({ ...r, format: 'tap' }));
    assert.equal(classify({ runs, trustedFormats: [] }).verdicts[0].action, 'propose');
  });

  test('the cap holds the two classes with side effects (product-bug files a bug, test-bug may be healed) and nothing else', () => {
    const key = 'DEMO-101/TC-005';
    const evidence = { [key]: { locator: { target: 'add-btn', present: false, candidates: [{ testid: 'add-button', similarity: 0.8, tag: 'button', text: 'Add' }] } } };
    const testBug = verdictOf(STALE_SELECTOR, { evidence });
    assert.deepEqual([testBug.class, testBug.rule, testBug.confidence, testBug.action, testBug.cap], ['test-bug', 'TST-1', 0.85, 'propose', 'unverified-format']);
    const env = verdictOf(REFUSED);
    assert.deepEqual([env.class, env.action, env.cap], ['environment', 'act', undefined]);
  });

  test('the CLI refuses an unknown format name, so a typo cannot silently widen trust', () => {
    const { parseTrustedFormats } = require('../../scripts/triage/classify');
    assert.deepEqual(parseTrustedFormats('tap,junit'), ['tap', 'junit']);
    assert.deepEqual(parseTrustedFormats('none'), []);
    assert.deepEqual(parseTrustedFormats(''), []);
    assert.throws(() => parseTrustedFormats('tap,playwrite-json'), /unknown format "playwrite-json"/);
  });
});
