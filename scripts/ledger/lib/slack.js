'use strict';

// The one outbound write a run summary can make: a POST to a Slack incoming webhook (docs/phase-3-design.md, "Reporting"). The URL comes from the environment
// (QA_SLACK_WEBHOOK), and it is itself a credential (whoever has it can post to the channel), so:
//   - https only, no credentials in the address, no odd port;
//   - the host must be hooks.slack.com, or a host the project's qa-config.json names (report.slackHosts): a variable set to some other address does not get the summary;
//   - a redirect is NOT followed (a webhook that answers with one is refused: it could be sending the body somewhere that was never checked);
//   - the body is the already-masked summary, size-capped;
//   - the address never appears in anything this module returns or says, and a failure to post is a reason string, never an exception: the run is not failed by Slack.
const DEFAULT_HOST = 'hooks.slack.com';
const MAX_BODY_BYTES = 32 * 1024;
// a host NAME: lower case, at least two labels, and not an address (127.0.0.1 and 169.254.169.254 are not places a summary is sent)
const HOST = /^(?![0-9.]+$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// { configured: false } when no webhook is set; { configured: true, ok: true, url } when it may be used; { configured: true, ok: false, reason } when it may not.
function slackTarget(raw, { hosts = [] } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { configured: false };
  let u;
  try { u = new URL(String(raw).trim()); } catch { return { configured: true, ok: false, reason: 'QA_SLACK_WEBHOOK is not a URL' }; }
  if (u.protocol !== 'https:') return { configured: true, ok: false, reason: 'QA_SLACK_WEBHOOK must be an https URL' };
  if (u.username || u.password) return { configured: true, ok: false, reason: 'QA_SLACK_WEBHOOK must not carry a user name or password in its address' };
  if (u.port) return { configured: true, ok: false, reason: 'QA_SLACK_WEBHOOK must use the default https port' };
  const allowed = [DEFAULT_HOST, ...hosts];
  if (!allowed.includes(u.hostname)) return { configured: true, ok: false, reason: `the host of QA_SLACK_WEBHOOK is not allowed (allowed: ${allowed.join(', ')}; more can be named in report.slackHosts in qa-config.json)` };
  return { configured: true, ok: true, url: u.href };
}

// { ok: true } or { ok: false, reason }. `fetch` is injected so that a test needs no network.
async function postSlack({ url, text, fetch = globalThis.fetch, timeoutMs = 10000 }) {
  const body = JSON.stringify({ text });
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return { ok: false, reason: `the message is larger than ${MAX_BODY_BYTES} bytes, so it was not sent` };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    try { if (res.body && res.body.cancel) await res.body.cancel(); } catch { /* the answer is not read: release it */ }
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return { ok: false, reason: res.status >= 300 && res.status < 400 ? `the webhook answered with a redirect (${res.status}), which is not followed` : `the webhook answered ${res.status}` };
  } catch (e) {
    return { ok: false, reason: `the message could not be sent (${e && e.name === 'TimeoutError' ? 'timed out' : 'the request failed'})` };
  }
}

module.exports = { slackTarget, postSlack, DEFAULT_HOST, MAX_BODY_BYTES, HOST };
