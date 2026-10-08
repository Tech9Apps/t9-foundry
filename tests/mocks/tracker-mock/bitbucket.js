'use strict';
const { createCore } = require('./core');

// In-process mock of the slice of the Bitbucket Cloud 2.0 issue tracker the adapter uses, including a
// small BBQL evaluator: field = "x", field != "x", field ~ "x" (case-insensitive contains), AND, OR, ( ).
function evaluateBbql(q, issue) {
  const tokens = [...q.matchAll(/\(|\)|"(?:[^"\\]|\\.)*"|!=|~|=|[A-Za-z_.]+/g)].map((m) => m[0]);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const value = (field) => ({ kind: issue.kind, title: issue.title, state: issue.state, 'content.raw': (issue.content && issue.content.raw) || '' })[field];
  function atom() {
    if (peek() === '(') { next(); const r = or(); next(); return r; }
    const field = next(); const op = next(); const raw = next();
    const want = raw.slice(1, -1).replace(/\\(.)/g, '$1');
    const have = String(value(field) ?? '');
    if (op === '=') return have === want;
    if (op === '!=') return have !== want;
    return have.toLowerCase().includes(want.toLowerCase());
  }
  function and() { let r = atom(); while (peek() === 'AND') { next(); const b = atom(); r = r && b; } return r; }
  function or() { let r = and(); while (peek() === 'OR') { next(); const b = and(); r = r || b; } return r; }
  return or();
}

function createBitbucketMock({ secret = 'app-password', username = 'qa-bot', workspace = 'acme', repo = 'shop' } = {}) {
  const expected = `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}`;
  const core = createCore({ checkAuth: (h) => h.authorization === expected });
  const state = { issues: new Map(), comments: new Map(), created: [], nextId: 1, nextCommentId: 300 };
  const baseUrl = 'https://bitbucket.test/2.0';
  const R = '/2.0/repositories/:ws/:repo/issues';
  const html = (id) => `https://bitbucket.test/${workspace}/${repo}/issues/${id}`;
  const err = (status, message) => core.httpError(status, message, { type: 'error', error: { message } });

  function seedIssue({ title, raw = '', kind = 'task', priority = 'minor' }) {
    const id = state.nextId++;
    state.issues.set(id, { id, title, content: { raw, markup: 'markdown' }, kind, priority, state: 'new', reporter: { display_name: 'QA Lead' }, created_on: `2026-01-02T03:04:${String(id % 60).padStart(2, '0')}Z`, links: { html: { href: html(id) } } });
    state.comments.set(id, []);
    return id;
  }
  const inRepo = (p) => { if (p.ws !== workspace || p.repo !== repo) throw err(404, 'Repository not found'); };
  const issue = (p) => { inRepo(p); const i = state.issues.get(Number(p.id)); if (!i) throw err(404, 'Not Found'); return i; };

  core.route('GET', R, ({ params, query }) => {
    inRepo(params);
    const per = Math.min(Number(query.pagelen) || 10, 100);
    const page = Number(query.page) || 1;
    let all = [...state.issues.values()].filter((i) => !query.q || evaluateBbql(query.q, i));
    all = all.sort((a, b) => (query.sort === '-created_on' ? b.id - a.id : a.id - b.id));
    const values = all.slice((page - 1) * per, page * per);
    return [200, { size: all.length, page, pagelen: per, values, ...(page * per < all.length ? { next: `${baseUrl}/repositories/${workspace}/${repo}/issues?page=${page + 1}` } : {}) }];
  });
  core.route('GET', `${R}/:id`, ({ params }) => [200, issue(params)]);
  core.route('GET', `${R}/:id/comments`, ({ params }) => { issue(params); const v = state.comments.get(Number(params.id)); return [200, { size: v.length, page: 1, pagelen: 100, values: v }]; });
  core.route('POST', R, ({ params, body }) => {
    inRepo(params);
    if (!body || !body.title) throw err(400, 'title: This field is required.');
    if (body.priority && !['trivial', 'minor', 'major', 'critical', 'blocker'].includes(body.priority)) throw err(400, 'priority: invalid');
    const id = seedIssue({ title: body.title, raw: (body.content && body.content.raw) || '', kind: body.kind || 'bug', priority: body.priority || 'major' });
    state.created.push(id);
    return [201, state.issues.get(id)];
  });
  core.route('POST', `${R}/:id/comments`, ({ params, body }) => {
    issue(params);
    if (!body || !body.content || !body.content.raw) throw err(400, 'content: This field is required.');
    const c = { id: state.nextCommentId++, content: { raw: body.content.raw }, user: { display_name: 'QA Bot' }, created_on: '2026-01-02T03:04:06Z', deleted: false, links: { html: { href: `${html(params.id)}#comment-${state.nextCommentId}` } } };
    state.comments.get(Number(params.id)).push(c);
    return [201, c];
  });

  return {
    source: 'bitbucket', fetch: core.fetch, inject: core.inject, calls: core.calls, state, baseUrl, token: secret,
    settings: { workspace, repo, username }, tokenEnv: 'BITBUCKET_TOKEN',
    seedIssue,
    seedTicket: ({ title, description = '', acceptance = '', comments = [] }) => {
      const id = seedIssue({ title, raw: acceptance ? `${description}\n\n## Acceptance Criteria\n${acceptance}\n` : description });
      for (const c of comments) state.comments.get(id).push({ id: state.nextCommentId++, content: { raw: c.body }, user: { display_name: c.author }, created_on: '2026-01-02T03:04:07Z', deleted: false });
      return String(id);
    },
    createdItems: () => state.created.map((id) => ({ id: String(id), title: state.issues.get(id).title, text: state.issues.get(id).content.raw })),
    commentsOn: (id) => state.comments.get(Number(id)).map((c) => c.content.raw),
    paths: { create: '/issues$', search: '/issues', ticket: '/issues/\\d+(\\?|$)' },
    missingId: '99999',
  };
}

module.exports = { createBitbucketMock, evaluateBbql };
