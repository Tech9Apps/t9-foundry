'use strict';
// DEMO-101 — Apply a discount code at checkout. Each test maps to a manual TC-xxx.

const test = require('node:test');
const assert = require('node:assert/strict');
const { shopper, newApp } = require('../support/helpers');

test('DEMO-101/TC-001: BREW10 takes 10% off the subtotal', () => {
  const { call, token } = shopper([['espresso-beans', 1], ['ceramic-mug', 1]]); // $36.00
  const res = call('POST', '/api/cart/coupon', { code: 'BREW10' }, token);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.totals.discount, 360);
  assert.equal(res.body.data.totals.discounted, 3240);
});

test('DEMO-101/TC-002: WELCOME5 takes a flat $5.00 off', () => {
  const { call, token } = shopper([['espresso-beans', 1]]); // $24.00
  const res = call('POST', '/api/cart/coupon', { code: 'WELCOME5' }, token);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.totals.discount, 500);
  assert.equal(res.body.data.totals.discounted, 1900);
});

test('DEMO-101/TC-003: codes are case-insensitive and ignore surrounding spaces', () => {
  const { call, token } = shopper([['espresso-beans', 1]]);
  const res = call('POST', '/api/cart/coupon', { code: '  brew10 ' }, token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.coupons, ['BREW10']);
});

test('DEMO-101/TC-004: an unknown code is rejected and the order is unchanged', () => {
  const { call, token } = shopper([['espresso-beans', 1]]);
  const res = call('POST', '/api/cart/coupon', { code: 'NOPE' }, token);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'INVALID_COUPON');
  assert.equal(res.body.error.message, 'Invalid discount code');
  assert.equal(call('GET', '/api/cart', undefined, token).body.data.totals.discount, 0);
});

test('DEMO-101/TC-005: applying the same code twice does not stack the discount', () => {
  const { call, token } = shopper([['espresso-beans', 1], ['ceramic-mug', 1]]); // $36.00
  call('POST', '/api/cart/coupon', { code: 'BREW10' }, token);
  const second = call('POST', '/api/cart/coupon', { code: 'BREW10' }, token);
  assert.equal(second.status, 400, 'a second application of the code should be rejected');
  assert.equal(call('GET', '/api/cart', undefined, token).body.data.totals.discount, 360, 'discount must stay at 10%');
});

test('DEMO-101/TC-006: a second, different code is rejected (one code per order)', () => {
  const { call, token } = shopper([['espresso-beans', 1]]);
  call('POST', '/api/cart/coupon', { code: 'BREW10' }, token);
  const res = call('POST', '/api/cart/coupon', { code: 'WELCOME5' }, token);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'COUPON_LIMIT');
});

test('DEMO-101/TC-007: a discount can never push the subtotal below $0.00', () => {
  const { call, token } = shopper([['sample-sachet', 1]]); // $3.00, WELCOME5 is $5.00
  const res = call('POST', '/api/cart/coupon', { code: 'WELCOME5' }, token);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.totals.discount, 300);
  assert.equal(res.body.data.totals.discounted, 0);
});

test('DEMO-101/TC-008: applying a code requires being signed in', () => {
  const { call } = newApp();
  const res = call('POST', '/api/cart/coupon', { code: 'BREW10' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'UNAUTHENTICATED');
});
