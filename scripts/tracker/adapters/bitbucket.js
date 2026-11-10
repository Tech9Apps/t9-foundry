'use strict';

const { TrackerError } = require('../lib/errors');
const { checkBaseUrl } = require('../lib/base-url');
const { request } = require('../lib/http');
const { keyMarker, hasMarker, stepsAsMarkdown, extractAcceptanceCriteria } = require('../lib/contract');

// Bitbucket Cloud issue tracker, REST 2.0, app-password auth.
// settings = qa-config.json > ticketSource.bitbucket  ({ workspace, repo, username, tokenEnvVar })
// The repository's issue tracker must be enabled (Repository settings → Issue tracker).
//
// Bitbucket has no labels and no issue-link API, so: a test case is a `task` whose title starts with its
// TC id, a bug is a `bug`, and the parent is referenced in the test case's body (like GitHub).
const LIST_PAGES = 5;
const TEST_PRIORITY = { High: 'major', Medium: 'minor', Low: 'trivial' };
const BUG_PRIORITY = { High: 'critical', Medium: 'major', Low: 'minor' };
const bbql = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function create({ settings = {}, env = process.env, fetch, baseUrl, timeoutMs, retryDelayMs }) {
  const { workspace, repo, username } = settings;
  if (!workspace || !repo) throw new TrackerError('CONFIG', 'ticketSource.bitbucket.workspace and .repo must be set');
  if (!username) throw new TrackerError('CONFIG', 'ticketSource.bitbucket.username is not set (app passwords authenticate as username:app_password)');
  const tokenVar = settings.tokenEnvVar || 'BITBUCKET_TOKEN';
  const secret = env[tokenVar];
  if (!secret) throw new TrackerError('CONFIG', `${tokenVar} is not set`);
  const api = checkBaseUrl(baseUrl || 'https://api.bitbucket.org/2.0', 'the Bitbucket API base URL', { hosts: ['api.bitbucket.org'], env });
  const issues = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/issues`;
  const auth = `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}`;

  const call = (method, path, body, what) => request({
    fetch, method, url: `${api}${path}`, body, timeoutMs, retryDelayMs, what, headers: { Authorization: auth },
  });

  const issuePath = (id) => {
    if (!/^\d+$/.test(String(id))) throw new TrackerError('VALIDATION', `Bitbucket issue ids are numbers (got "${id}")`);
    return `${issues}/${id}`;
  };
  const href = (i) => i.links && i.links.html && i.links.html.href;
  const summarize = (i) => ({ id: String(i.id), title: i.title, url: href(i), status: i.state });
  const withMarker = (text, key) => (key ? `${text}\n\n${keyMarker(key)}` : text);
  const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

  async function fetchTicket(id) {
    const { json: issue } = await call('GET', issuePath(id), undefined, `fetch Bitbucket issue ${id}`);
    const { json: comments } = await call('GET', `${issuePath(id)}/comments?pagelen=100`, undefined, `fetch comments for Bitbucket issue ${id}`);
    const description = (issue.content && issue.content.raw) || '';
    return {
      source: 'bitbucket',
      id: String(issue.id),
      url: href(issue),
      title: issue.title,
      description,
      type: issue.kind === 'bug' ? 'Bug' : capital(issue.kind) || 'Task',
      status: issue.state,
      priority: issue.priority || '',
      labels: issue.component && issue.component.name ? [issue.component.name] : [],
      acceptanceCriteria: extractAcceptanceCriteria(description),
      attachments: [],
      comments: ((comments && comments.values) || []).filter((c) => !c.deleted).map((c) => ({ author: c.user && (c.user.display_name || c.user.nickname), body: c.content && c.content.raw, created: c.created_on })),
      subtasks: [],
    };
  }

  async function search({ query, kind = 'any', limit = 10 }) {
    let q = `(title ~ "${bbql(query)}" OR content.raw ~ "${bbql(query)}")`;
    if (kind === 'bug') q += ' AND kind = "bug"';
    if (kind === 'test') q += ' AND kind = "task" AND title ~ "TC-"';
    const { json } = await call('GET', `${issues}?q=${encodeURIComponent(q)}&pagelen=${limit}`, undefined, 'search Bitbucket issues');
    return { items: ((json && json.values) || []).slice(0, limit).map(summarize) };
  }

  // Lists newest-first by kind (a plain filtered listing, not text search) and checks the marker.
  async function findByKey(key, { op, input } = {}) {
    let q = op === 'create-test' ? `kind = "task" AND title ~ "${bbql(input.tcId)}:"` : 'kind = "bug"';
    if (op !== 'create-test' && op !== 'create-bug') q = 'kind != "none"';
    for (let page = 1; page <= LIST_PAGES; page += 1) {
      const { json } = await call('GET', `${issues}?q=${encodeURIComponent(q)}&sort=-created_on&pagelen=100&page=${page}`, undefined, 'look up idempotency key');
      const batch = (json && json.values) || [];
      const hit = batch.find((i) => hasMarker(i.content && i.content.raw, key));
      if (hit) return { id: String(hit.id), url: href(hit) };
      if (batch.length < 100) break;
    }
    return null;
  }

  async function createTest({ parentId, tcId, title, description = '', priority, steps = [], idempotencyKey }) {
    const body = [
      `Tests #${parentId}`,
      priority ? `**Priority:** ${priority}` : null,
      description ? `\n${description}` : null,
      steps.length ? `\n### Steps\n${stepsAsMarkdown(steps)}` : null,
    ].filter(Boolean).join('\n');
    const { json } = await call('POST', issues, {
      title: `${tcId}: ${title}`, content: { raw: withMarker(body, idempotencyKey), markup: 'markdown' }, kind: 'task', priority: TEST_PRIORITY[priority] || 'minor',
    }, `create Bitbucket test issue ${tcId}`);
    return { id: String(json.id), url: href(json) };
  }

  // No link API: the parent is referenced in the body at creation ("Tests #<parent>").
  async function link() {
    return { linked: true, method: 'reference-in-body' };
  }

  async function comment({ id, body, idempotencyKey }) {
    const { json } = await call('POST', `${issuePath(id)}/comments`, { content: { raw: withMarker(body, idempotencyKey) } }, `comment on Bitbucket issue ${id}`);
    return { id: String(json.id), url: href(json) };
  }

  async function findCommentByKey(id, key) {
    const { json } = await call('GET', `${issuePath(id)}/comments?pagelen=100`, undefined, `look up idempotency key on Bitbucket issue ${id}`);
    const hit = ((json && json.values) || []).find((c) => !c.deleted && hasMarker(c.content && c.content.raw, key));
    return hit ? { id: String(hit.id) } : null;
  }

  async function createBug({ title, body, priority, idempotencyKey }) {
    const { json } = await call('POST', issues, {
      title, content: { raw: withMarker(body, idempotencyKey), markup: 'markdown' }, kind: 'bug', priority: BUG_PRIORITY[priority] || 'major',
    }, 'create Bitbucket bug');
    return { id: String(json.id), url: href(json) };
  }

  return { source: 'bitbucket', fetchTicket, search, findByKey, createTest, link, comment, findCommentByKey, createBug };
}

module.exports = { create };
