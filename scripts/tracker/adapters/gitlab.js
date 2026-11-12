'use strict';

const { TrackerError } = require('../lib/errors');
const { checkBaseUrl } = require('../lib/base-url');
const { hasMarker, extractAcceptanceCriteria } = require('../lib/contract');
const { withMarker, requireNumericId, requireToken, testCaseBody, priorityFromLabels, summary, isDuplicateLink, eachPage, apiCall } = require('../lib/kit');
const { findInPages, PAGE_SIZE } = require('../lib/paging');

// GitLab Issues, REST v4, personal/project access token.
// settings = qa-config.json > ticketSource.gitlab  ({ projectId, host, tokenEnvVar, testLabelName })
// Items are addressed by their project-scoped number (`iid`), which is the number users see.

function create({ settings = {}, env = process.env, fetch, baseUrl, timeoutMs, retryDelayMs }) {
  const projectId = settings.projectId;
  if (!projectId) throw new TrackerError('CONFIG', 'ticketSource.gitlab.projectId is not set');
  const token = requireToken({ settings, env, defaultVar: 'GITLAB_TOKEN' });
  // `baseUrl` overrides the whole API root (mocks); otherwise <host>/api/v4
  const api = checkBaseUrl(baseUrl || `${(settings.host || 'https://gitlab.com').replace(/\/$/, '')}/api/v4`, 'the GitLab API URL', { hosts: ['gitlab.com'], env });
  const testLabel = settings.testLabelName || 'test-case';
  const project = `/projects/${encodeURIComponent(projectId)}`;

  const call = apiCall({ fetch, base: api, timeoutMs, retryDelayMs, headers: { 'PRIVATE-TOKEN': token } });

  const issuePath = (id) => `${project}/issues/${requireNumericId('GitLab issue', id)}`;
  // GitLab has no "won't fix" resolution, so the team's own labels are the only signal: a closed issue carrying one of these was dismissed.
  const DISMISS_LABEL = /^(?:wontfix|won't fix|invalid|duplicate|not a bug)$/i;
  const dismissedIssue = (i) => i.state === 'closed' && (i.labels || []).some((l) => DISMISS_LABEL.test(typeof l === 'string' ? l : l.title || l.name || ''));
  const summarize = (i) => summary({ id: i.iid, title: i.title, url: i.web_url, status: i.state, open: i.state === 'opened', createdAt: i.created_at, dismissed: dismissedIssue(i) });
  const priorityLabel = (p) => (p ? [`priority:${p}`] : []);

  async function fetchTicket(id) {
    const { json: issue } = await call('GET', issuePath(id), undefined, `fetch GitLab issue ${id}`);
    const { json: notes } = await call('GET', `${issuePath(id)}/notes?sort=asc&order_by=created_at&per_page=100`, undefined, `fetch notes for GitLab issue ${id}`);
    const labels = issue.labels || [];
    const priority = priorityFromLabels(labels);
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
    const labels = op === 'create-test' ? [testLabel, String(input.parentId)] : op === 'create-bug' ? ['bug'] : [];
    const listPage = async (page) => {
      const qs = `state=all&order_by=created_at&sort=desc&per_page=100&page=${page}${labels.length ? `&labels=${encodeURIComponent(labels.join(','))}` : ''}`;
      return (await call('GET', `${project}/issues?${qs}`, undefined, 'look up idempotency key')).json;
    };
    for await (const batch of eachPage(listPage)) {
      const hit = batch.find((i) => hasMarker(i.description, key));
      if (hit) return { id: String(hit.iid), url: hit.web_url };
    }
    return null;
  }

  async function createTest({ parentId, tcId, title, description = '', priority, steps = [], idempotencyKey }) {
    const body = withMarker(testCaseBody({ parentId, priority, description, steps }), idempotencyKey);
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
    issuePath(parentId); // both ends are issue numbers: refused here, before a request, instead of becoming target_issue_iid: null
    const targetProject = await resolveProjectId();
    try {
      await call('POST', `${issuePath(childId)}/links`, { target_project_id: targetProject, target_issue_iid: Number(parentId), link_type: 'relates_to' }, `link GitLab issue ${childId} to ${parentId}`);
    } catch (err) {
      if (!isDuplicateLink(err, /already assigned|already exists/i)) throw err;
    }
    return { linked: true, method: 'native' };
  }

  async function comment({ id, body, idempotencyKey }) {
    const { json } = await call('POST', `${issuePath(id)}/notes`, { body: withMarker(body, idempotencyKey) }, `comment on GitLab issue ${id}`);
    return { id: String(json.id) };
  }

  async function findCommentByKey(id, key) {
    const hit = await findInPages(async (page) => {
      const { json } = await call('GET', `${issuePath(id)}/notes?sort=asc&order_by=created_at&per_page=${PAGE_SIZE}&page=${page}`, undefined, `look up idempotency key on GitLab issue ${id}`);
      return { items: json || [], more: (json || []).length >= PAGE_SIZE };
    }, (n) => !n.system && hasMarker(n.body, key), `look up idempotency key on GitLab issue ${id}`);
    return hit ? { id: String(hit.id) } : null;
  }

  async function createBug({ title, body, priority, labels = [], idempotencyKey }) {
    const { json } = await call('POST', `${project}/issues`, { title: `[BUG] ${title}`, description: withMarker(body, idempotencyKey), labels: ['bug', ...labels, ...priorityLabel(priority)].join(',') }, 'create GitLab bug');
    return { id: String(json.iid), url: json.web_url };
  }

  return { source: 'gitlab', fetchTicket, search, findByKey, createTest, link, comment, findCommentByKey, createBug };
}

module.exports = { create };
