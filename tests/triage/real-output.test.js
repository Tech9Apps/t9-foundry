'use strict';

// Triage on REAL reporter output. tests/fixtures/results/real/ holds the raw reports Jest 30.5.2 and Playwright 1.65.0 wrote for a tiny demo app
// whose failures have known causes (see that folder's README). Until these existed, every Jest and Playwright fixture in the suite had been written
// by hand to match the reporters' documented shape. The first real run found two mistakes hand-written fixtures could not have:
//   - Playwright words an action timeout as `TimeoutError: apiRequestContext.get: Timeout 1500ms exceeded.` and the parser called it an ordinary
//     failure, so a request that timed out was classified as a PRODUCT BUG at 0.85 (act);
//   - a failed `toHaveText` prints `waiting for getByTestId(...)` in its call log even though the element was FOUND ("locator resolved to <button>"),
//     so a genuine wrong-text bug was read as a stale selector and left undetermined.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { normalizePath } = require('../../scripts/results/normalize');
const { classify } = require('../../scripts/triage/classify');
const { analyzeLocator } = require('../../scripts/triage/locators');
const { evidenceText } = require('../../scripts/triage/lib/text');

const REAL = path.join(__dirname, '..', 'fixtures', 'results', 'real');
const load = (file, format) => normalizePath(path.join(REAL, file), { format });
// the same outcome three times: the main run and two re-runs (in the real run the re-runs failed the same way)
const triage = (file, format, extra = {}) => { const r = load(file, format); return classify({ runs: [r, r, r], trustedFormats: [format], ...extra }); };
const byCase = (rep) => Object.fromEntries(rep.verdicts.map((v) => [v.test.name.match(/DEMO-\d+\/TC-\d+/)[0], v]));

// what each failing test in the demo app REALLY is
const SHARED = {
  'DEMO-1/TC-002': ['product-bug', 'the app returns 10 and the test expects 11: a real assertion about the app'],
  'DEMO-1/TC-003': ['environment', 'the service answers 503'],
  'DEMO-1/TC-004': ['undetermined', 'a 401 is as likely the test account as the product'],
  'DEMO-1/TC-005': ['undetermined', 'a 404 page: a wrong URL and a regression look alike'],
  'DEMO-1/TC-006': ['environment', 'nothing is listening on that port'],
  'DEMO-1/TC-007': ['test-bug', 'the test itself crashes (a missing helper)'],
  'DEMO-1/TC-008': ['undetermined', 'it timed out: slow app, wrong wait, or dead server; never a product bug'],
};

for (const [name, file, format, extra] of [
  ['Jest 30.5.2 (jest-json)', 'jest-30.5.2.results.json', 'jest-json', {}],
  ['Playwright 1.65.0 (playwright-json)', 'playwright-1.65.0.results.json', 'playwright-json', { 'DEMO-2/TC-001': ['undetermined', 'a stale selector, but no DOM snapshot was given'], 'DEMO-2/TC-002': ['product-bug', 'the button says "Apply", the test expects "Apply now"'] }],
  ['Playwright 1.65.0 JUnit reporter (junit)', 'playwright-1.65.0.results.junit.xml', 'junit', { 'DEMO-2/TC-001': ['undetermined', 'a stale selector, but no DOM snapshot was given'], 'DEMO-2/TC-002': ['product-bug', 'the button says "Apply", the test expects "Apply now"'] }],
  ['jest-junit 17.0.0 for Jest 30.5.2 (junit)', 'jest-junit-17.0.0.results.xml', 'junit', {}],
]) {
  describe(`real ${name} output`, () => {
    const expected = { ...SHARED, ...extra };
    const rep = triage(file, format);
    const got = byCase(rep);

    test('exactly the failing tests are triaged (the filler tests pass)', () => {
      assert.deepEqual(Object.keys(got).sort(), Object.keys(expected).sort());
    });

    for (const [id, [klass, why]] of Object.entries(expected)) {
      test(`${id} is ${klass}: ${why}`, () => {
        assert.equal(got[id].class, klass, `${id}: ${got[id].rule} ${got[id].confidence} ${got[id].evidence.join(' | ')}`);
      });
    }

    test('the ONLY product bugs are the genuine ones: no timeout, outage, 401, 404 or crashing test is filed as a defect', () => {
      const bugs = Object.entries(got).filter(([, v]) => v.class === 'product-bug').map(([id]) => id).sort();
      assert.deepEqual(bugs, Object.entries(expected).filter(([, [k]]) => k === 'product-bug').map(([id]) => id).sort());
    });
  });
}

describe('real Playwright output: a stale selector is a test-bug once the page is looked at', () => {
  test('with a snapshot of the page, DEMO-2/TC-001 is TST-1 (the rename candidate is coupon-apply)', () => {
    const rep0 = triage('playwright-1.65.0.results.json', 'playwright-json');
    const v0 = byCase(rep0)['DEMO-2/TC-001'];
    const html = '<main><button data-testid="coupon-apply">Apply</button><input data-testid="coupon-input"></main>';
    const r = load('playwright-1.65.0.results.json', 'playwright-json');
    const failing = r.tests.find((t) => /DEMO-2\/TC-001/.test(t.name));
    const evidence = { [v0.key]: { locator: analyzeLocator({ html, selector: evidenceText(failing.error), bare: false }) } };
    const rep = classify({ runs: [r, r, r], trustedFormats: ['playwright-json'], evidence });
    const v = byCase(rep)['DEMO-2/TC-001'];
    assert.equal(v.class, 'test-bug');
    assert.equal(v.rule, 'TST-1');
    assert.match(v.evidence.join(' '), /"coupon-apply-btn".*"coupon-apply"/);
  });
});

describe('real JUnit: what is particular about each producer', () => {
  const jestJunit = load('jest-junit-17.0.0.results.xml', 'junit');
  const pwJunit = load('playwright-1.65.0.results.junit.xml', 'junit');
  const find = (r, id) => r.tests.find((t) => t.name.includes(id));

  test('jest-junit prefixes every name with the describe block ("api DEMO-1/TC-002: …"); the ticket and case id are still found', () => {
    const t = find(jestJunit, 'DEMO-1/TC-002');
    assert.match(t.name, /^api DEMO-1\/TC-002/);
    assert.equal(t.ticket, 'DEMO-1');
    assert.equal(t.caseId, 'TC-002');
  });

  test('jest-junit puts every failure in a bare <failure>, so its timeout is recognised from the text, not from the element', () => {
    assert.equal(find(jestJunit, 'DEMO-1/TC-008').error.kind, 'timeout');
    assert.equal(find(jestJunit, 'DEMO-1/TC-007').error.kind, 'failure');
  });

  test('Playwright separates <failure> (a failed expectation) from <error> (a thrown error, incl. TimeoutError)', () => {
    assert.equal(find(pwJunit, 'DEMO-1/TC-002').error.kind, 'failure');
    assert.equal(find(pwJunit, 'DEMO-1/TC-008').error.kind, 'error');
    assert.equal(find(pwJunit, 'DEMO-2/TC-001').error.kind, 'error');
  });
});

describe('the formats are still capped by default: this evidence does not by itself make them trusted', () => {
  test('...and so is one from real JUnit output', () => {
    const r = load('jest-junit-17.0.0.results.xml', 'junit');
    const v = byCase(classify({ runs: [r, r, r] }))['DEMO-1/TC-002'];
    assert.equal(v.class, 'product-bug');
    assert.equal(v.action, 'propose');
    assert.equal(v.cap, 'unverified-format');
  });

  test('without --trusted-formats, a real Playwright product bug is held at propose', () => {
    const r = load('playwright-1.65.0.results.json', 'playwright-json');
    const v = byCase(classify({ runs: [r, r, r] }))['DEMO-1/TC-002'];
    assert.equal(v.class, 'product-bug');
    assert.equal(v.action, 'propose');
    assert.equal(v.cap, 'unverified-format');
  });
});

describe('the two rules the real output corrected, on the real strings', () => {
  const { isLocatorError } = require('../../scripts/triage/lib/text');
  const pw = load('playwright-1.65.0.results.json', 'playwright-json');
  const text = (id) => evidenceText(pw.tests.find((t) => t.name.includes(id)).error);

  test('a stale selector (the element is NOT there) is a locator error', () => assert.equal(isLocatorError(text('DEMO-2/TC-001')), true));
  test('wrong text on an element that WAS found ("locator resolved to <button>") is not', () => assert.equal(isLocatorError(text('DEMO-2/TC-002')), false));
  test('a strict-mode violation ("resolved to 2 elements") still is one', () => assert.equal(isLocatorError("Error: strict mode violation: getByTestId('x') resolved to 2 elements:\n    1) <button data-testid=\"x\"> aka getByRole('button')"), true));
  test('an action timeout is recorded as a timeout, not a failure', () => assert.equal(pw.tests.find((t) => t.name.includes('DEMO-1/TC-008')).error.kind, 'timeout'));
  test('...and so is the stale-selector click that timed out', () => assert.equal(pw.tests.find((t) => t.name.includes('DEMO-2/TC-001')).error.kind, 'timeout'));
  test('a failed expectation stays a failure (its "Timeout: 2000ms" line is not an action timeout)', () => assert.equal(pw.tests.find((t) => t.name.includes('DEMO-2/TC-002')).error.kind, 'failure'));
});
