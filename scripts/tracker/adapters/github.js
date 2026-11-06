'use strict';

const { TrackerError } = require('../lib/errors');
const { checkBaseUrl } = require('../lib/base-url');
const { hasMarker, extractAcceptanceCriteria } = require('../lib/contract');
const { withMarker, requireNumericId, requireToken, testCaseBody, priorityFromLabels, summary, linkByReference, eachPage, apiCall } = require('../lib/kit');

// GitHub Issues over the REST API (token auth) — works headless, unlike the `gh` CLI path.
// settings = qa-config.json > ticketSource.github  ({ repo: "owner/repo", testLabelName, tokenEnvVar, apiBaseUrl })

function create({ settings = {}, env = process.env, fetch, baseUrl, timeoutMs, retryDelayMs }) {
  const repo = settings.repo;
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new TrackerError('CONFIG', 'ticketSource.github.repo must be "owner/repo"');
  }
  const token = requireToken({ settings, env, defaultVar: 'GITHUB_TOKEN', fallbacks: ['GITHUB_TOKEN', 'GH_TOKEN'], hint: '(or GH_TOKEN)' });
  const base = checkBaseUrl(baseUrl || settings.apiBaseUrl || 'https://api.github.com', 'the GitHub API base URL');
  const testLabel = settings.testLabelName || 'test-case';

  const call = apiCall({
    fetch, base, timeoutMs, retryDelayMs,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'tech9-qa-harness',
    },
  });

  const issuePath = (id) => `/repos/${repo}/issues/${requireNumericId('GitHub issue', id)}`;
  // "dismissed" = the team closed it WITHOUT fixing it: GitHub's own "Close as not planned" / "Close as duplicate", or its default wontfix/invalid/duplicate labels.
  // A defect that reappears after that is not a regression of a fix, so it must not be filed as one.
  const DISMISS_LABEL = /^(?:wontfix|won't fix|invalid|duplicate)$/i;
  const dismissedIssue = (issue) => issue.state === 'closed' && (issue.state_reason === 'not_planned' || issue.state_reason === 'duplicate' || (issue.labels || []).some((l) => DISMISS_LABEL.test(typeof l === 'string' ? l : l.name || '')));
  const summarize = (issue) => summary({ id: issue.number, title: issue.title, url: issue.html_url, status: issue.state, open: issue.state === 'open', createdAt: issue.created_at, dismissed: dismissedIssue(issue) });

  async function fetchTicket(id) {
    const { json: issue } = await call('GET', issuePath(id), undefined, `fetch GitHub issue ${id}`);
    const { json: comments } = await call('GET', `${issuePath(id)}/comments`, undefined, `fetch comments for GitHub issue ${id}`);
    const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
    const priority = priorityFromLabels(labels);
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

  // Idempotency lookup deliberately uses the LIST endpoint, not search. GitHub's search index is
  // eventually consistent: an issue created a moment ago can be missing from search results for
  // seconds, so a retry right after a lost response would miss it and create a duplicate. Listing
  // is read-after-write consistent. It is scoped by label (a test case carries the test label and
  // its parent id; a bug carries `bug`) so it stays cheap and finds items however old they are.
  async function findByKey(key, { op, input } = {}) {
    const labels = op === 'create-test' ? [testLabel, String(input.parentId)] : op === 'create-bug' ? ['bug'] : [];
    const listPage = async (page) => {
      const query = `state=all&sort=created&direction=desc&per_page=100&page=${page}${labels.length ? `&labels=${encodeURIComponent(labels.join(','))}` : ''}`;
      return (await call('GET', `/repos/${repo}/issues?${query}`, undefined, 'look up idempotency key')).json;
    };
    for await (const batch of eachPage(listPage)) {
      const hit = batch.find((i) => !i.pull_request && hasMarker(i.body, key));
      if (hit) return { id: String(hit.number), url: hit.html_url };
    }
    return null;
  }

  async function createTest({ parentId, tcId, title, description = '', priority, steps = [], idempotencyKey }) {
    const body = withMarker(testCaseBody({ parentId, priority, description, steps }), idempotencyKey);
    const { json } = await call('POST', `/repos/${repo}/issues`, { title: `${tcId}: ${title}`, body, labels: [testLabel, String(parentId)] }, `create GitHub test issue ${tcId}`);
    return { id: String(json.number), url: json.html_url };
  }

  // GitHub issues have no native link API: the parent is referenced in the body at creation ("Tests #<parent>").
  const link = linkByReference;

  async function comment({ id, body, idempotencyKey }) {
    const { json } = await call('POST', `${issuePath(id)}/comments`, { body: withMarker(body, idempotencyKey) }, `comment on GitHub issue ${id}`);
    return { id: String(json.id), url: json.html_url };
  }

  async function findCommentByKey(id, key) {
    const { json } = await call('GET', `${issuePath(id)}/comments`, undefined, `look up idempotency key on GitHub issue ${id}`);
    const hit = (json || []).find((c) => hasMarker(c.body, key));
    return hit ? { id: String(hit.id), url: hit.html_url } : null;
  }

  async function createBug({ title, body, labels = [], idempotencyKey }) {
    const { json } = await call('POST', `/repos/${repo}/issues`, { title: `[BUG] ${title}`, body: withMarker(body, idempotencyKey), labels: ['bug', ...labels] }, 'create GitHub bug');
    return { id: String(json.number), url: json.html_url };
  }

  return { source: 'github', fetchTicket, search, findByKey, createTest, link, comment, findCommentByKey, createBug };
}

module.exports = { create };
