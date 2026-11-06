'use strict';

const { TrackerError } = require('./errors');

// Credentials are sent to whatever base URL an adapter is given, and that can come from a flag, $QA_TRACKER_BASE_URL or qa-config.json.
// So it is checked before a single request is made:
//   - https only. Plain http is allowed ONLY for loopback (localhost, 127.x.x.x, [::1], *.localhost), where nothing crosses a network —
//     that is what local mock servers and tests use. Anything else would send a token in cleartext.
//   - no credentials embedded in the URL (they would be logged and sent on every request), no query string or fragment.
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|[^.]+\.localhost)$/i;

function checkBaseUrl(raw, what) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new TrackerError('CONFIG', `${what} is not a valid URL`); }
  // Never echo the raw value back: it might hold the very credentials this refuses.
  const where = `${u.protocol}//${u.host}`;
  if (u.username || u.password) throw new TrackerError('CONFIG', `${what} (${where}) must not contain embedded credentials`);
  if (u.search || u.hash) throw new TrackerError('CONFIG', `${what} (${where}) must not contain a query string or fragment`);
  if (u.protocol === 'https:') return String(raw).replace(/\/+$/, '');
  if (u.protocol === 'http:' && LOOPBACK.test(u.hostname)) return String(raw).replace(/\/+$/, '');
  throw new TrackerError('CONFIG', `${what} must use https (plain http is only allowed for localhost, where nothing crosses a network); got ${where}. The tracker token would be sent in cleartext.`);
}

module.exports = { checkBaseUrl };
