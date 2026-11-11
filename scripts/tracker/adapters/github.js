'use strict';

const { TrackerError } = require('../lib/errors');
const { checkBaseUrl } = require('../lib/base-url');
const { findInPages, PAGE_SIZE } = require('../lib/paging');
const { request } = require('../lib/http');
const { keyMarker, hasMarker, stepsAsMarkdown, extractAcceptanceCriteria } = require('../lib/contract');

// GitHub Issues over the REST API (token auth) — works headless, unlike the `gh` CLI path.
// settings = qa-config.json > ticketSource.github  ({ repo: "owner/repo", testLabelName, tokenEnvVar, apiBaseUrl })
const LIST_PAGES = 5; // up to 500 labelled issues per lookup

function create({ settings = {}, env = process.env, fetch, baseUrl, timeoutMs, retryDelayMs }) {
  const repo = settings.repo;
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new TrackerError('CONFIG', 'ticketSource.github.repo must be "owner/repo"');
  }
  const tokenVar = settings.tokenEnvVar || 'GITHUB_TOKEN';
  // A variable the config names is the only one read: falling back to GITHUB_TOKEN / GH_TOKEN would send a credential other than the one chosen.
  const token = settings.tokenEnvVar ? env[tokenVar] : env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) throw new TrackerError('CONFIG', settings.tokenEnvVar ? `${tokenVar} is not set` : `${tokenVar} (or GH_TOKEN) is not set`);
  const base = checkBaseUrl(baseUrl || settings.apiBaseUrl || 'https://api.github.com', 'the GitHub API base URL', { hosts: ['api.github.com'], env });
  const testLabel = settings.testLabelName || 'test-case';

  const call = (method, path, body, what) => request({
    fetch, method, url: `${base}${path}`, body, timeoutMs, retryDelayMs, what,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'tech9-qa-harness',
    },
  });

  const issuePath = (id) => {
    if (!/^\d+$/.test(String(id))) throw new TrackerError('VALIDATION', `GitHub issue ids are numbers (got "${id}")`);
    return `/repos/${repo}/issues/${id}`;
  };
  // "dismissed" = the team closed it WITHOUT fixing it: GitHub's own "Close as not planned" / "Close as duplicate", or its default wontfix/invalid/duplicate labels.
  // A defect that reappears after that is not a regression of a fix, so it must not be filed as one.
  const DISMISS_LABEL = /^(?:wontfix|won't fix|invalid|duplicate)$/i;
  const dismissedIssue = (issue) => issue.state === 'closed' && (issue.state_reason === 'not_planned' || issue.state_reason === 'duplicate' || (issue.labels || []).some((l) => DISMISS_LABEL.test(typeof l === 'string' ? l : l.name || '')));
  const summarize = (issue) => ({ id: String(issue.number), title: issue.title, url: issue.html_url, status: issue.state, open: issue.state === 'open', ...(issue.created_at ? { createdAt: issue.created_at } : {}), ...(dismissedIssue(issue) ? { dismissed: true } : {}) });

  async function fetchTicket(id) {
    const { json: issue } = await call('GET', issuePath(id), undefined, `fetch GitHub issue ${id}`);
    const { json: comments } = await call('GET', `${issuePath(id)}/comments`, undefined, `fetch comments for GitHub issue ${id}`);
    const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
    const priority = (labels.find((l) => /^priority:/i.test(l)) || '').replace(/^priority:\s*/i, '');
    return {
      source: 'github',
      id: String(issue.number),
      url: issue.html_url,
      title: issue.title,
      description: issue.body || '',
      type: labels.some((l) => l.toLowerCase() === 'bug') ? 'Bug' : 'Task',
      status: issue.state,
      priority,
      labels,
      acceptanceCriteria: extractAcceptanceCriteria(issue.body || ''),
      attachments: [],
      comments: (comments || []).map((c) => ({ author: c.user && c.user.login, body: c.body, created: c.created_at })),
      subtasks: [],
    };
  }

  async function search({ query, kind = 'any', limit = 10 }) {
    // A colon in the text would let it carry a search qualifier ("repo:victim/private" widens the search to any repository the token can read), so the
    // text is searched as words: the only qualifiers sent are the ones below.
    const parts = [String(query).replace(/:/g, ' '), `repo:${repo}`, 'is:issue'];
    if (kind === 'bug') parts.push('label:bug');
    if (kind === 'test') parts.push(`label:${testLabel}`);
    const { json } = await call('GET', `/search/issues?q=${encodeURIComponent(parts.join(' '))}&per_page=${limit}`, undefined, 'search GitHub issues');
    return { items: (json.items || []).slice(0, limit).map(summarize) };
  }

  // Idempotency lookup deliberately uses the LIST endpoint, not search. GitHub's search index is
  // eventually consistent: an issue created a moment ago can be missing from search results for
  // seconds, so a retry right after a lost response would miss it and create a duplicate. Listing
  // is read-after-write consistent. It is scoped by label (a test case carries the test label and
  // its parent id; a bug carries `bug`) so it stays cheap and finds items however old they are.
  async function findByKey(key, { op, input } = {}) {
    const labels = op === 'create-test' ? [testLabel, String(input.parentId)] : op === 'create-bug' ? ['bug'] : [];
    for (let page = 1; page <= LIST_PAGES; page += 1) {
      const query = `state=all&sort=created&direction=desc&per_page=100&page=${page}${labels.length ? `&labels=${encodeURIComponent(labels.join(','))}` : ''}`;
      const { json } = await call('GET', `/repos/${repo}/issues?${query}`, undefined, 'look up idempotency key');
      const batch = json || [];
      const hit = batch.find((i) => !i.pull_request && hasMarker(i.body, key));
      if (hit) return { id: String(hit.number), url: hit.html_url };
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
      idempotencyKey ? `\n${keyMarker(idempotencyKey)}` : null,
    ].filter(Boolean).join('\n');
    const { json } = await call('POST', `/repos/${repo}/issues`, { title: `${tcId}: ${title}`, body, labels: [testLabel, String(parentId)] }, `create GitHub test issue ${tcId}`);
    return { id: String(json.number), url: json.html_url };
  }

  // GitHub issues have no native link API: the parent is referenced in the body at creation
  // ("Tests #<parent>"), so there is nothing further to do.
  async function link() {
    return { linked: true, method: 'reference-in-body' };
  }

  async function comment({ id, body, idempotencyKey }) {
    const text = idempotencyKey ? `${body}\n\n${keyMarker(idempotencyKey)}` : body;
    const { json } = await call('POST', `${issuePath(id)}/comments`, { body: text }, `comment on GitHub issue ${id}`);
    return { id: String(json.id), url: json.html_url };
  }

  async function findCommentByKey(id, key) {
    const hit = await findInPages(async (page) => {
      const { json } = await call('GET', `${issuePath(id)}/comments?per_page=${PAGE_SIZE}&page=${page}`, undefined, `look up idempotency key on GitHub issue ${id}`);
      return { items: json || [], more: (json || []).length >= PAGE_SIZE };
    }, (c) => hasMarker(c.body, key), `look up idempotency key on GitHub issue ${id}`);
    return hit ? { id: String(hit.id), url: hit.html_url } : null;
  }

  async function createBug({ title, body, labels = [], idempotencyKey }) {
    const text = idempotencyKey ? `${body}\n\n${keyMarker(idempotencyKey)}` : body;
    const { json } = await call('POST', `/repos/${repo}/issues`, { title: `[BUG] ${title}`, body: text, labels: ['bug', ...labels] }, 'create GitHub bug');
    return { id: String(json.number), url: json.html_url };
  }

  return { source: 'github', fetchTicket, search, findByKey, createTest, link, comment, findCommentByKey, createBug };
}

module.exports = { create };
