'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { createApp } = require('./api');

const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');

// Thin adapter: HTTP in, handle() out. Exported so tests can drive it without a socket.
function createRequestListener(app = createApp()) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(INDEX_HTML));
      return;
    }

    let body;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Body must be valid JSON' } }));
        return;
      }
    }

    const result = app.handle({ method: req.method, path: url.pathname, headers: req.headers, body });
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  };
}

function createServer(app) {
  return http.createServer(createRequestListener(app));
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4173;
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Brew & Co demo app listening on http://localhost:${port}`);
    console.log('Demo users: ada@brewandco.test / espresso123   ben@brewandco.test / pourover456');
  });
}

module.exports = { createServer, createRequestListener };
