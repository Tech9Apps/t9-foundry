'use strict';

// Where an adapter points, as a short fingerprint of its (non-secret) settings and base URL: the repository, project or list it was configured for. The run
// ledger holds a write under it, so a project that changes its repository setting does not get answers recorded for the old one. (Lives in scripts/lib, not
// under scripts/tracker: that folder uses no Node module but fs and path, and a test holds it to that.)
const crypto = require('crypto');

function targetOf(opts) {
  const { tokenEnvVar, ...settings } = (opts && opts.settings) || {};
  const sorted = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  return crypto.createHash('sha256').update(JSON.stringify(sorted({ settings, baseUrl: (opts && opts.baseUrl) || null }))).digest('hex').slice(0, 8);
}

module.exports = { targetOf };
