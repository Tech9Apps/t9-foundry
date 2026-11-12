'use strict';
// scripts/lib/regex.js: turning text into a pattern that matches exactly that text. Used where a key (contract.js hasMarker) or a test id
// (heal-core.js) is searched for inside other text, so a character left unescaped is a wrong match, not just an ugly one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeRe } = require('../../scripts/lib/regex');

test('every character that means something in a pattern is escaped', () => {
  assert.equal(escapeRe('.*+?^${}()|[]\\'), '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
});

test('plain text, hyphens and slashes are left as they are', () => {
  assert.equal(escapeRe('coupon-apply/btn_1 é'), 'coupon-apply/btn_1 é');
});

test('the result matches the original text exactly, and nothing it merely resembles', () => {
  for (const text of ['a.b', 'a+b', '(x)', '[id]', 'a|b', '^start$', 'back\\slash', '{1,2}', 'what?', 'a*']) {
    const re = new RegExp(`^${escapeRe(text)}$`);
    assert.ok(re.test(text), text);
  }
  assert.equal(new RegExp(`^${escapeRe('a.b')}$`).test('aXb'), false, 'a dot is a dot');
  assert.equal(new RegExp(`^${escapeRe('a|b')}$`).test('a'), false, 'a bar is a bar');
  assert.equal(new RegExp(`^${escapeRe('a*')}$`).test('aaa'), false, 'a star is a star');
});

test('a number or other non-string is read as its text', () => {
  assert.equal(escapeRe(1.5), '1\\.5');
  assert.equal(escapeRe(null), 'null');
});
