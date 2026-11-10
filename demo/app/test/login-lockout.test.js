'use strict';
// DEMO-103 — Login with account lockout. Each test maps to a manual TC-xxx.

const test = require('node:test');
const assert = require('node:assert/strict');
const { newApp } = require('../support/helpers');

const ADA = 'ada@brewandco.test';
const fail = (call, email = ADA) => call('POST', '/api/auth/login', { email, password: 'wrong' });

test('DEMO-103/TC-001: valid credentials return a session token', () => {
  const { call } = newApp();
  const res = call('POST', '/api/auth/login', { email: ADA, password: 'espresso123' });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.token);
  assert.equal(res.body.data.user.email, ADA);
});

test('DEMO-103/TC-002: a wrong password shows the generic error', () => {
  const { call } = newApp();
  const res = fail(call);
  assert.equal(res.status, 401);
  assert.equal(res.body.error.message, 'Invalid email or password');
});

test('DEMO-103/TC-003: an unknown email gets the same error (no account enumeration)', () => {
  const { call } = newApp();
  const unknown = fail(call, 'nobody@brewandco.test');
  const wrongPassword = fail(call);
  assert.equal(unknown.status, wrongPassword.status);
  assert.deepEqual(unknown.body, wrongPassword.body);
});

test('DEMO-103/TC-004: after 5 failed attempts the account is locked, even for the right password', () => {
  const { call } = newApp();
  for (let i = 0; i < 5; i += 1) assert.equal(fail(call).status, 401);
  const res = call('POST', '/api/auth/login', { email: ADA, password: 'espresso123' });
  assert.equal(res.status, 423);
  assert.equal(res.body.error.code, 'ACCOUNT_LOCKED');
});

test('DEMO-103/TC-005: the lock lifts after 15 minutes', () => {
  const { call, clock } = newApp();
  for (let i = 0; i < 5; i += 1) fail(call);
  clock.advance(14 * 60 * 1000);
  assert.equal(call('POST', '/api/auth/login', { email: ADA, password: 'espresso123' }).status, 423);
  clock.advance(60 * 1000 + 1);
  assert.equal(call('POST', '/api/auth/login', { email: ADA, password: 'espresso123' }).status, 200);
});

test('DEMO-103/TC-006: a successful login resets the failed-attempt counter', () => {
  const { call } = newApp();
  for (let i = 0; i < 4; i += 1) fail(call);
  assert.equal(call('POST', '/api/auth/login', { email: ADA, password: 'espresso123' }).status, 200);
  for (let i = 0; i < 4; i += 1) assert.equal(fail(call).status, 401);
  assert.equal(call('POST', '/api/auth/login', { email: ADA, password: 'espresso123' }).status, 200, 'not locked: only 4 failures since the reset');
});
