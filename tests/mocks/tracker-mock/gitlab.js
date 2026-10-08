'use strict';
const { createCore } = require('./core');

// In-process mock of the slice of the GitLab v4 issues API the adapter uses.
function createGitlabMock({ token = 'glpat-test-token', projectId = '42' } = {}) {
  const core = createCore({ checkAuth: (h) => h['private-token'] === token });
  const state = { issues: new Map(), notes: new Map(), links: new Set(), created: [], nextIid: 1, nextNoteId: 800, nextGlobal: 5000 };
  const baseUrl = 'https://gitlab.test/api/v4';
  const P = '/api/v4/projects/:pid';
  const web = (iid) => `https://gitlab.test/acme/shop/-/issues/${iid}`;

  function seedIssue({ title, description = '', labels = [], user = 'qa-lead', st = 'opened' }) {
    const iid = state.nextIid++;
    state.issues.set(iid, { id: state.nextGlobal++, iid, project_id: Number(projectId), title, description, state: st, labels, web_url: web(iid), author: { username: user }, created_at: '2026-01-02T03:04:05Z', issue_type: 'issue' });
    state.notes.set(iid, []);
    return iid;
  }
  const inProject = (p) => { if (p.pid !== projectId) throw core.httpError(404, 'Project Not Found', { message: '404 Project Not Found' }); };
  const issue = (p) => {
    inProject(p);
    const i = state.issues.get(Number(p.iid));
    if (!i) throw core.httpError(404, 'Not found', { message: '404 Not found' });
    return i;
  };

  core.route('GET', P, ({ params }) => { inProject(params); return [200, { id: Number(projectId), path_with_namespace: 'acme/shop' }]; });
  core.route('GET', `${P}/issues`, ({ params, query }) => {
    inProject(params);
    const labels = (query.labels || '').split(',').filter(Boolean).map((l) => l.toLowerCase());
    const st = query.state || 'all';
    const needle = (query.search || '').toLowerCase();
    const per = Math.min(Number(query.per_page) || 20, 100);
    const page = Number(query.page) || 1;
    const all = [...state.issues.values()]
      .filter((i) => (st === 'all' || (st === 'opened' && i.state === 'opened') || i.state === st))
      .filter((i) => labels.every((l) => i.labels.some((x) => x.toLowerCase() === l)))
      .filter((i) => !needle || `${i.title}\n${i.description}`.toLowerCase().includes(needle))
      .sort((a, b) => (query.sort === 'asc' ? a.iid - b.iid : b.iid - a.iid));
    return [200, all.slice((page - 1) * per, page * per)];
  });
  core.route('GET', `${P}/issues/:iid`, ({ params }) => [200, issue(params)]);
  core.route('GET', `${P}/issues/:iid/notes`, ({ params }) => { issue(params); return [200, state.notes.get(Number(params.iid))]; });
  core.route('POST', `${P}/issues`, ({ params, body }) => {
    inProject(params);
    if (!body || !body.title) throw core.httpError(400, 'title missing', { message: { title: ["can't be blank"] } });
    const labels = typeof body.labels === 'string' ? body.labels.split(',').filter(Boolean) : (body.labels || []);
    const iid = seedIssue({ title: body.title, description: body.description || '', labels, user: 'qa-bot' });
    state.created.push(iid);
    return [201, state.issues.get(iid)];
  });
  core.route('POST', `${P}/issues/:iid/notes`, ({ params, body }) => {
    issue(params);
    if (!body || !body.body) throw core.httpError(400, 'body missing', { message: { body: ["can't be blank"] } });
    const n = { id: state.nextNoteId++, body: body.body, author: { username: 'qa-bot' }, created_at: '2026-01-02T03:04:06Z', system: false };
    state.notes.get(Number(params.iid)).push(n);
    return [201, n];
  });
  core.route('POST', `${P}/issues/:iid/links`, ({ params, body }) => {
    issue(params);
    if (!state.issues.get(Number(body && body.target_issue_iid))) throw core.httpError(404, 'Not found', { message: '404 Issue Not Found' });
    const key = `${params.iid}->${body.target_issue_iid}`;
    if (state.links.has(key)) throw core.httpError(409, 'conflict', { message: 'Issue(s) already assigned' });
    state.links.add(key);
    return [201, { link_type: 'relates_to', source_issue: state.issues.get(Number(params.iid)), target_issue: state.issues.get(Number(body.target_issue_iid)) }];
  });

  return {
    source: 'gitlab', fetch: core.fetch, inject: core.inject, calls: core.calls, state, baseUrl, token,
    settings: { projectId }, tokenEnv: 'GITLAB_TOKEN',
    seedIssue,
    seedTicket: ({ title, description = '', acceptance = '', labels = [], comments = [] }) => {
      const iid = seedIssue({ title, description: acceptance ? `${description}\n\n## Acceptance Criteria\n${acceptance}\n` : description, labels });
      for (const c of comments) state.notes.get(iid).push({ id: state.nextNoteId++, body: c.body, author: { username: c.author }, created_at: '2026-01-02T03:04:07Z', system: false });
      return String(iid);
    },
    createdItems: () => state.created.map((iid) => ({ id: String(iid), title: state.issues.get(iid).title, text: state.issues.get(iid).description })),
    closeItem: (id) => { state.issues.get(Number(id)).state = 'closed'; },
    commentsOn: (id) => state.notes.get(Number(id)).map((n) => n.body),
    paths: { create: '/issues$', search: '/issues', ticket: '/issues/\\d+(\\?|$)', link: '/links' },
    linkMethod: 'POST',
    missingId: '99999',
  };
}

module.exports = { createGitlabMock };
