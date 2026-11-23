'use strict';

const crypto = require('crypto');

// How a run id becomes part of something else (an idempotency key, a file name). Shared by the triage planner and the run ledger so
// that one rule, subtle enough to have a test of its own, is not written twice.

const sanitize = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
// The run's part of an idempotency key. A short id made of safe characters is used as it is (readable, and what an operator would type). Anything else
// (long, or with characters that would fold together: "a/b" and "a-b") keeps a readable prefix and adds a hash of the WHOLE id, so two different run
// ids never share a key, which would silently deduplicate the second run's bug into the first. At most 24 + 1 + 12 = 37 characters, so the key stays under 80.
// An id that already ENDS like a hashed one ("-" and 12 hex digits) is hashed too, so a run literally named like another run's hashed form cannot share its key:
// every key part ending that way was produced by hashing the whole id.
const runPart = (runId) => {
  const id = String(runId);
  return /^[A-Za-z0-9._-]{1,40}$/.test(id) && !/-[0-9a-f]{12}$/.test(id) ? id : `${sanitize(id).slice(0, 24)}-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
};
// Any 1-128 printable characters: an odd id (refs/heads/main, build#42) is hashed into the key above, so there is nothing to protect by refusing it.
const isValidRunId = (id) => typeof id === 'string' && /^[^\u0000-\u001f\u007f]{1,128}$/u.test(id);

module.exports = { sanitize, runPart, isValidRunId };
