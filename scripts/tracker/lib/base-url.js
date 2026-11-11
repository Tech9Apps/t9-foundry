'use strict';

const { TrackerError } = require('./errors');

// Credentials are sent to whatever base URL an adapter is given, and that can come from a flag, $QA_TRACKER_BASE_URL or qa-config.json.
// So it is checked before a single request is made:
//   - https only. Plain http is allowed ONLY for loopback (localhost, 127.x.x.x, [::1], *.localhost), where nothing crosses a network —
//     that is what local mock servers and tests use. Anything else would send a token in cleartext.
//   - no credentials embedded in the URL (they would be logged and sent on every request), no query string or fragment.
//   - when the adapter says which hosts it may talk to ({ hosts, env }), the token goes ONLY to one of those, to a host the PERSON allowed in their own
//     shell ($QA_TRACKER_ALLOW_HOSTS: comma-separated, "host.example.com" or "*.example.com"), or to a reserved test host (*.test, loopback: nothing public
//     can be reached there, and it is what the mocks use). The base URL and host come from qa-config.json (including committed profiles) and from flags
//     a prompt-injected model can set, so "https" alone let a config point `Authorization: Bearer <token>` at any server. The allowlist is read from the
//     environment, never from the config: the config is where the attacker writes.
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|[^.]+\.localhost)$/i;
const HOST_NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

const bareHost = (h) => String(h).toLowerCase().replace(/\.$/, '');
// Entries that are not a plain host name, or a "*." wildcard over at least two labels ("*.com" and "*" would allow the world), are ignored.
function allowedByPerson(env) {
  const out = [];
  for (const entry of String((env && env.QA_TRACKER_ALLOW_HOSTS) || '').split(',')) {
    const e = entry.trim().toLowerCase();
    if (e.startsWith('*.')) { const suffix = e.slice(2); if (HOST_NAME.test(suffix) && suffix.split('.').length >= 2) out.push({ suffix }); }
    else if (HOST_NAME.test(e)) out.push({ exact: e });
  }
  return out;
}
function hostAllowed(hostname, hosts, env) {
  const h = bareHost(hostname);
  if (LOOPBACK.test(h) || h === 'test' || h.endsWith('.test')) return true;
  if (hosts.some((own) => bareHost(own) === h)) return true;
  return allowedByPerson(env).some((a) => (a.exact ? a.exact === h : h.endsWith('.' + a.suffix)));
}

function checkBaseUrl(raw, what, { hosts, env } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new TrackerError('CONFIG', `${what} is not a valid URL`); }
  // Never echo the raw value back: it might hold the very credentials this refuses.
  const where = `${u.protocol}//${u.host}`;
  if (u.username || u.password) throw new TrackerError('CONFIG', `${what} (${where}) must not contain embedded credentials`);
  if (u.search || u.hash) throw new TrackerError('CONFIG', `${what} (${where}) must not contain a query string or fragment`);
  const ok = () => {
    if (hosts && !hostAllowed(u.hostname, hosts, env)) {
      throw new TrackerError('CONFIG', `${what} names ${u.hostname}, which is not a host this tracker's token may be sent to (${hosts.join(', ')}). If it really is your server, allow it in your own shell: export QA_TRACKER_ALLOW_HOSTS=${bareHost(u.hostname)} (comma-separated; "*.example.com" allows subdomains). It cannot be allowed from qa-config.json.`);
    }
    return String(raw).replace(/\/+$/, '');
  };
  if (u.protocol === 'https:') return ok();
  if (u.protocol === 'http:' && LOOPBACK.test(u.hostname)) return ok();
  throw new TrackerError('CONFIG', `${what} must use https (plain http is only allowed for localhost, where nothing crosses a network); got ${where}. The tracker token would be sent in cleartext.`);
}

module.exports = { checkBaseUrl };
