'use strict';

// Every adapter failure is normalized to one shape so callers (commands, agents, the
// autonomous runner) can decide what to do without knowing which tracker said no.
//
//   NOT_FOUND         the ticket/item does not exist (or is not visible to this token)
//   UNAUTHENTICATED   missing/invalid credentials
//   FORBIDDEN         authenticated, but not allowed
//   VALIDATION        the request was rejected as invalid (also: bad input caught client-side)
//   CONFIG            required configuration or environment variable is missing
//   RATE_LIMITED      slow down                                  (retriable)
//   TIMEOUT           no answer in time                          (retriable)
//   NETWORK           could not reach the tracker                (retriable)
//   UPSTREAM_ERROR    tracker-side 5xx                           (retriable)
const RETRIABLE = new Set(['RATE_LIMITED', 'TIMEOUT', 'NETWORK', 'UPSTREAM_ERROR']);

class TrackerError extends Error {
  constructor(code, message, { status = null, details = null } = {}) {
    super(message);
    this.name = 'TrackerError';
    this.code = code;
    this.status = status;
    this.retriable = RETRIABLE.has(code);
    this.details = details;
  }

  toJSON() {
    const out = { code: this.code, message: this.message, status: this.status, retriable: this.retriable };
    if (this.details) out.details = this.details;
    return out;
  }
}

function excerpt(text, max = 200) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// Map an HTTP failure to a TrackerError. `what` names the operation for the message.
function fromStatus(status, bodyText, what) {
  const detail = excerpt(bodyText);
  const suffix = detail ? `: ${detail}` : '';
  const message = `${what} failed with HTTP ${status}${suffix}`;
  if (status === 401) return new TrackerError('UNAUTHENTICATED', message, { status });
  if (status === 403) {
    // GitHub reports rate limiting as a 403 with an explanatory body.
    return new TrackerError(/rate limit/i.test(bodyText || '') ? 'RATE_LIMITED' : 'FORBIDDEN', message, { status });
  }
  if (status === 404) return new TrackerError('NOT_FOUND', message, { status });
  if (status === 429 || status === 425) return new TrackerError('RATE_LIMITED', message, { status });
  if (status === 408) return new TrackerError('TIMEOUT', message, { status });
  // Every other 4xx (405, 410 "issues are disabled", 413 body too large, 451, ...) is a refusal that repeating the request cannot change: it is not
  // retriable. Only a 5xx (or anything outside 4xx) is the tracker's own trouble, which a retry may get past.
  if (status >= 400 && status < 500) return new TrackerError('VALIDATION', message, { status });
  return new TrackerError('UPSTREAM_ERROR', message, { status });
}

module.exports = { TrackerError, fromStatus, RETRIABLE };
