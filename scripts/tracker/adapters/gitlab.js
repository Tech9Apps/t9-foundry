'use strict';

const { TrackerError } = require('../lib/errors');
const { request } = require('../lib/http');
const { keyMarker, stepsAsMarkdown, extractAcceptanceCriteria } = require('../lib/contract');

// GitLab Issues, REST v4, personal/project access token.
// settings = qa-config.json > ticketSource.gitlab  ({ projectId, host, tokenEnvVar, testLabelName })
// Items are addressed by their project-scoped number (`iid`), which is the number users see.
const LIST_PAGES = 5; // up to 500 labelled issues per key lookup

function create({ settings = {}, env = process.env, fetch, baseUrl, timeoutMs, retryDelayMs }) {
  const projectId = settings.projectId;
  if (!projectId) throw new TrackerError('CONFIG', 'ticketSource.gitlab.projectId is not set');
  const tokenVar = settings.tokenEnvVar || 'GITLAB_TOKEN';
  const token = env[tokenVar];
  if (!token) throw new TrackerError('CONFIG', `${tokenVar} is not set`);
  // `baseUrl` overrides the whole API root (mocks); otherwise <host>/api/v4
  const api = (baseUrl || `${(settings.host || 'https://gitlab.com').replace(/\/$/, '')}/api/v4`).replace(/\/$/, '');
  const testLabel = settings.testLabelName || 'test-case';
  const project = `/projects/${encodeURIComponent(projectId)}`;

  const call = (method, path, body, what) => request({
    fetch, method, url: `${api}${path}`, body, timeoutMs, retryDelayMs, what,
    headers: { 'PRIVATE-TOKEN': token },
  });

  const issuePath = (id) => {
    if (!/^\d+$/.test(String(id))) throw new TrackerError('VALIDATION', `GitLab issue ids are numbers (got "${id}")`);
    return `${project}/issues/${id}`;
  };
  const summarize = (i) => ({ id: String(i.iid), title: i.title, url: i.web_url, status: i.state });
  const priorityLabel = (p) => (p ? [`priority:${p}`] : []);

  async function fetchTicket(id) {
    const { json: issue } = await call('GET', issuePath(id), undefined, `fetch GitLab issue ${id}`);
    const { json: notes } = await call('GET', `${issuePath(id)}/notes?sort=asc&order_by=created_at&per_page=100`, undefined, `fetch notes for GitLab issue ${id}`);
    const labels = issue.labels || [];
    const priority = (labels.find((l) => /^priority:/i.test(l)) || '').replace(/^priority:\s*/i, '');
    return {
      source: 'gitlab',
      id: String(issue.iid),
      url: issue.web_url,
      title: issue.title,
      description: issue.description || '',
      type: labels.some((l) => l.toLowerCase() === 'bug') || issue.issue_type === 'incident' ? 'Bug' : 'Task',
      status: issue.state,
      priority,
      labels,
      acceptanceCriteria: extractAcceptanceCriteria(issue.description || ''),
      attachments: [],
      comments: (notes || []).filter((n) => !n.system).map((n) => ({ author: n.author && n.author.username, body: n.body, created: n.created_at })),
      subtasks: [],
    };
  }

  async function search({ query, kind = 'any', limit = 10 }) {
    const labels = kind === 'bug' ? 'bug' : kind === 'test' ? testLabel : '';
    const qs = `search=${encodeURIComponent(query)}&in=title,description&state=all&per_page=${limit}${labels ? `&labels=${encodeURIComponent(labels)}` : ''}`;
    const { json } = await call('GET', `${project}/issues?${qs}`, undefined, 'search GitLab issues');
    return { items: (json || []).slice(0, limit).map(summarize) };
  }

  // Lists by label (consistent) rather than searching: see the GitHub adapter for why.
  async function findByKey(key, { op, input } = {}) {
    const marker = keyMarker(key);
    const labels = op === 'create-test' ? [testLabel, String(input.parentId)] : op === 'create-bug' ? ['bug'] : [];
    for (let page = 1; page <= LIST_PAGES; page += 1) {
      const qs = `state=all&order_by=created_at&sort=desc&per_page=100&page=${page}${labels.length ? `&labels=${encodeURIComponent(labels.join(','))}` : ''}`;
      const { json } = await call('GET', `${project}/issues?${qs}`, undefined, 'look up idempotency key');
      const batch = json || [];
      const hit = batch.find((i) => (i.description || '').includes(marker));
      if (hit) return { id: String(hit.iid), url: hit.web_url };
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
    const { json } = await call('POST', `${project}/issues`, { title: `${tcId}: ${title}`, description: body, labels: [testLabel, String(parentId), ...priorityLabel(priority)].join(',') }, `create GitLab test issue ${tcId}`);
    return { id: String(json.iid), url: json.web_url };
  }

  // The numeric project id is needed to link (a path like "group/app" has to be resolved once).
  let numericProjectId;
  async function resolveProjectId() {
    if (numericProjectId) return numericProjectId;
    if (/^\d+$/.test(String(projectId))) numericProjectId = Number(projectId);
    else numericProjectId = (await call('GET', project, undefined, 'resolve the GitLab project id')).json.id;
    return numericProjectId;
  }

  async function link({ childId, parentId }) {
    const targetProject = await resolveProjectId();
    try {
      await call('POST', `${issuePath(childId)}/links`, { target_project_id: targetProject, target_issue_iid: Number(parentId), link_type: 'relates_to' }, `link GitLab issue ${childId} to ${parentId}`);
    } catch (err) {
      // Linking twice is not a failure: the goal state (linked) already holds.
      if (!(err instanceof TrackerError && err.code === 'VALIDATION' && /already assigned|already exists/i.test(err.message))) throw err;
    }
    return { linked: true, method: 'native' };
  }

  async function comment({ id, body, idempotencyKey }) {
    const text = idempotencyKey ? `${body}\n\n${keyMarker(idempotencyKey)}` : body;
    const { json } = await call('POST', `${issuePath(id)}/notes`, { body: text }, `comment on GitLab issue ${id}`);
    return { id: String(json.id) };
  }

  async function findCommentByKey(id, key) {
    const marker = keyMarker(key);
    const { json } = await call('GET', `${issuePath(id)}/notes?sort=asc&order_by=created_at&per_page=100`, undefined, `look up idempotency key on GitLab issue ${id}`);
    const hit = (json || []).find((n) => !n.system && (n.body || '').includes(marker));
    return hit ? { id: String(hit.id) } : null;
  }

  async function createBug({ title, body, priority, labels = [], idempotencyKey }) {
    const text = idempotencyKey ? `${body}\n\n${keyMarker(idempotencyKey)}` : body;
    const { json } = await call('POST', `${project}/issues`, { title: `[BUG] ${title}`, description: text, labels: ['bug', ...labels, ...priorityLabel(priority)].join(',') }, 'create GitLab bug');
    return { id: String(json.iid), url: json.web_url };
  }

  return { source: 'gitlab', fetchTicket, search, findByKey, createTest, link, comment, findCommentByKey, createBug };
}

module.exports = { create };
