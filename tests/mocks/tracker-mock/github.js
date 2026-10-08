'use strict';
const { createCore } = require('./core');

// In-process mock of the slice of the GitHub REST API the adapter uses.
function createGithubMock({ token = 'test-token', repo = 'acme/shop' } = {}) {
  const core = createCore({ checkAuth: (h) => h.authorization === `Bearer ${token}` });
  const state = { issues: new Map(), comments: new Map(), created: [], nextNumber: 1, nextCommentId: 9000, rateLimited: false };
  const [owner, name] = repo.split('/');
  const html = (n) => `https://github.test/${repo}/issues/${n}`;

  function seedIssue({ title, body = '', labels = [], user = 'qa-lead', state: st = 'open' }) {
    const number = state.nextNumber++;
    state.issues.set(number, {
      number, title, body, state: st, user: { login: user }, html_url: html(number),
      labels: labels.map((l) => ({ name: l })), created_at: '2026-01-02T03:04:05Z',
    });
    state.comments.set(number, []);
    return number;
  }

  const inRepo = (p) => {
    if (p.owner !== owner || p.repo !== name) throw core.httpError(404, 'Not Found');
  };
  const getIssue = (p) => {
    inRepo(p);
    const issue = state.issues.get(Number(p.number));
    if (!issue) throw core.httpError(404, 'Not Found');
    return issue;
  };

  core.route('GET', '/repos/:owner/:repo/issues/:number', ({ params }) => [200, getIssue(params)]);
  core.route('GET', '/repos/:owner/:repo/issues/:number/comments', ({ params }) => {
    getIssue(params);
    return [200, state.comments.get(Number(params.number))];
  });
  core.route('POST', '/repos/:owner/:repo/issues', ({ params, body }) => {
    inRepo(params);
    if (!body || !body.title) throw core.httpError(422, 'Validation Failed', { message: 'Validation Failed', errors: [{ field: 'title', code: 'missing_field' }] });
    const number = seedIssue({ title: body.title, body: body.body || '', labels: body.labels || [], user: 'qa-bot' });
    state.created.push(number);
    return [201, state.issues.get(number)];
  });
  core.route('POST', '/repos/:owner/:repo/issues/:number/comments', ({ params, body }) => {
    getIssue(params);
    if (!body || !body.body) throw core.httpError(422, 'Validation Failed');
    const comment = { id: state.nextCommentId++, user: { login: 'qa-bot' }, body: body.body, created_at: '2026-01-02T03:04:06Z', html_url: `${html(params.number)}#issuecomment-${state.nextCommentId}` };
    state.comments.get(Number(params.number)).push(comment);
    return [201, comment];
  });
  core.route('GET', '/search/issues', ({ query }) => {
    if (state.rateLimited) throw core.httpError(403, 'API rate limit exceeded', { message: 'API rate limit exceeded for user' });
    const q = query.q || '';
    const wantRepo = (q.match(/repo:(\S+)/) || [])[1];
    if (wantRepo && wantRepo !== repo) return [200, { total_count: 0, items: [] }];
    const labels = [...q.matchAll(/label:"?([^"\s]+)"?/g)].map((m) => m[1].toLowerCase());
    const text = q.replace(/\b(repo|label|is|in):("[^"]*"|\S+)/g, '').replace(/"/g, '').trim().toLowerCase();
    const items = [...state.issues.values()].filter((i) => {
      const haystack = `${i.title}\n${i.body}`.toLowerCase();
      const have = i.labels.map((l) => l.name.toLowerCase());
      return (!text || haystack.includes(text)) && labels.every((l) => have.includes(l));
    });
    return [200, { total_count: items.length, items: items.slice(0, Number(query.per_page) || 30) }];
  });

  // ── The interface the shared contract suite (tests/tracker/contract-suite.js) relies on ──
  function seedTicket({ title, description = '', acceptance = '', labels = [], comments = [] }) {
    const body = acceptance ? `${description}\n\n## Acceptance Criteria\n${acceptance}\n` : description;
    const number = seedIssue({ title, body, labels });
    for (const c of comments) {
      state.comments.get(number).push({ id: state.nextCommentId++, user: { login: c.author }, body: c.body, created_at: '2026-01-02T03:04:07Z' });
    }
    return String(number);
  }

  return {
    source: 'github', fetch: core.fetch, inject: core.inject, calls: core.calls, state, seedIssue, repo, token, baseUrl: 'https://api.github.test',
    settings: { repo },
    seedTicket,
    tokenEnv: 'GITHUB_TOKEN',
    createdItems: () => state.created.map((n) => ({ id: String(n), title: state.issues.get(n).title, text: state.issues.get(n).body })),
    commentsOn: (id) => state.comments.get(Number(id)).map((c) => c.body),
    // regex sources for fault injection
    paths: { create: '/issues$', search: '/search/issues', ticket: '/issues/\\d+$' },
    missingId: '99999',
  };
}

module.exports = { createGithubMock };
