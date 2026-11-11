'use strict';
// Shared machinery for the in-process tracker mocks. A mock is a `fetch` replacement:
// adapters are handed `mock.fetch`, so tests need no sockets (and no ports).
//
//   mock.fetch(url, init)   drop-in for global fetch
//   mock.calls              every request seen: { method, path, query, headers, body }
//   mock.inject(rule)       make the next matching request(s) misbehave:
//       { method?, match?, times = 1,
//         status, body?            respond with this HTTP status instead
//         networkError: true       reject like a dropped connection
//         delayMs                  stall (honours the caller's timeout / AbortSignal)
//         afterCommit: true        run the real handler FIRST, then fail — i.e. the write
//                                  happened but the response was lost (the duplicate-ticket trap) }
//   mock.state              the mock tracker's data, for assertions

function createCore({ checkAuth }) {
  const calls = [];
  const rules = [];
  const routes = [];

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });

  const respond = (status, body) => new Response(status === 204 || body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

  // "/repos/:owner/:repo/issues/:number" -> regex with named groups
  function route(method, pattern, handler) {
    const source = pattern.replace(/:([A-Za-z_]+)/g, '(?<$1>[^/]+)');
    routes.push({ method, regex: new RegExp(`^${source}$`), handler });
  }

  function inject(rule) {
    rules.push({ times: 1, ...rule });
  }

  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    let body;
    if (init.body) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { method, path: decodeURIComponent(u.pathname), search: u.search, query: Object.fromEntries(u.searchParams), headers, body };
    calls.push(call);

    const target = `${call.path}${u.search}`;
    const rule = rules.find((r) => r.times > 0 && (!r.method || r.method === method) && (!r.match || new RegExp(r.match).test(target)));
    if (rule) {
      rule.times -= 1;
      if (rule.delayMs) await sleep(rule.delayMs, init.signal);
    }

    const fail = rule && (rule.status || rule.networkError);
    if (fail && !rule.afterCommit) {
      if (rule.networkError) throw new TypeError('fetch failed');
      return respond(rule.status, rule.body === undefined ? { message: 'injected failure' } : rule.body);
    }

    let response;
    if (!checkAuth(headers)) {
      response = respond(401, { message: 'Bad credentials' });
    } else {
      const hit = routes.find((r) => r.method === method && r.regex.test(call.path));
      if (!hit) {
        response = respond(404, { message: `Not Found: ${method} ${call.path}` });
      } else {
        const params = call.path.match(hit.regex).groups || {};
        try {
          const [status, payload] = hit.handler({ params, query: call.query, body, call });
          response = respond(status, payload);
        } catch (err) {
          if (err && err.mockStatus) response = respond(err.mockStatus, err.mockBody || { message: err.message });
          else throw err;
        }
      }
    }

    if (fail && rule.afterCommit) {
      if (rule.networkError) throw new TypeError('fetch failed');
      return respond(rule.status, rule.body === undefined ? { message: 'injected failure after commit' } : rule.body);
    }
    return response;
  }

  const httpError = (status, message, body) => Object.assign(new Error(message), { mockStatus: status, mockBody: body });

  return { fetch, route, inject, calls, httpError };
}

module.exports = { createCore };
