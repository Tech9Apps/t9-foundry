'use strict';

const { TrackerError } = require('../lib/errors');
const { checkBaseUrl } = require('../lib/base-url');
const { request } = require('../lib/http');
const { keyTag, keyMarker, hasMarker, hasTag, stripHtml, escapeXml, extractAcceptanceCriteria } = require('../lib/contract');

// Azure DevOps work-item tracking, REST 7.1, PAT auth.
// settings = qa-config.json > ticketSource.azure  ({ organization, project, host, tokenEnvVar })
//
// Idempotency keys are stored as a work-item TAG (`qa-key-<key>`), not in free text: tags are a
// first-class, queryable field in WIQL, whereas searching rich-text fields is slower and fuzzier.
const PRIORITY = { High: 1, Medium: 2, Low: 3 };
const JSON_PATCH = { 'Content-Type': 'application/json-patch+json' };

function create({ settings = {}, env = process.env, fetch, baseUrl, timeoutMs, retryDelayMs }) {
  const { organization, project } = settings;
  if (!organization || !project) throw new TrackerError('CONFIG', 'ticketSource.azure.organization and .project must be set');
  const tokenVar = settings.tokenEnvVar || 'AZURE_DEVOPS_PAT';
  const pat = env[tokenVar];
  if (!pat) throw new TrackerError('CONFIG', `${tokenVar} is not set`);

  const host = checkBaseUrl(baseUrl || settings.host || 'https://dev.azure.com', 'the Azure DevOps host');
  const root = `${host}/${encodeURIComponent(organization)}/${encodeURIComponent(project)}`;
  const wit = `${root}/_apis/wit`;
  const auth = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;

  const call = (method, url, body, what, extraHeaders = {}, idempotent = false) => request({
    fetch, method, url, body, timeoutMs, retryDelayMs, what, idempotent, headers: { Authorization: auth, ...extraHeaders },
  });
  const workItemUrl = (id) => {
    if (!/^\d+$/.test(String(id))) throw new TrackerError('VALIDATION', `Azure DevOps work item ids are numbers (got "${id}")`);
    return `${wit}/workitems/${id}`;
  };
  const htmlUrl = (wi) => (wi._links && wi._links.html && wi._links.html.href) || `${root}/_workitems/edit/${wi.id}`;
  const f = (wi, name) => (wi.fields || {})[name];
  const wiqlString = (s) => String(s).replace(/'/g, "''");
  const tail = (url = '') => url.split('/').pop();

  async function fetchTicket(id) {
    const { json: wi } = await call('GET', `${workItemUrl(id)}?$expand=all&api-version=7.1`, undefined, `fetch Azure DevOps work item ${id}`);
    const { json: c } = await call('GET', `${workItemUrl(id)}/comments?api-version=7.1-preview.3`, undefined, `fetch comments for work item ${id}`);
    // Bugs keep their body in Repro Steps, not Description; a ticket's "description" is whichever the item has
    const description = stripHtml(f(wi, 'System.Description') || f(wi, 'Microsoft.VSTS.TCM.ReproSteps') || '');
    const relations = wi.relations || [];
    return {
      source: 'azure',
      id: String(wi.id),
      url: htmlUrl(wi),
      title: f(wi, 'System.Title'),
      description,
      type: f(wi, 'System.WorkItemType') || '',
      status: f(wi, 'System.State') || '',
      priority: f(wi, 'Microsoft.VSTS.Common.Priority') === undefined ? '' : String(f(wi, 'Microsoft.VSTS.Common.Priority')),
      labels: String(f(wi, 'System.Tags') || '').split(';').map((t) => t.trim()).filter(Boolean),
      acceptanceCriteria: stripHtml(f(wi, 'Microsoft.VSTS.Common.AcceptanceCriteria') || '') || extractAcceptanceCriteria(description),
      attachments: relations.filter((r) => r.rel === 'AttachedFile').map((r) => ({ name: (r.attributes && r.attributes.name) || tail(r.url), url: r.url })),
      comments: ((c && c.comments) || []).map((x) => ({ author: x.createdBy && x.createdBy.displayName, body: stripHtml(x.text), created: x.createdDate })),
      subtasks: relations.filter((r) => r.rel === 'System.LinkTypes.Hierarchy-Forward').map((r) => ({ id: tail(r.url), title: '' })),
    };
  }

  async function runQuery(where, limit) {
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND ${where} ORDER BY [System.ChangedDate] DESC`;
    const { json } = await call('POST', `${wit}/wiql?$top=${limit}&api-version=7.1`, { query: wiql }, 'query Azure DevOps work items', {}, true);
    const ids = ((json && json.workItems) || []).map((w) => w.id).slice(0, limit);
    if (!ids.length) return [];
    const { json: batch } = await call('POST', `${wit}/workitemsbatch?api-version=7.1`, { ids, fields: ['System.Id', 'System.Title', 'System.State', 'System.Tags'] }, 'load Azure DevOps work items', {}, true);
    return batch.value || [];
  }

  // Resolved counts as closed: a defect that comes back after "resolved" is a regression, not a live report
  const AZ_CLOSED = /^(closed|done|removed|resolved)$/i;

  async function search({ query, kind = 'any', limit = 10 }) {
    const q = wiqlString(query);
    let where = `([System.Title] CONTAINS '${q}' OR [System.Description] CONTAINS '${q}')`;
    // createBug writes the body to Repro Steps, so that is where a fingerprint marker (or any body text) has to be found.
    // Only for bugs: the field does not exist in every process (Basic has no Bug type), and a WIQL clause on a missing field is an error.
    if (kind === 'bug') where = `([System.Title] CONTAINS '${q}' OR [System.Description] CONTAINS '${q}' OR [Microsoft.VSTS.TCM.ReproSteps] CONTAINS '${q}') AND [System.WorkItemType] = 'Bug'`;
    if (kind === 'test') where += " AND [System.WorkItemType] = 'Test Case'";
    const items = await runQuery(where, limit);
    return { items: items.map((wi) => ({ id: String(wi.id), title: f(wi, 'System.Title'), url: htmlUrl(wi), status: f(wi, 'System.State'), open: !AZ_CLOSED.test(f(wi, 'System.State') || '') })) };
  }

  async function findByKey(key) {
    // A tag query can also return items whose tag merely CONTAINS ours (qa-key-bug-10 for qa-key-bug-1), so ask for several and keep the exact one.
    const hits = await runQuery(`[System.Tags] CONTAINS '${wiqlString(keyTag(key))}'`, 20);
    const hit = hits.find((wi) => hasTag(f(wi, 'System.Tags'), key));
    return hit ? { id: String(hit.id), url: htmlUrl(hit) } : null;
  }

  const stepsXml = (steps) => `<steps id="0" last="${steps.length}">${steps.map((s, n) => (
    `<step id="${n + 1}" type="ActionStep"><parameterizedString isformatted="true">${escapeXml(s.action)}</parameterizedString>`
    + `<parameterizedString isformatted="true">${escapeXml(s.expected || '')}</parameterizedString><description/></step>`)).join('')}</steps>`;
  const html = (text) => `<div>${escapeXml(text).replace(/\n/g, '<br>')}</div>`;
  const add = (path, value) => ({ op: 'add', path: `/fields/${path}`, value });

  async function createTest({ parentId, tcId, title, description = '', priority, steps = [], idempotencyKey }) {
    // Test cases inherit area and iteration from the story they cover.
    const { json: parent } = await call('GET', `${workItemUrl(parentId)}?api-version=7.1`, undefined, `read parent work item ${parentId}`);
    const ops = [
      add('System.Title', `${tcId}: ${title}`),
      add('System.AreaPath', f(parent, 'System.AreaPath')),
      add('System.IterationPath', f(parent, 'System.IterationPath')),
      add('Microsoft.VSTS.Common.Priority', PRIORITY[priority] || 4),
      add('System.Description', html([description, `Tests work item ${parentId}`].filter(Boolean).join('\n\n'))),
    ];
    if (steps.length) ops.push(add('Microsoft.VSTS.TCM.Steps', stepsXml(steps)));
    if (idempotencyKey) ops.push(add('System.Tags', keyTag(idempotencyKey)));
    const { json } = await call('POST', `${wit}/workitems/$${encodeURIComponent('Test Case')}?api-version=7.1`, ops, `create Azure DevOps test case ${tcId}`, JSON_PATCH);
    return { id: String(json.id), url: htmlUrl(json) };
  }

  async function link({ childId, parentId }) {
    const relation = { rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: workItemUrl(parentId) };
    try {
      await call('PATCH', `${workItemUrl(childId)}?api-version=7.1`, [{ op: 'add', path: '/relations/-', value: relation }], `link work item ${childId} to ${parentId}`, JSON_PATCH);
    } catch (err) {
      // Linking twice is not a failure: the goal state (linked) already holds.
      if (!(err instanceof TrackerError && err.code === 'VALIDATION' && /already exists/i.test(err.message))) throw err;
    }
    return { linked: true, method: 'native' };
  }

  async function comment({ id, body, idempotencyKey }) {
    const text = idempotencyKey ? `${body}\n\n${keyMarker(idempotencyKey)}` : body;
    const { json } = await call('POST', `${workItemUrl(id)}/comments?api-version=7.1-preview.3`, { text }, `comment on work item ${id}`);
    return { id: String(json.id) };
  }

  // Comments (unlike work items) have no tag field, so the marker lives in the text.
  async function findCommentByKey(id, key) {
    const { json } = await call('GET', `${workItemUrl(id)}/comments?api-version=7.1-preview.3`, undefined, `look up idempotency key on work item ${id}`);
    const hit = ((json && json.comments) || []).find((c) => hasMarker(c.text, key));
    return hit ? { id: String(hit.id) } : null;
  }

  async function createBug({ title, body, priority, labels = [], idempotencyKey }) {
    const tags = [...labels, ...(idempotencyKey ? [keyTag(idempotencyKey)] : [])];
    const ops = [
      add('System.Title', title),
      add('Microsoft.VSTS.TCM.ReproSteps', html(body)),
      add('Microsoft.VSTS.Common.Priority', PRIORITY[priority] || 4),
    ];
    if (tags.length) ops.push(add('System.Tags', tags.join('; ')));
    const { json } = await call('POST', `${wit}/workitems/$Bug?api-version=7.1`, ops, 'create Azure DevOps bug', JSON_PATCH);
    return { id: String(json.id), url: htmlUrl(json) };
  }

  return { source: 'azure', fetchTicket, search, findByKey, createTest, link, comment, findCommentByKey, createBug };
}

module.exports = { create };
