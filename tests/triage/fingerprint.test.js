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
