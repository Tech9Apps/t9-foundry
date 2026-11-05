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

// What a failure SAYS. Reporters put the one-line summary in `message` and the diagnosis in `details`: Playwright's
// "Received: <element(s) not found>", the status a request got back, the locator it was waiting for. Classifying on the
// message alone mistakes a stale selector, an expired session or a 503 for a failed assertion about the app, so every
// signal below reads both. (Capped: details can be a whole stack trace.)
const MAX_EVIDENCE = 4000;
function evidenceText(error) {
  if (!error) return '';
  return stripAnsi(`${error.message || ''}\n${error.details || ''}`).slice(0, MAX_EVIDENCE);
}

// The lines of a failure's details that tell one defect from another — what was expected, what was received, which
// locator — and nothing volatile. The call log ("- locator resolved to …", repeated a different number of times on
// every run) and the stack are deliberately NOT included: a fingerprint that changes between runs files the same bug again.
const DIAGNOSTIC_LINE = /^\s*(?:Expected|Received|Actual|Locator)\b[^\n]*$/i;
function diagnosticLines(details, { lines = 4 } = {}) {
  return stripAnsi(details || '').split('\n').filter((l) => DIAGNOSTIC_LINE.test(l)).slice(0, lines).map((l) => l.trim());
}
const diagnosticHead = (details, opts) => diagnosticLines(details, opts).join(' ');

// The fingerprint's signature: the message plus the diagnostic head, volatile parts masked. Two failures that differ only in
// WHAT was expected or received ("Expected: 10 / Received: 12" vs "Expected: "EUR" / Received: "USD"") are different defects.
function signatureOf(error, max = 500) {
  const e = error || {};
  const message = stripAnsi(e.message || '');
  // a diagnostic line the message already contains adds nothing — and must not, or the same defect would hash differently
  // depending on whether a reporter repeated those lines in `details`
  const extra = diagnosticLines(e.details).filter((l) => !message.includes(l));
  return normalizeSignature(extra.length ? `${message} ${extra.join(' ')}` : message, max);
}

// Errors that say "the environment is down", not "the app or the test is wrong". A bare "Timeout 30000ms
// exceeded" is deliberately NOT here: it is ambiguous (slow app, wrong wait, dead server).
const INFRA = [
  /\bECONNREFUSED\b/, /\bENOTFOUND\b/, /\bECONNRESET\b/, /\bEAI_AGAIN\b/, /\bEHOSTUNREACH\b/, /\bENETUNREACH\b/,
  /\bgetaddrinfo\b/i, /\bERR_(?:CONNECTION|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|TIMED_OUT|CERT|SSL|BAD_SSL|EMPTY_RESPONSE|TUNNEL|PROXY|NETWORK)/,
  /\bBad Gateway\b/i, /\bService Unavailable\b/i, /\bGateway Time-?out\b/i, /\bHTTP (?:status )?(?:502|503|504)\b/i,
  /\b(?:status|code)[: ]+(?:502|503|504)\b/i, /connect ECONN/i, /socket hang up/i,
  // a status assertion that RECEIVED a gateway error ("Expected: 200  Received: 503")
  /\bReceived\b[^\n]{0,30}\b(?:502|503|504)\b/i,
  // TLS problems with the test environment's certificate (Node and Chromium wording)
  /\b(?:UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)\b/, /\bself[- ]signed certificate\b/i,
  /\bcertificate (?:has expired|is not yet valid|verify failed)\b/i,
];
const infraSignal = (message) => { const m = stripAnsi(message || ''); const hit = INFRA.find((re) => re.test(m)); return hit ? hit.source : null; };

// "Is this an authentication / session problem?" An expired test account, a login page where the app should be, a 401 where
// a 200 was expected: these look like an app that returns the wrong thing but are as often the test's credentials. They are
// never evidence of a product bug on their own, so they never reach a bug report without a human.
const AUTH = [
  /\bReceived\b[^\n]{0,30}\b(?:401|403)\b/i,
  /\bReceived\b[^\n]*\/(?:log-?in|sign-?in|signin|auth|sso|session-expired)\b/i, // toHaveURL: bounced to a login page
  /\b(?:status|code)[: ]+(?:401|403)\b/i, /\bHTTP (?:status )?(?:401|403)\b/i,
  /\bsession (?:has )?(?:expired|timed out)\b/i, /\b(?:token|credentials?) (?:has )?expired\b/i, /\bunauthori[sz]ed\b/i,
];
const authSignal = (message) => { const m = stripAnsi(message || ''); const hit = AUTH.find((re) => re.test(m)); return hit ? hit.source : null; };

// The page or API answered with an error page (404 / 500 / "Something went wrong"). A wrong base URL, a dead route and a
// real regression all look like this from the test alone.
const ERROR_PAGE = [/\bReceived\b[^\n]{0,60}(?:\b(?:404|500)\b|Not Found|Internal Server Error|Application Error|Something went wrong)/i];
const errorPageSignal = (message) => { const m = stripAnsi(message || ''); const hit = ERROR_PAGE.find((re) => re.test(m)); return hit ? hit.source : null; };

// "I could not find the thing on the page", across Playwright, Cypress, Selenium/WebDriver, Capybara and our own
// page helpers. Cypress's wording ("Timed out retrying … Expected to find element") is the one that a plain
// "timeout" check misses.
const LOCATOR = [
  /waiting for (?:getBy\w+|locator|selector)/i, /locator\.\w+: .*(?:timeout|not found)/i, /resolved to 0 elements/i,
  /<element\(s\) not found>/i, /strict mode violation/i, /resolved to [2-9]\d* elements/i,
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

const baseName = (p) => (p ? path.basename(String(p)) : '');

module.exports = { normalizeSignature, evidenceText, diagnosticHead, diagnosticLines, signatureOf, infraSignal, authSignal, errorPageSignal, isLocatorError, extractTestId, testCrash, firstSourceFrame, baseName, INFRA, AUTH, ERROR_PAGE, LOCATOR };
