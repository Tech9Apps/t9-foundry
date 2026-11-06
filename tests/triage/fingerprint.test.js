'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { fingerprint, identity } = require('../../scripts/triage/fingerprint');
const { normalizeSignature } = require('../../scripts/triage/lib/text');

const t = (name, message, extra = {}) => ({ name, status: 'failed', error: { kind: 'failure', message }, ...extra });
const fp = (test) => fingerprint(test).fingerprint;

describe('fingerprint', () => {
  test('the same defect gets the same fingerprint on every run, whatever is volatile in the message', () => {
    const a = t('DEMO-1/TC-002: totals', 'order 123456789 failed after 1200ms at /Users/ann/proj/test/a.test.js:12:5 on http://localhost:51234 (id 3f2504e0-4f89-41d3-9a0c-0305e82c3301) at 2026-10-08T10:00:00Z', { ticket: 'DEMO-1', caseId: 'TC-002' });
    const b = t('DEMO-1/TC-002: totals', 'order 987654321 failed after 80ms at /home/ci/work/test/a.test.js:99:1 on http://localhost:40001 (id 11111111-2222-3333-4444-555555555555) at 2027-01-01T01:02:03Z', { ticket: 'DEMO-1', caseId: 'TC-002' });
    assert.equal(fp(a), fp(b));
  });

  test('a different error is a different defect', () => {
    assert.notEqual(fp(t('x', 'expected 1 got 2')), fp(t('x', 'expected 1 got 3')));
  });

  test('a different test is a different defect, even with the same message', () => {
    assert.notEqual(fp(t('first check', 'boom', { file: 'a.test.js' })), fp(t('second check', 'boom', { file: 'a.test.js' })));
  });

  test('the error KIND is part of it: an assertion and a crash with the same words are not the same bug', () => {
    const crash = { ...t('x', 'boom'), error: { kind: 'error', message: 'boom' } };
    assert.notEqual(fp(t('x', 'boom')), fp(crash));
  });

  test('ticket/caseId identity survives a rename, a reword and a file move; without ids it does not', () => {
    const before = t('DEMO-1/TC-002: totals', 'boom', { ticket: 'DEMO-1', caseId: 'TC-002', file: 'old/a.test.js' });
    const after = t('DEMO-1/TC-002: totals are summed (reworded)', 'boom', { ticket: 'DEMO-1', caseId: 'TC-002', file: 'new/b.test.js' });
    assert.equal(fp(before), fp(after));
    assert.notEqual(fp(t('totals', 'boom', { file: 'a.test.js' })), fp(t('totals renamed', 'boom', { file: 'a.test.js' })));
  });

  test('without a ticket, the case id is scoped to its file (TC-001 in two files are different tests)', () => {
    assert.notEqual(identity({ caseId: 'TC-001', file: '/x/a.test.js', name: 'a' }), identity({ caseId: 'TC-001', file: '/x/b.test.js', name: 'b' }));
    assert.equal(identity({ caseId: 'TC-001', file: '/x/a.test.js', name: 'a' }), identity({ caseId: 'TC-001', file: '/y/a.test.js', name: 'a' })); // directory does not matter
  });

  test('the title is compared case- and whitespace-insensitively', () => {
    assert.equal(identity({ name: 'Totals   Add Up', file: 'a.js' }), identity({ name: 'totals add up', file: 'a.js' }));
  });

  test('the tracker token is ONE alphanumeric word (tracker search splits on hyphens) of qafp + 12 hex', () => {
    const f = fingerprint(t('x', 'boom'));
    assert.match(f.token, /^qafp[0-9a-f]{12}$/);
    assert.equal(f.token, `qafp${f.fingerprint}`);
    assert.doesNotMatch(f.token, /[^A-Za-z0-9]/);
  });

  test('it is stable: a pinned value (computed independently: sha1 of "DEMO-101/TC-005|failure|<message>"), so an accidental change to the algorithm is noticed (a change re-files every open bug)', () => {
    assert.equal(fp({ name: 'DEMO-101/TC-005: x', ticket: 'DEMO-101', caseId: 'TC-005', status: 'failed', error: { kind: 'failure', message: 'a second application of the code should be rejected' } }), 'bcbd1e8fb61e');
  });
});

describe('normalizeSignature', () => {
  test('masks each kind of volatile token', () => {
    const cases = [
      ['\u001b[31mred\u001b[39m text', 'red text'],
      ['id 3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'id <uuid>'],
      ['at 2026-10-08T10:00:00.123Z', 'at <ts>'],
      ['in /Users/ann/proj/test/a.test.js:12:5', 'in a.test.js'],
      ['C:\\work\\proj\\test\\a.test.js:3', 'a.test.js'],
      ['ptr 0xdeadbeef', 'ptr <addr>'],
      ['sha 0123456789abcdef0123', 'sha <hex>'],
      ['took 1200ms then 3.5s', 'took <dur> then <dur>'],
      ['http://localhost:51234/x', 'http://localhost:<port>/x'],
      ['order 99887766', 'order <n>'],
    ];
    for (const [input, expected] of cases) assert.equal(normalizeSignature(input), expected, input);
  });

  test('short numbers and words are kept: "200 !== 400" is the defect, not noise', () => {
    assert.equal(normalizeSignature('expected 200 !== 400'), 'expected 200 !== 400');
  });

  test('whitespace is collapsed and the length capped', () => {
    assert.equal(normalizeSignature('a \n\n  b\t c'), 'a b c');
    assert.equal(normalizeSignature('x'.repeat(1000)).length, 300);
    assert.equal(normalizeSignature(undefined), '');
  });
});

// Reporters put a one-line summary in `message` and the diagnosis in `details`. A fingerprint built from the summary alone gave two
// different defects the same id, so the second was reported as "already filed" and never seen (found by review of PR #9).
describe('fingerprint: what was expected and received is part of the defect', () => {
  const JEST_SUMMARY = 'expect(received).toBe(expected) // Object.is equality';
  const withDetails = (name, details, message = JEST_SUMMARY) => ({ name, file: 'cart.test.js', status: 'failed', error: { kind: 'failure', message, details } });
  const frames = '    at Object.<anonymous> (/repo/test/cart.test.js:12:20)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)';

  test('Expected 10 / Received 12 and Expected "EUR" / Received "USD" are different defects (they used to collide)', () => {
    const a = withDetails('cart total', `${JEST_SUMMARY}\n\nExpected: 10\nReceived: 12\n\n${frames}`);
    const b = withDetails('cart total', `${JEST_SUMMARY}\n\nExpected: "EUR"\nReceived: "USD"\n\n${frames}`);
    assert.notEqual(fp(a), fp(b));
  });

  test('only what was RECEIVED differs (same expected): still a different defect', () => {
    const a = withDetails('status', `${JEST_SUMMARY}\n\nExpected: 200\nReceived: 500\n\n${frames}`);
    const b = withDetails('status', `${JEST_SUMMARY}\n\nExpected: 200\nReceived: 418\n\n${frames}`);
    assert.notEqual(fp(a), fp(b));
  });

  test('only what was EXPECTED differs (same received): still a different defect', () => {
    const a = withDetails('status', `${JEST_SUMMARY}\n\nExpected: 200\nReceived: 404\n\n${frames}`);
    const b = withDetails('status', `${JEST_SUMMARY}\n\nExpected: 201\nReceived: 404\n\n${frames}`);
    assert.notEqual(fp(a), fp(b));
  });

  test('the same expected/received is the same defect even when the stack, colours and timings differ between runs', () => {
    // colour codes wrap the LABELS in real output, which would hide the line from a matcher that did not strip them first
    const a = withDetails('cart total', `\u001b[2m${JEST_SUMMARY}\u001b[22m\n\n\u001b[32mExpected\u001b[39m: 10\n\u001b[31mReceived\u001b[39m: 12\n\n${frames}`);
    const b = withDetails('cart total', `${JEST_SUMMARY}\n\nExpected: 10\nReceived: 12\n\n    at Object.<anonymous> (/home/ci/w/test/cart.test.js:99:1)`);
    assert.equal(fp(a), fp(b));
  });

  test('the Playwright call log is NOT part of the fingerprint: it repeats a different number of times every run', () => {
    const head = 'expect(locator).toHaveText(expected)\n\nLocator: getByTestId(\'currency\')\nExpected: "EUR"\nReceived: "USD"\nCall log:\n';
    const short = withDetails('currency', `${head}  - waiting for getByTestId('currency')\n    9 × locator resolved to <span>USD</span>\n      - unexpected value "USD"`, 'expect(locator).toHaveText(expected)');
    const long = withDetails('currency', `${head}  - waiting for getByTestId('currency')\n    41 × locator resolved to <span>USD</span>\n      - unexpected value "USD"\n      - unexpected value "USD"`, 'expect(locator).toHaveText(expected)');
    assert.equal(fp(short), fp(long));
  });

  test('a different locator is a different defect', () => {
    const a = withDetails('x', 'expect(locator).toBeVisible()\n\nLocator: getByTestId(\'a\')\nExpected: visible\nReceived: hidden', 'expect(locator).toBeVisible()');
    const b = withDetails('x', 'expect(locator).toBeVisible()\n\nLocator: getByTestId(\'b\')\nExpected: visible\nReceived: hidden', 'expect(locator).toBeVisible()');
    assert.notEqual(fp(a), fp(b));
  });

  test('details without any expected/received lines change nothing (a bare stack is not part of the identity)', () => {
    const bare = { name: 'x', file: 'a.test.js', status: 'failed', error: { kind: 'failure', message: 'boom' } };
    const stacked = { ...bare, error: { ...bare.error, details: 'Error: boom\n    at /repo/a.test.js:1:1' } };
    assert.equal(fp(bare), fp(stacked));
  });

  test('a diagnostic line the message already contains is not counted twice', () => {
    const msg = 'expected values differ\nExpected: 1\nReceived: 2';
    const a = { name: 'x', file: 'a.test.js', status: 'failed', error: { kind: 'failure', message: msg } };
    const b = { ...a, error: { ...a.error, details: 'Expected: 1\nReceived: 2' } };
    assert.equal(fingerprint(a).signature, fingerprint(b).signature);
  });
});
