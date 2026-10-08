'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { infraSignal, isLocatorError, extractTestId, testCrash, firstSourceFrame } = require('../../scripts/triage/lib/text');

describe('infraSignal', () => {
  test('recognises connection and gateway failures', () => {
    for (const m of ['connect ECONNREFUSED 127.0.0.1:3000', 'getaddrinfo ENOTFOUND host', 'read ECONNRESET', 'EAI_AGAIN dns', 'net::ERR_NAME_NOT_RESOLVED', 'HTTP 503', 'status: 502', '504 Gateway Timeout', 'Bad Gateway', 'Service Unavailable', 'socket hang up', 'getaddrinfo failed']) {
      assert.ok(infraSignal(m), m);
    }
  });
  test('does NOT treat ambiguous or product-level messages as infrastructure', () => {
    for (const m of ['Timeout 30000ms exceeded.', 'expected 200 !== 400', 'Timed out retrying after 4000ms', 'Cannot read properties of undefined', 'status 500 returned', 'expected 5030 items', '']) {
      assert.equal(infraSignal(m), null, m);
    }
  });
  test('ANSI colour codes do not hide a signal', () => {
    assert.ok(infraSignal('\u001b[31mECONNREFUSED\u001b[39m'));
  });
});

describe('isLocatorError', () => {
  test('recognises "element not found" across Playwright, Cypress, Selenium, Capybara', () => {
    for (const m of ["locator.click: Timeout 30000ms exceeded.\n - waiting for getByTestId('x')", 'Timed out retrying after 4000ms: Expected to find element: `.x`, but never found it.', 'no such element: Unable to locate element: {"method":"css selector"}', 'Unable to find css "#x"', 'Capybara::ElementNotFound: Unable to find', 'NoSuchElementException', 'locator resolved to 0 elements']) {
      assert.ok(isLocatorError(m), m);
    }
  });
  test('does not call an assertion or a plain timeout a locator error', () => {
    for (const m of ['expected 200 !== 400', 'Timeout 30000ms exceeded.', 'connect ECONNREFUSED']) assert.equal(isLocatorError(m), false, m);
  });
});

describe('extractTestId', () => {
  test('pulls the test-id out of the common selector spellings', () => {
    const cases = [["getByTestId('add-to-cart')", 'add-to-cart'], ['getByTestId("x_y")', 'x_y'], ['[data-testid=add-btn]', 'add-btn'], ['[data-testid="add btn"]', 'add btn'], ["[data-cy='save']", 'save'], ['`[data-test-id=go]`', 'go'], ['data-testid="plain"', 'plain']];
    for (const [input, expected] of cases) assert.equal(extractTestId(input), expected, input);
    assert.equal(extractTestId('.some-class > a'), null);
  });
});

describe('testCrash', () => {
  const crash = (message, details, kind = 'error') => testCrash({ kind, message, details });
  test('a crash whose first source frame is a test file is the test\'s fault', () => {
    for (const file of ['/work/e2e/checkout.spec.ts', '/work/tests/a.js', '/w/src/foo.test.js', '/w/spec/cart_spec.rb', '/w/tests/test_cart.py', '/w/cart_test.py', '/w/cypress/e2e/a.cy.js']) {
      const f = crash('TypeError: x is not a function', `at run (${file}:10:5)`);
      assert.ok(f, file);
    }
  });
  test('…and a crash inside application code is not', () => {
    assert.equal(crash('TypeError: x', 'at totals (/work/demo/app/src/pricing.js:30:11)'), null);
  });
  test('assertion failures are never crashes, and non-crash errors are not either', () => {
    assert.equal(crash('TypeError: x', 'at (/w/tests/a.js:1:1)', 'failure'), null);
    assert.equal(crash('something odd happened', 'at (/w/tests/a.js:1:1)'), null);
    assert.equal(testCrash(undefined), null);
  });
  test('reports the file and line', () => {
    assert.deepEqual(crash('ReferenceError: nope is not defined', 'at X (/w/tests/a.test.js:7:3)'), { file: '/w/tests/a.test.js', line: 7 });
  });
});

describe('firstSourceFrame', () => {
  test('finds the first frame that names a source file, skipping node internals', () => {
    assert.deepEqual(firstSourceFrame('Test.run (node:internal/test_runner/test:1047:25)\n at x (/w/a.js:3:4)'), { file: '/w/a.js', line: 3 });
    assert.equal(firstSourceFrame('no frames here'), null);
  });
});
