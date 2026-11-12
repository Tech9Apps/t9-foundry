'use strict';

const { TrackerError } = require('./errors');
const { request } = require('./http');
const { keyMarker, stepsAsMarkdown } = require('./contract');
const { PAGE_SIZE } = require('./paging');

// The pieces every adapter was writing for itself. What differs between trackers (the endpoints, the field names, what "dismissed" means
// in their words) stays in each adapter; what is the same lives here, so a fix lands in all five at once.

// An idempotency key travels in the text of what an adapter creates (Azure keeps it in a tag instead). No key, no marker.
const withMarker = (text, key) => (key ? `${text}\n\n${keyMarker(key)}` : text);

// GitHub, GitLab, Bitbucket and Azure address an item by a number. Anything else would be spliced into a URL path, so it is refused here.
function requireNumericId(what, id) {
  if (!/^\d+$/.test(String(id))) throw new TrackerError('VALIDATION', `${what} ids are numbers (got "${id}")`);
  return String(id);
}

// The credential, from the variable the config names (else the default) and then any fallbacks. `hint` is added to the message,
// e.g. "(or GH_TOKEN)". The token itself is never part of a message.
function requireToken({ settings = {}, env, defaultVar, fallbacks = [], hint }) {
  const tokenVar = settings.tokenEnvVar || defaultVar;
  // A variable the config names is the ONLY one read: falling back to another would send a credential other than the one chosen.
  const names = settings.tokenEnvVar ? [tokenVar] : [tokenVar, ...fallbacks];
  const token = names.map((name) => env[name]).find(Boolean);
  if (!token) throw new TrackerError('CONFIG', `${tokenVar}${hint && !settings.tokenEnvVar ? ` ${hint}` : ''} is not set`);
  return token;
}

// The markdown body of a test case on a tracker with no structured steps field. The caller adds the idempotency marker (withMarker).
function testCaseBody({ parentId, priority, description, steps = [] }) {
  return [
    `Tests #${parentId}`,
    priority ? `**Priority:** ${priority}` : null,
    description ? `\n${description}` : null,
    steps.length ? `\n### Steps\n${stepsAsMarkdown(steps)}` : null,
  ].filter(Boolean).join('\n');
}

// "priority:High" -> "High", from a list of label names.
const priorityFromLabels = (labels) => (labels.find((l) => /^priority:/i.test(l)) || '').replace(/^priority:\s*/i, '');

// What `search` returns for each item, the same shape from every tracker.
const summary = ({ id, title, url, status, open, createdAt, dismissed }) => ({
  id: String(id), title, url, status, open, ...(createdAt ? { createdAt } : {}), ...(dismissed ? { dismissed: true } : {}),
});

// Trackers with no link API record the parent in the body when the test case is created ("Tests #<parent>"): nothing is left to do.
const linkByReference = async () => ({ linked: true, method: 'reference-in-body' });

// Linking twice is not a failure: the goal state (linked) already holds. True when `err` is the tracker saying so.
const isDuplicateLink = (err, pattern) => err instanceof TrackerError && err.code === 'VALIDATION' && pattern.test(err.message);

// Walks a tracker's listing a page at a time, yielding each page's items, for at most `max` pages and ending at the first page shorter
// than `size`. Stopping early (a `return` in the consumer) asks for no further page.
const LIST_PAGES = 5; // up to 500 items per lookup
async function* eachPage(fetchPage, { first = 1, max = LIST_PAGES, size = PAGE_SIZE } = {}) {
  for (let page = first; page < first + max; page += 1) {
    const batch = (await fetchPage(page)) || [];
    yield batch;
    if (batch.length < size) return;
  }
}

// One call to a tracker's API: base + path, the headers that carry the credential, and the retry/timeout the caller chose.
const apiCall = ({ fetch, base, headers, timeoutMs, retryDelayMs }) => (method, path, body, what) => request({
  fetch, method, url: `${base}${path}`, body, timeoutMs, retryDelayMs, what, headers,
});

module.exports = {
  LIST_PAGES, PAGE_SIZE, withMarker, requireNumericId, requireToken, testCaseBody, priorityFromLabels, summary, linkByReference, isDuplicateLink,
  eachPage, apiCall,
};
