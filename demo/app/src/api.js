'use strict';

const { PRODUCTS } = require('./catalog');
const { createAuth } = require('./auth');
const { createCartStore, ApiError } = require('./store');

// All behavior lives behind handle({ method, path, headers, body }) -> { status, body }.
// server.js is a thin HTTP adapter around it, so the API is testable with no network.
function createApp({ now = Date.now } = {}) {
  const auth = createAuth({ now });
  const carts = createCartStore();

  function userFor(headers) {
    const header = (headers && (headers.authorization || headers.Authorization)) || '';
    const email = header.startsWith('Bearer ') ? auth.authenticate(header.slice(7)) : null;
    if (!email) throw new ApiError(401, 'UNAUTHENTICATED', 'Log in first');
    return email;
  }

  function route({ method, path, headers, body }) {
    if (method === 'GET' && path === '/api/health') return { status: 'ok' };
    if (method === 'GET' && path === '/api/products') return PRODUCTS;

    if (method === 'POST' && path === '/api/auth/login') {
      const result = auth.login(body && body.email, body && body.password);
      if (!result.ok) throw new ApiError(result.status, result.code, result.message);
      return { token: result.token, user: result.user };
    }

    if (method === 'GET' && path === '/api/cart') return carts.view(userFor(headers));
    if (method === 'POST' && path === '/api/cart/items') {
      return carts.addItem(userFor(headers), body && body.sku, body && body.qty);
    }
    if (method === 'POST' && path === '/api/cart/coupon') return carts.addCoupon(userFor(headers), body && body.code);
    if (method === 'POST' && path === '/api/checkout') return carts.checkout(userFor(headers));

    throw new ApiError(404, 'NOT_FOUND', `No route for ${method} ${path}`);
  }

  function handle(req) {
    try {
      return { status: 200, body: { data: route(req) } };
    } catch (err) {
      if (err instanceof ApiError) return { status: err.status, body: { error: { code: err.code, message: err.message } } };
      return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } } };
    }
  }

  return { handle };
}

module.exports = { createApp };
