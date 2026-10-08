'use strict';
const { createCore } = require('./core');

// In-process mock of the slice of the ClickUp v2 API the adapter uses.
function createClickupMock({ token = 'pk_test_token', listId = '9001' } = {}) {
  const core = createCore({ checkAuth: (h) => h.authorization === token });
  const state = { tasks: new Map(), comments: new Map(), checklists: new Map(), links: [], created: [], seq: 1, commentSeq: 500, user: { id: 183, username: 'qa-bot' } };
  const baseUrl = 'https://api.clickup.test/api/v2';
  const P = '/api/v2';

  function seedTask({ name, description = '', tags = [], status = 'to do', priority = null, parent = null, attachments = [] }) {
    const id = `86a${String(state.seq++).padStart(5, '0')}`;
    state.tasks.set(id, {
      id, name, text_content: description, description, status: { status }, priority: priority ? { priority } : null,
      tags: tags.map((t) => ({ name: t })), parent, attachments, url: `https://app.clickup.test/t/${id}`, list: { id: listId }, assignees: [],
    });
    state.comments.set(id, []);
    return id;
  }
  const task = (id) => {
    const t = state.tasks.get(id);
    if (!t) throw core.httpError(404, 'Task not found', { err: 'Task not found', ECODE: 'ITEM_015' });
    return t;
  };

  core.route('GET', `${P}/user`, () => [200, { user: state.user }]);
  core.route('GET', `${P}/task/:id`, ({ params, query }) => {
    const t = task(params.id);
    const out = { ...t, checklists: [...state.checklists.values()].filter((c) => c.task === t.id) };
    if (query.include_subtasks === 'true') out.subtasks = [...state.tasks.values()].filter((s) => s.parent === t.id);
    return [200, out];
  });
  core.route('GET', `${P}/task/:id/comment`, ({ params }) => { task(params.id); return [200, { comments: state.comments.get(params.id) }]; });
  core.route('POST', `${P}/task/:id/comment`, ({ params, body }) => {
    task(params.id);
    if (!body || !body.comment_text) throw core.httpError(400, 'comment_text required', { err: 'Comment text required', ECODE: 'COMMENT_001' });
    const c = { id: state.commentSeq++, comment_text: body.comment_text, user: state.user, date: String(Date.UTC(2026, 0, 2)) };
    state.comments.get(params.id).push(c);
    return [200, { id: c.id, hist_id: 'h1', date: Date.UTC(2026, 0, 2) }];
  });
  core.route('GET', `${P}/list/:listId/task`, ({ params, query }) => {
    if (params.listId !== listId) throw core.httpError(404, 'List not found', { err: 'List not found' });
    const all = [...state.tasks.values()];
    const page = Number(query.page || 0);
    const size = state.pageSize || 100;
    return [200, { tasks: all.slice(page * size, (page + 1) * size) }];
  });
  core.route('POST', `${P}/list/:listId/task`, ({ params, body }) => {
    if (params.listId !== listId) throw core.httpError(404, 'List not found', { err: 'List not found' });
    if (!body || !body.name) throw core.httpError(400, 'name required', { err: 'Task name required' });
    const id = seedTask({ name: body.name, description: body.description || '', tags: body.tags || [], priority: body.priority ? String(body.priority) : null });
    state.tasks.get(id).assignees = (body.assignees || []).map((a) => ({ id: a }));
    state.tasks.get(id).priorityNum = body.priority;
    state.created.push(id);
    return [200, state.tasks.get(id)];
  });
  core.route('POST', `${P}/task/:id/checklist`, ({ params, body }) => {
    task(params.id);
    const cid = `cl${state.checklists.size + 1}`;
    state.checklists.set(cid, { id: cid, task: params.id, name: body && body.name, items: [] });
    return [200, { checklist: state.checklists.get(cid) }];
  });
  core.route('POST', `${P}/checklist/:cid/checklist_item`, ({ params, body }) => {
    const cl = state.checklists.get(params.cid);
    if (!cl) throw core.httpError(404, 'Checklist not found', { err: 'Checklist not found' });
    cl.items.push({ name: body && body.name });
    return [200, { checklist: cl }];
  });
  core.route('POST', `${P}/task/:id/link/:linksTo`, ({ params }) => {
    task(params.id); task(params.linksTo);
    state.links.push([params.id, params.linksTo]);
    return [200, { task: state.tasks.get(params.id) }];
  });

  // ── Interface for the shared contract suite ──
  return {
    source: 'clickup', fetch: core.fetch, inject: core.inject, calls: core.calls, state, token, baseUrl,
    settings: { listId }, tokenEnv: 'CLICKUP_TOKEN', listId,
    seedTicket: ({ title, description = '', acceptance = '', comments = [] }) => {
      const id = seedTask({ name: title, description: acceptance ? `${description}\n\nAcceptance Criteria:\n${acceptance}\n` : description });
      for (const c of comments) state.comments.get(id).push({ id: state.commentSeq++, comment_text: c.body, user: { username: c.author }, date: String(Date.UTC(2026, 0, 2)) });
      return id;
    },
    seedTask,
    createdItems: () => state.created.map((id) => {
      const t = state.tasks.get(id);
      const items = [...state.checklists.values()].filter((c) => c.task === id).flatMap((c) => c.items.map((i) => i.name));
      return { id, title: t.name, text: [t.description, ...items].join('\n') };
    }),
    commentsOn: (id) => state.comments.get(id).map((c) => c.comment_text),
    paths: { create: '/list/[^/]+/task$', search: '/list/[^/]+/task', ticket: '/task/[^/]+$' },
    missingId: '86zzzzzz',
  };
}

module.exports = { createClickupMock };
