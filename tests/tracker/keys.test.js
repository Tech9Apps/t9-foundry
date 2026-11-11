'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { hasMarker, hasTag, keyMarker, keyTag } = require('../../scripts/tracker/lib/contract');

describe('hasMarker: an idempotency key is matched as a WHOLE key', () => {
  test('finds the marker at the end of the text, before a newline, and inside surrounding prose', () => {
    assert.equal(hasMarker(`body\n\n${keyMarker('bug-1')}`, 'bug-1'), true);
    assert.equal(hasMarker(`${keyMarker('bug-1')}\nmore text`, 'bug-1'), true);
    assert.equal(hasMarker(`before ${keyMarker('bug-1')} after`, 'bug-1'), true);
    assert.equal(hasMarker(keyMarker('bug-1'), 'bug-1'), true);
  });
  test('a key that is a PREFIX of the stored key is not a match (the bug: bug-1 "found" in bug-10)', () => {
    assert.equal(hasMarker(keyMarker('bug-10'), 'bug-1'), false);
    assert.equal(hasMarker(`x\n${keyMarker('bug-10')}\ny`, 'bug-1'), false);
    assert.equal(hasMarker(keyMarker('run-42-TC-001'), 'run-42-TC-00'), false);
    assert.equal(hasMarker(keyMarker('a.b.c'), 'a.b'), false);
    assert.equal(hasMarker(keyMarker('a_b'), 'a'), false);
    assert.equal(hasMarker(keyMarker('a-b'), 'a'), false);
  });
  test('the longer key still matches itself, and a key that merely ends the other is not a match either', () => {
    assert.equal(hasMarker(keyMarker('bug-10'), 'bug-10'), true);
    assert.equal(hasMarker(keyMarker('xbug-1'), 'bug-1'), false); // the marker text is "qa-harness-key:xbug-1"
  });
  test('regex characters in a key are matched literally', () => {
    assert.equal(hasMarker(keyMarker('a.b'), 'a.b'), true);
    assert.equal(hasMarker(keyMarker('aXb'), 'a.b'), false, '"." must not match any character');
  });
  test('nothing / other text / a different marker prefix', () => {
    for (const t of [undefined, null, '', 'qa-harness-key:other', 'no marker here', 'key:bug-1']) assert.equal(hasMarker(t, 'bug-1'), false, String(t));
  });
  test('an invalid key is still rejected before matching', () => {
    assert.throws(() => hasMarker('x', 'has space'), { code: 'VALIDATION' });
  });
});

describe('hasTag: an exact tag in a "; "-separated list (Azure DevOps)', () => {
  test('matches the exact tag, in any position, case-insensitively', () => {
    assert.equal(hasTag(keyTag('bug-1'), 'bug-1'), true);
    assert.equal(hasTag(`found-by-harness; ${keyTag('bug-1')}; other`, 'bug-1'), true);
    assert.equal(hasTag(keyTag('bug-1').toUpperCase(), 'bug-1'), true);
  });
  test('a tag that merely CONTAINS ours is not a match', () => {
    assert.equal(hasTag(keyTag('bug-10'), 'bug-1'), false);
    assert.equal(hasTag(`a; ${keyTag('bug-10')}`, 'bug-1'), false);
    assert.equal(hasTag(`x${keyTag('bug-1')}`, 'bug-1'), false);
  });
  test('empty / missing tag fields', () => {
    for (const t of [undefined, null, '', ';;']) assert.equal(hasTag(t, 'bug-1'), false, String(t));
  });
});
