'use strict';

const { createApp } = require('../src/api');

// A controllable clock so lockout expiry can be tested without sleeping.
function createClock(start = Date.UTC(2026, 0, 1, 12, 0, 0)) {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

function newApp(clock = createClock()) {
  const app = createApp({ now: clock.now });
  const call = (method, path, body, token) =>
    app.handle({ method, path, body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { app, clock, call };
}

function loginAs(call, email = 'ada@brewandco.test', password = 'espresso123') {
  const res = call('POST', '/api/auth/login', { email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}

// Logs in and fills the cart: items = [[sku, qty], ...]
function shopper(items = []) {
  const ctx = newApp();
  const token = loginAs(ctx.call);
  for (const [sku, qty] of items) {
    const res = ctx.call('POST', '/api/cart/items', { sku, qty }, token);
    if (res.status !== 200) throw new Error(`add ${sku} failed: ${JSON.stringify(res.body)}`);
  }
  return { ...ctx, token };
}

module.exports = { createClock, newApp, loginAs, shopper };
