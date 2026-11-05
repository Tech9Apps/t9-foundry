'use strict';

const { TrackerError, fromStatus } = require('./errors');

// Error messages quote an excerpt of the response body, and a body can echo the request (proxies and debug pages do). So every secret this
// request carried is removed from the text first: the whole header value, the part after the scheme, and — for Basic auth — the decoded
// credentials and the password.
const SECRET_HEADER = /^(authorization|private-token|x-api-key|x-auth-token)$/i;
function secretsFrom(headers) {
  const out = new Set();
  for (const [name, raw] of Object.entries(headers || {})) {
    if (!SECRET_HEADER.test(name) || !raw) continue;
    const value = String(raw);
    out.add(value);
    const m = /^(?:Bearer|Basic|Token)\s+(.+)$/i.exec(value);
    if (!m) continue;
    out.add(m[1]);
    if (/^Basic/i.test(value)) {
      try {
        const decoded = Buffer.from(m[1], 'base64').toString('utf8');
        out.add(decoded);
        const colon = decoded.indexOf(':');
        if (colon >= 0 && decoded.slice(colon + 1)) out.add(decoded.slice(colon + 1));
      } catch { /* not base64: nothing more to add */ }
    }
  }
  return [...out].filter((s) => s.length >= 6);
}
const redact = (text, secrets) => secrets.reduce((t, s) => t.split(s).join('[redacted]'), String(text || ''));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One HTTP call with a hard timeout and normalized errors.
//
// Retry policy (deliberate): reads are retried on retriable failures with exponential backoff.
// A read is a GET, or a call the adapter marks `idempotent: true` (e.g. Azure's WIQL query and
// batch-load are POSTs but change nothing). Writes are NEVER retried automatically — a POST that
// timed out may have succeeded, and blindly repeating it is exactly how duplicate tickets get
// created. A failed write surfaces `retriable: true`; the caller retries it with an idempotency key.
async function request({
  fetch = globalThis.fetch,
  method = 'GET',
  url,
  headers = {},
  body,
  timeoutMs = 15000,
  idempotent = false,
  retries = method === 'GET' || idempotent ? 2 : 0,
  retryDelayMs = 200,
  what = `${method} request`,
}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await once({ fetch, method, url, headers, body, timeoutMs, what, secrets: secretsFrom(headers) });
    } catch (err) {
      if (!(err instanceof TrackerError) || !err.retriable || attempt >= retries) throw err;
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }
}

async function once({ fetch, method, url, headers, body, timeoutMs, what, secrets }) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual', // a redirect is never followed: the credentials in this request must not travel to wherever it points
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new TrackerError('TIMEOUT', `${what} timed out after ${timeoutMs}ms`);
    }
    throw new TrackerError('NETWORK', `${what} could not reach the tracker (${(err && err.cause && err.cause.code) || (err && err.message) || 'network error'})`);
  }

  if (res.status >= 300 && res.status < 400) {
    let where = '';
    try { where = new URL(res.headers && res.headers.get && res.headers.get('location'), url).host; } catch { /* no usable Location */ }
    throw new TrackerError('CONFIG', `${what} was redirected (HTTP ${res.status})${where ? ` to ${where}` : ''}. Redirects are not followed, so the credentials are never sent anywhere else — update the configured tracker URL (a renamed repository or project is the usual cause).`, { status: res.status });
  }

  const text = await res.text();
  if (!res.ok) throw fromStatus(res.status, redact(text, secrets), what);

  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new TrackerError('UPSTREAM_ERROR', `${what} returned a non-JSON body`, { status: res.status });
    }
  }
  return { status: res.status, json, text };
}

module.exports = { request };
