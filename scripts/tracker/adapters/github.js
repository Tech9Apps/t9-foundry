'use strict';

const { TrackerError } = require('../lib/errors');
const { request } = require('../lib/http');
const { keyMarker, stepsAsMarkdown, extractAcceptanceCriteria } = require('../lib/contract');

// GitHub Issues over the REST API (token auth) — works headless, unlike the `gh` CLI path.
// settings = qa-config.json > ticketSource.github  ({ repo: "owner/repo", testLabelName, tokenEnvVar, apiBaseUrl })
function create({ settings = {}, env = process.env, fetch, baseUrl, timeoutMs, retryDelayMs }) {
  const repo = settings.repo;
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new TrackerError('CONFIG', 'ticketSource.github.repo must be "owner/repo"');
  }
  const tokenVar = settings.tokenEnvVar || 'GITHUB_TOKEN';
  const token = env[tokenVar] || env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) throw new TrackerError('CONFIG', `${tokenVar} (or GH_TOKEN) is not set`);
  const base = (baseUrl || settings.apiBaseUrl || 'https://api.github.com').replace(/\/$/, '');
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
  const summarize = (issue) => ({ id: String(issue.number), title: issue.title, url: issue.html_url, status: issue.state });

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
    const parts = [query, `repo:${repo}`, 'is:issue'];
    if (kind === 'bug') parts.push('label:bug');
    if (kind === 'test') parts.push(`label:${testLabel}`);
    const { json } = await call('GET', `/search/issues?q=${encodeURIComponent(parts.join(' '))}&per_page=${limit}`, undefined, 'search GitHub issues');
    return { items: (json.items || []).slice(0, limit).map(summarize) };
  }

  async function findByKey(key) {
    const marker = keyMarker(key);
    const { json } = await call('GET', `/search/issues?q=${encodeURIComponent(`"${marker}" repo:${repo} is:issue in:body`)}&per_page=5`, undefined, 'look up idempotency key');
    const hit = (json.items || []).find((i) => (i.body || '').includes(marker));
    return hit ? { id: String(hit.number), url: hit.html_url } : null;
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

  async function comment({ id, body }) {
    const { json } = await call('POST', `${issuePath(id)}/comments`, { body }, `comment on GitHub issue ${id}`);
    return { id: String(json.id), url: json.html_url };
  }

  async function createBug({ title, body, labels = [], idempotencyKey }) {
    const text = idempotencyKey ? `${body}\n\n${keyMarker(idempotencyKey)}` : body;
    const { json } = await call('POST', `/repos/${repo}/issues`, { title: `[BUG] ${title}`, body: text, labels: ['bug', ...labels] }, 'create GitHub bug');
    return { id: String(json.number), url: json.html_url };
  }

  return { source: 'github', fetchTicket, search, findByKey, createTest, link, comment, createBug };
}

module.exports = { create };
