'use strict';

// String-level evidence for triage: what an error message says about WHY a test failed. Everything here is a
// pattern over text, so it is only as good as the patterns — they are listed in one place so they can be
// reviewed, extended, and tested against real messages.
const path = require('path');
const { stripAnsi } = require('../../results/lib/shared');

// Volatile tokens are masked so the same defect produces the same signature on every run. Order matters:
// paths and timestamps go before the generic number/duration rules.
const VOLATILE = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>'],
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>'],
  [/(?:[A-Za-z]:)?(?:[\\/][\w.@~+ -]+){2,}[\\/]([\w.-]+\.[A-Za-z0-9]+)(?::\d+){0,2}/g, '$1'], // /abs/path/file.js:3:33 -> file.js
  [/0x[0-9a-f]+/gi, '<addr>'],
  [/\b[0-9a-f]{12,}\b/gi, '<hex>'],
  [/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g, '<dur>'],
  [/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d{2,5}/g, '$1:<port>'],
  [/\b\d{5,}\b/g, '<n>'],
];

function normalizeSignature(message, max = 300) {
  let s = stripAnsi(message || '');
  for (const [re, to] of VOLATILE) s = s.replace(re, to);
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

// Errors that say "the environment is down", not "the app or the test is wrong". A bare "Timeout 30000ms
// exceeded" is deliberately NOT here: it is ambiguous (slow app, wrong wait, dead server).
const INFRA = [
  /\bECONNREFUSED\b/, /\bENOTFOUND\b/, /\bECONNRESET\b/, /\bEAI_AGAIN\b/, /\bEHOSTUNREACH\b/, /\bENETUNREACH\b/,
  /\bgetaddrinfo\b/i, /net::ERR_(?:CONNECTION|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|TIMED_OUT)/,
  /\bBad Gateway\b/i, /\bService Unavailable\b/i, /\bGateway Time-?out\b/i, /\bHTTP (?:status )?(?:502|503|504)\b/i,
  /\b(?:status|code)[: ]+(?:502|503|504)\b/i, /connect ECONN/i, /socket hang up/i,
];
const infraSignal = (message) => { const m = stripAnsi(message || ''); const hit = INFRA.find((re) => re.test(m)); return hit ? hit.source : null; };

// "I could not find the thing on the page", across Playwright, Cypress, Selenium/WebDriver, Capybara and our own
// page helpers. Cypress's wording ("Timed out retrying … Expected to find element") is the one that a plain
// "timeout" check misses.
const LOCATOR = [
  /waiting for (?:getBy\w+|locator|selector)/i, /locator\.\w+: .*(?:timeout|not found)/i, /resolved to 0 elements/i,
  /expected to find (?:element|content)/i, /no such element/i, /unable to locate element/i, /unable to find (?:an? )?(?:element|css|visible)/i,
  /\belement not found\b/i, /\bno element(?:s)? found\b/i, /\blocator not found\b/i, /NoSuchElement/i, /Capybara::ElementNotFound/i,
];
const isLocatorError = (message) => { const m = stripAnsi(message || ''); return LOCATOR.some((re) => re.test(m)); };

// The test-id a locator error is about: getByTestId('x'), [data-testid="x"], data-testid=x, [data-cy=x] …
function extractTestId(message) {
  const m = stripAnsi(message || '');
  const patterns = [
    /getByTestId\(\s*['"`]([^'"`]+)['"`]\s*\)/i,
    /\[\s*data-(?:testid|test-id|test|cy|qa)\s*=\s*['"`]?([^'"`\]\s]+)['"`]?\s*\]/i,
    /data-(?:testid|cy|qa)\s*=\s*['"`]([^'"`]+)['"`]/i,
    /testid[=:]\s*['"`]?([\w-]+)['"`]?/i,
  ];
  for (const re of patterns) { const x = m.match(re); if (x) return x[1]; }
  return null;
}

// Did the test CRASH in its own code (TypeError, bad import …) rather than fail an assertion? Look at the first
// stack frame that names a source file: if it is a test file, the bug is in the test. The runner's own "kind" is NOT
// used: most runners (node:test, Playwright, Jest) report a thrown exception and a failed assertion identically, so
// the wording and the stack location are the evidence.
const CRASH = /\b(?:TypeError|ReferenceError|SyntaxError)\b|Cannot find module|is not a function|is not defined|NameError|AttributeError|NoMethodError|undefined method/;
const ASSERTION = /\bAssertionError\b|expect\(received\)|\bexpected\b.*\b(?:to|but)\b|!==|Failure\/Error: expect/i;
const TEST_PATH = /(?:^|[\\/])(?:tests?|specs?|e2e|__tests__|cypress[\\/]e2e)[\\/]|\.(?:test|spec)\.[cm]?[jt]sx?$|_spec\.rb$|(?:^|[\\/])test_[^\\/]*\.py$|_test\.py$/;
function firstSourceFrame(details) {
  const m = stripAnsi(details || '').match(/(?:\(|\bat\s+|^\s*)((?:[A-Za-z]:)?[\\/]?[\w.@~+ \\/-]*?[\w.-]+\.(?:[cm]?[jt]sx?|py|rb))(?::(\d+))?(?::\d+)?/m);
  return m ? { file: m[1], line: m[2] ? Number(m[2]) : undefined } : null;
}
function testCrash(error) {
  if (!error) return null;
  const head = `${error.message || ''}`;
  if (!CRASH.test(`${head}\n${error.details || ''}`) || ASSERTION.test(head)) return null;
  const frame = firstSourceFrame(error.details);
  return frame && TEST_PATH.test(frame.file) ? frame : null;
}

// The runner itself says "error" (an exception, not a failed assertion) and the first source frame is NOT a test file:
// something in the application threw. Returns the frame, or null when it is not that, or when there is no frame to judge by.
function appCrash(error) {
  if (!error || error.kind !== 'error' || isLocatorError(error.message)) return null;
  const frame = firstSourceFrame(error.details);
  return frame && !TEST_PATH.test(frame.file) && !/node_modules|[\\/]node:|^node:/.test(frame.file) ? frame : null;
}

const baseName = (p) => (p ? path.basename(String(p)) : '');

module.exports = { normalizeSignature, infraSignal, isLocatorError, extractTestId, testCrash, appCrash, firstSourceFrame, baseName, INFRA, LOCATOR };
