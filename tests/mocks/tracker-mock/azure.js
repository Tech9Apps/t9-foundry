'use strict';
const { createCore } = require('./core');

// In-process mock of the slice of Azure DevOps work-item tracking the adapter uses.
// Approximation (documented): WIQL support is limited to `[Field] CONTAINS 'text'` conditions
// (treated as OR) plus an optional `[System.WorkItemType] = 'X'` filter (AND).
function createAzureMock({ pat = 'test-pat', org = 'acme', project = 'shop' } = {}) {
  const expected = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  const core = createCore({ checkAuth: (h) => h.authorization === expected });
  const state = { items: new Map(), comments: new Map(), created: [], seq: 100, commentSeq: 7000 };
  const baseUrl = 'https://dev.azure.test';
  const W = `/${org}/${project}/_apis/wit`;
  const htmlUrl = (id) => `${baseUrl}/${org}/${project}/_workitems/edit/${id}`;

  function seedItem({ type = 'User Story', fields = {}, relations = [] }) {
    const id = state.seq++;
    const created = new Date(Date.UTC(2026, 0, 2, 3, 4, 5) + (id - 100) * 1000).toISOString().replace('.000Z', 'Z'); // later items are created later
    state.items.set(id, {
      id, rev: 1, url: `${baseUrl}/${org}/${project}/_apis/wit/workItems/${id}`, _links: { html: { href: htmlUrl(id) } },
      fields: { 'System.WorkItemType': type, 'System.State': 'Active', 'System.AreaPath': `${project}\\Checkout`, 'System.IterationPath': `${project}\\Sprint 1`, 'Microsoft.VSTS.Common.Priority': 2, 'System.Tags': '', 'System.CreatedDate': created, ...fields },
      relations,
    });
    state.comments.set(id, []);
    return id;
  }
  const item = (id) => {
    const it = state.items.get(Number(id));
    if (!it) throw core.httpError(404, 'Work item not found', { message: `TF401232: Work item ${id} does not exist, or you do not have permissions to read it.` });
    return it;
  };
  const applyPatch = (it, ops) => {
    for (const op of ops) {
      if (op.path.startsWith('/fields/')) it.fields[op.path.slice('/fields/'.length)] = op.value;
      else if (op.path === '/relations/-') {
        if (it.relations.some((r) => r.rel === op.value.rel && r.url === op.value.url)) {
          throw core.httpError(400, 'Relation already exists', { message: 'VS403091: Relation already exists' });
        }
        it.relations.push({ rel: op.value.rel, url: op.value.url, attributes: {} });
      }
    }
    it.rev += 1;
  };

  core.route('GET', `${W}/workitems/:id`, ({ params }) => [200, item(params.id)]);
  core.route('GET', `${W}/workitems/:id/comments`, ({ params }) => {
    item(params.id);
    const comments = state.comments.get(Number(params.id));
    return [200, { totalCount: comments.length, comments }];
  });
  core.route('POST', `${W}/workitems/:id/comments`, ({ params, body }) => {
    item(params.id);
    if (!body || !body.text) throw core.httpError(400, 'text required', { message: 'VS402337: comment text is required' });
    const c = { id: state.commentSeq++, text: body.text, createdBy: { displayName: 'QA Bot' }, createdDate: '2026-01-02T03:04:05Z' };
    state.comments.get(Number(params.id)).push(c);
    return [200, c];
  });
  core.route('POST', `${W}/workitems/:type`, ({ params, body, call }) => {
    if (!String(call.headers['content-type'] || '').includes('json-patch+json')) {
      throw core.httpError(415, 'Unsupported media type', { message: 'The request must be application/json-patch+json' });
    }
    const type = params.type.replace(/^\$/, '');
    const ops = Array.isArray(body) ? body : [];
    if (!ops.some((o) => o.path === '/fields/System.Title' && o.value)) {
      throw core.httpError(400, 'Title required', { message: 'TF401320: Rule Error for field Title. Error code: Required' });
    }
    const id = seedItem({ type });
    applyPatch(state.items.get(id), ops);
    state.created.push(id);
    return [200, state.items.get(id)];
  });
  core.route('PATCH', `${W}/workitems/:id`, ({ params, body, call }) => {
    if (!String(call.headers['content-type'] || '').includes('json-patch+json')) throw core.httpError(415, 'Unsupported media type');
    applyPatch(item(params.id), Array.isArray(body) ? body : []);
    return [200, item(params.id)];
  });
  core.route('POST', `${W}/wiql`, ({ body }) => {
    const q = (body && body.query) || '';
    // Each `[Field] CONTAINS 'x'` is checked against THAT field only (as real WIQL does) — matching a blob of every
    // field would hide an adapter that searches the wrong one (bug bodies live in ReproSteps, not Description).
    const clauses = [...q.matchAll(/\[((?:System|Microsoft\.VSTS)\.[\w.]+)\] CONTAINS '((?:[^']|'')*)'/g)].map((m) => ({ field: m[1], needle: m[2].replace(/''/g, "'").toLowerCase() }));
    const type = (q.match(/\[System\.WorkItemType\] = '([^']+)'/) || [])[1];
    const hits = [...state.items.values()].filter((it) => (
      (!clauses.length || clauses.some((c) => String(it.fields[c.field] || '').toLowerCase().includes(c.needle)))
      && (!type || it.fields['System.WorkItemType'] === type)
    ));
    return [200, { workItems: hits.map((it) => ({ id: it.id })) }];
  });
  // Like the real API: only the fields that were ASKED for come back (plus the id). A mock that returned everything would let an adapter
  // forget to request a field and still pass.
  const only = (wi, fields) => (Array.isArray(fields) && fields.length ? { ...wi, fields: Object.fromEntries(Object.entries(wi.fields).filter(([k]) => fields.includes(k))) } : wi);
  core.route('POST', `${W}/workitemsbatch`, ({ body }) => [200, { count: (body.ids || []).length, value: (body.ids || []).map((id) => only(item(id), body.fields)) }]);

  const stripTags = (s = '') => String(s).replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  return {
    source: 'azure', fetch: core.fetch, inject: core.inject, calls: core.calls, state, baseUrl, pat,
    token: pat, settings: { organization: org, project }, tokenEnv: 'AZURE_DEVOPS_PAT',
    seedItem,
    seedTicket: ({ title, description = '', acceptance = '', comments = [] }) => {
      const id = seedItem({ fields: {
        'System.Title': title, 'System.Description': `<div>${description}</div>`,
        ...(acceptance ? { 'Microsoft.VSTS.Common.AcceptanceCriteria': `<div>${acceptance.replace(/\n/g, '<br>')}</div>` } : {}),
      } });
      for (const c of comments) state.comments.get(id).push({ id: state.commentSeq++, text: c.body, createdBy: { displayName: c.author }, createdDate: '2026-01-02T03:04:05Z' });
      return String(id);
    },
    createdItems: () => state.created.map((id) => {
      const f = state.items.get(id).fields;
      return { id: String(id), title: f['System.Title'], text: [f['System.Description'], f['Microsoft.VSTS.TCM.Steps'], f['Microsoft.VSTS.TCM.ReproSteps']].map(stripTags).join('\n') };
    }),
    setState: (id, st, reason) => { const w = state.items.get(Number(id)); w.fields['System.State'] = st; w.fields['System.Reason'] = reason; },
    closeItem: (id) => { const w = state.items.get(Number(id)); w.fields['System.State'] = 'Closed'; w.fields['System.Reason'] = 'Fixed'; },
    dismissItem: (id) => { const w = state.items.get(Number(id)); w.fields['System.State'] = 'Resolved'; w.fields['System.Reason'] = 'Will not Fix'; },
    commentsOn: (id) => state.comments.get(Number(id)).map((c) => c.text),
    paths: { create: '/workitems/\\$[^/]+$', search: '/wiql', ticket: '/workitems/\\d+(\\?|$)', link: '/workitems/\\d+(\\?|$)' },
    linkMethod: 'PATCH',
    searchMethod: 'POST', // WIQL is a POST, but a read
    missingId: '99999',
  };
}

module.exports = { createAzureMock };
