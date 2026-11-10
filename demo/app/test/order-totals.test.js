'use strict';
// DEMO-102 — Order total, tax and shipping. Each test maps to a manual TC-xxx.

const test = require('node:test');
const assert = require('node:assert/strict');
const { shopper } = require('../support/helpers');

test('DEMO-102/TC-001: total = subtotal + shipping + tax (no discount)', () => {
  const { call, token } = shopper([['espresso-beans', 1], ['ceramic-mug', 1]]); // $36.00
  const t = call('GET', '/api/cart', undefined, token).body.data.totals;
  assert.deepEqual(
    { subtotal: t.subtotal, shipping: t.shipping, tax: t.tax, total: t.total },
    { subtotal: 3600, shipping: 500, tax: 288, total: 4388 },
  );
});

test('DEMO-102/TC-002: tax is 8% of the discounted subtotal, rounded to the nearest cent', () => {
  const { call, token } = shopper([['cold-brew-kit', 1], ['ceramic-mug', 1]]); // $51.50
  const t = call('POST', '/api/cart/coupon', { code: 'BREW10' }, token).body.data.totals;
  assert.equal(t.discounted, 4635); // 5150 - 515
  assert.equal(t.tax, 371); // 370.8 rounds up
});

test('DEMO-102/TC-003: shipping is a flat $5.00 below the free-shipping threshold', () => {
  const { call, token } = shopper([['pour-over-kit', 1]]); // $25.00
  assert.equal(call('GET', '/api/cart', undefined, token).body.data.totals.shipping, 500);
});

test('DEMO-102/TC-004: shipping is free at exactly $50.00', () => {
  const { call, token } = shopper([['pour-over-kit', 2]]); // $50.00
  assert.equal(call('GET', '/api/cart', undefined, token).body.data.totals.shipping, 0);
});

test('DEMO-102/TC-005: shipping is free well above the threshold', () => {
  const { call, token } = shopper([['grinder', 1]]); // $89.00
  assert.equal(call('GET', '/api/cart', undefined, token).body.data.totals.shipping, 0);
});

test('DEMO-102/TC-006: free shipping is judged on the discounted subtotal', () => {
  const { call, token } = shopper([['cold-brew-kit', 1], ['ceramic-mug', 1]]); // $51.50 before discount
  const t = call('POST', '/api/cart/coupon', { code: 'WELCOME5' }, token).body.data.totals;
  assert.equal(t.discounted, 4650); // below $50.00 after the discount
  assert.equal(t.shipping, 500, 'a cart that falls under $50.00 after the discount must pay shipping');
});

test('DEMO-102/TC-007: checking out an empty cart is rejected', () => {
  const { call, token } = shopper();
  const res = call('POST', '/api/checkout', undefined, token);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'EMPTY_CART');
});

test('DEMO-102/TC-008: checkout returns an order matching the cart totals and empties the cart', () => {
  const { call, token } = shopper([['espresso-beans', 1], ['ceramic-mug', 1]]);
  const before = call('GET', '/api/cart', undefined, token).body.data.totals;
  const order = call('POST', '/api/checkout', undefined, token);
  assert.equal(order.status, 200);
  assert.match(order.body.data.id, /^ORD-\d+$/);
  assert.deepEqual(order.body.data.totals, before);
  assert.equal(call('GET', '/api/cart', undefined, token).body.data.items.length, 0);
});
