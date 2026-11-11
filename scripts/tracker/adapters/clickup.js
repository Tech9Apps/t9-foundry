'use strict';

const { TrackerError } = require('../lib/errors');
const { checkBaseUrl } = require('../lib/base-url');
const { request } = require('../lib/http');
const { keyMarker, hasMarker, extractAcceptanceCriteria } = require('../lib/contract');

// ClickUp v2 REST API.
// settings = qa-config.json > ticketSource.clickup  ({ listId, tokenEnvVar, assignToSelf, apiBaseUrl })
const PRIORITY = { High: 1, Medium: 2, Low: 3 }; // ClickUp: 1 urgent … 4 low; unspecified -> 4
const MAX_PAGES = 5;

function create({ settings = {}, env = process.env, fetch, baseUrl, timeoutMs, retryDelayMs }) {
  const listId = settings.listId;
  if (!listId) throw new TrackerError('CONFIG', 'ticketSource.clickup.listId is not set');
  const tokenVar = settings.tokenEnvVar || 'CLICKUP_TOKEN';
  const token = env[tokenVar];
  if (!token) throw new TrackerError('CONFIG', `${tokenVar} is not set`);
  const base = checkBaseUrl(baseUrl || settings.apiBaseUrl || 'https://api.clickup.com/api/v2', 'the ClickUp API base URL', { hosts: ['api.clickup.com'], env });

  const call = (method, path, body, what) => request({
    fetch, method, url: `${base}${path}`, body, timeoutMs, retryDelayMs, what,
    headers: { Authorization: token }, // ClickUp takes the raw token, no "Bearer"
  });

  const taskPath = (id) => {
    if (!/^[A-Za-z0-9_-]+$/.test(String(id))) throw new TrackerError('VALIDATION', `"${id}" is not a valid ClickUp task id`);
    return `/task/${id}`;
  };
  const summarize = (t) => ({ id: String(t.id), title: t.name, url: t.url, status: t.status && t.status.status });
  const iso = (ms) => (/^\d+$/.test(String(ms)) ? new Date(Number(ms)).toISOString() : null);

  async function fetchTicket(id) {
    const { json: t } = await call('GET', `${taskPath(id)}?include_subtasks=true`, undefined, `fetch ClickUp task ${id}`);
    const { json: c } = await call('GET', `${taskPath(id)}/comment`, undefined, `fetch comments for ClickUp task ${id}`);
    const description = t.text_content || t.description || '';
    return {
      source: 'clickup',
      id: String(t.id),
      url: t.url,
      title: t.name,
      description,
      type: 'Task', // ClickUp has no native issue type
      status: (t.status && t.status.status) || '',
      priority: (t.priority && t.priority.priority) || '',
      labels: (t.tags || []).map((x) => x.name),
      acceptanceCriteria: extractAcceptanceCriteria(description),
      attachments: (t.attachments || []).map((a) => ({ name: a.title, url: a.url })),
      comments: ((c && c.comments) || []).map((x) => ({ author: x.user && x.user.username, body: x.comment_text, created: iso(x.date) })),
      subtasks: (t.subtasks || []).map((s) => ({ id: String(s.id), title: s.name })),
    };
  }

  async function listTasks() {
    const tasks = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { json } = await call('GET', `/list/${listId}/task?include_closed=true&page=${page}`, undefined, 'list ClickUp tasks');
      const batch = (json && json.tasks) || [];
      tasks.push(...batch);
      if (batch.length < 100) break;
    }
    return tasks;
  }

  async function search({ query, kind = 'any', limit = 10 }) {
    const q = query.toLowerCase();
    const items = (await listTasks())
      .filter((t) => `${t.name}\n${t.text_content || t.description || ''}`.toLowerCase().includes(q))
      .filter((t) => (kind === 'bug' ? t.name.startsWith('[BUG]') : kind === 'test' ? /^TC-/.test(t.name) : true))
      .slice(0, limit)
      .map(summarize);
    return { items };
  }

  async function findByKey(key) {
    const hit = (await listTasks()).find((t) => hasMarker(t.description || t.text_content, key));
    return hit ? { id: String(hit.id), url: hit.url } : null;
  }

  const withMarker = (text, key) => (key ? `${text}\n\n${keyMarker(key)}` : text);

  async function createTest({ parentId, tcId, title, description = '', priority, steps = [], idempotencyKey }) {
    const assignees = [];
    if (settings.assignToSelf !== false) {
      const { json } = await call('GET', '/user', undefined, 'look up the current ClickUp user');
      if (json && json.user) assignees.push(json.user.id);
    }
    const { json: created } = await call('POST', `/list/${listId}/task`, {
      name: `${tcId}: ${title}`,
      description: withMarker([description, `Tests: ${parentId}`].filter(Boolean).join('\n\n'), idempotencyKey),
      priority: PRIORITY[priority] || 4,
      assignees,
    }, `create ClickUp test task ${tcId}`);
    const id = String(created.id);

    if (steps.length) {
      try {
        const { json: cl } = await call('POST', `/task/${id}/checklist`, { name: 'Test Steps' }, `add steps checklist to ${id}`);
        for (const s of steps) {
          await call('POST', `/checklist/${cl.checklist.id}/checklist_item`, { name: `${s.action}${s.expected ? ` — Expected: ${s.expected}` : ''}` }, `add a step to ${id}`);
        }
      } catch (err) {
        if (!(err instanceof TrackerError)) throw err;
        // The task exists but its steps are incomplete: say so, and say which task.
        throw new TrackerError(err.code, `${err.message} — task ${id} was created but its steps were not fully added`, { status: err.status, details: { partial: { id, url: created.url, completed: 'task' } } });
      }
    }
    return { id, url: created.url };
  }

  // Finish a test task a previous attempt left half-built (see createOnce in adapters/index.js).
  async function completeTest(existing, { steps = [] }) {
    if (!steps.length) return existing;
    const { json: t } = await call('GET', taskPath(existing.id), undefined, `check steps on ClickUp task ${existing.id}`);
    const checklist = (t.checklists || []).find((c) => c.name === 'Test Steps');
    const have = checklist ? (checklist.items || []).length : 0;
    if (have >= steps.length) return existing;

    let checklistId = checklist && checklist.id;
    if (!checklistId) {
      const { json } = await call('POST', `/task/${existing.id}/checklist`, { name: 'Test Steps' }, `add steps checklist to ${existing.id}`);
      checklistId = json.checklist.id;
    }
    for (const s of steps.slice(have)) {
      await call('POST', `/checklist/${checklistId}/checklist_item`, { name: `${s.action}${s.expected ? ` — Expected: ${s.expected}` : ''}` }, `add a step to ${existing.id}`);
    }
    return { ...existing, repaired: true };
  }

  async function link({ childId, parentId }) {
    await call('POST', `${taskPath(childId)}/link/${String(parentId)}`, undefined, `link ClickUp task ${childId} to ${parentId}`);
    return { linked: true, method: 'native' };
  }

  async function comment({ id, body, idempotencyKey }) {
    const { json } = await call('POST', `${taskPath(id)}/comment`, { comment_text: withMarker(body, idempotencyKey) }, `comment on ClickUp task ${id}`);
    return { id: String(json.id) };
  }

  async function findCommentByKey(id, key) {
    const { json } = await call('GET', `${taskPath(id)}/comment`, undefined, `look up idempotency key on ClickUp task ${id}`);
    const hit = ((json && json.comments) || []).find((c) => hasMarker(c.comment_text, key));
    return hit ? { id: String(hit.id) } : null;
  }

  async function createBug({ title, body, priority, labels = [], idempotencyKey }) {
    const { json } = await call('POST', `/list/${listId}/task`, {
      name: `[BUG] ${title}`, description: withMarker(body, idempotencyKey), priority: PRIORITY[priority] || 4, tags: labels,
    }, 'create ClickUp bug');
    return { id: String(json.id), url: json.url };
  }

  return { source: 'clickup', fetchTicket, search, findByKey, createTest, completeTest, link, comment, findCommentByKey, createBug };
}

module.exports = { create };
