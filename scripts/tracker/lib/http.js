'use strict';

const { TrackerError, fromStatus } = require('./errors');

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
      return await once({ fetch, method, url, headers, body, timeoutMs, what });
    } catch (err) {
      if (!(err instanceof TrackerError) || !err.retriable || attempt >= retries) throw err;
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }
}

async function once({ fetch, method, url, headers, body, timeoutMs, what }) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new TrackerError('TIMEOUT', `${what} timed out after ${timeoutMs}ms`);
    }
    throw new TrackerError('NETWORK', `${what} could not reach the tracker (${(err && err.cause && err.cause.code) || (err && err.message) || 'network error'})`);
  }

  const text = await res.text();
  if (!res.ok) throw fromStatus(res.status, text, what);

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
