'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitize, runPart, isValidRunId } = require('../../scripts/lib/ids');
const plan = require('../../scripts/triage/plan');

// These moved out of the triage planner so the run ledger could use the same rule. Their behaviour is pinned here and, through the planner's
// idempotency keys, in tests/triage/plan.test.js.
describe('run ids', () => {
  test('a short id made of safe characters is used as it is', () => {
    assert.equal(runPart('nightly-2026-11-13'), 'nightly-2026-11-13');
  });

  test('anything else keeps a readable prefix and a hash of the whole id, so ids that fold together stay apart', () => {
    const a = runPart('a/b');
    const b = runPart('a-b');
    assert.notEqual(a, b);
    assert.match(a, /^a-b-[0-9a-f]{12}$/);
    assert.equal(b, 'a-b');
  });

  test('an id that already ends like a hashed one is hashed too, so it cannot share a key with another run\'s hashed form', () => {
    const hashed = runPart('a/b');
    assert.notEqual(runPart(hashed), hashed);
  });

  test('a long id is shortened to at most 37 characters', () => {
    assert.ok(runPart('x'.repeat(500)).length <= 37);
  });

  test('1-128 printable characters are valid; empty, too long and control characters are not', () => {
    assert.equal(isValidRunId('refs/heads/main'), true);
    assert.equal(isValidRunId('x'.repeat(128)), true);
    for (const bad of ['', 'x'.repeat(129), 'a\nb', 'a\u0000b', 5, null, undefined]) assert.equal(isValidRunId(bad), false, JSON.stringify(bad));
  });

  test('the planner still exports the same helpers, and they are these ones', () => {
    assert.equal(plan.sanitize, sanitize);
    assert.equal(plan.isValidRunId, isValidRunId);
  });
});
