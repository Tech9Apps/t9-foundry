// A tiny app with deliberate behaviour, so the right classification of every failing test is known in advance.
const http = require('http');
const port = Number(process.env.PORT || 4567);
const page = '<!doctype html><title>Cart</title><main><button data-testid="coupon-apply">Apply</button><input data-testid="coupon-input" placeholder="code"></main>';
http.createServer((req, res) => {
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/health') return json(200, { status: 'ok' });
  if (req.url === '/api/total') return json(200, { total: 10 }); // the app computes 10; a test expects 11: a REAL product bug
  if (req.url === '/api/unavailable') return json(503, { error: 'Service Unavailable' });
  if (req.url === '/api/secure') return json(401, { error: 'unauthorized' });
  if (req.url === '/api/missing') return json(404, { error: 'Not Found' });
  if (req.url === '/api/slow') return setTimeout(() => json(200, { ok: true }), 4000);
  if (req.url === '/cart') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page); }
  return json(404, { error: 'Not Found' });
}).listen(port, '127.0.0.1', () => console.log('listening on ' + port));
