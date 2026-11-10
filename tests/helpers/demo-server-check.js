// Drives the demo app's HTTP adapter with mock request/response objects (no socket —
// binding a port is not possible in every environment, and is not needed to test routing).
// Prints "OK" on success; prints each failed expectation and exits 1 otherwise.
'use strict';
const path = require('path');
const { Readable } = require('stream');
const { createRequestListener } = require(path.join(__dirname, '..', '..', 'demo', 'app', 'src', 'server.js'));

const failures = [];
const expect = (name, cond) => { if (!cond) failures.push(name); };

function request(listener, method, url, body, headers = {}) {
  return new Promise((resolve) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.method = method;
    req.url = url;
    req.headers = headers;
    const res = {
      status: 0,
      headers: {},
      writeHead(status, h) { this.status = status; this.headers = h; },
      end(chunk) { resolve({ status: this.status, headers: this.headers, text: chunk ? chunk.toString() : '' }); },
    };
    listener(req, res);
  });
}

(async () => {
  const listener = createRequestListener();

  let r = await request(listener, 'GET', '/');
  expect('GET / serves the HTML page', r.status === 200 && /text\/html/.test(r.headers['Content-Type']) && r.text.includes('Brew &amp; Co'));

  r = await request(listener, 'GET', '/api/products');
  expect('GET /api/products lists the catalog', r.status === 200 && JSON.parse(r.text).data.length === 6);

  r = await request(listener, 'POST', '/api/auth/login', { email: 'ada@brewandco.test', password: 'espresso123' });
  const token = r.status === 200 ? JSON.parse(r.text).data.token : null;
  expect('POST /api/auth/login returns a token', Boolean(token));

  r = await request(listener, 'GET', '/api/cart', undefined, { authorization: `Bearer ${token}` });
  expect('GET /api/cart works with the token', r.status === 200 && JSON.parse(r.text).data.items.length === 0);

  r = await request(listener, 'GET', '/api/cart');
  expect('GET /api/cart without a token is 401', r.status === 401);

  r = await request(listener, 'POST', '/api/auth/login', '{not json');
  expect('invalid JSON is a 400 with the error envelope', r.status === 400 && JSON.parse(r.text).error.code === 'VALIDATION_ERROR');

  r = await request(listener, 'GET', '/api/nope');
  expect('unknown route is a 404', r.status === 404 && JSON.parse(r.text).error.code === 'NOT_FOUND');

  if (failures.length) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
  console.log('OK');
})();
