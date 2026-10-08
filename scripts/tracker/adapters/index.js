'use strict';

const { TrackerError } = require('../lib/errors');
const { validate } = require('../lib/contract');

// Jira joins this list once the headless-Jira approach is decided; GitLab/Bitbucket follow.
const ADAPTERS = {
  github: () => require('./github'),
  clickup: () => require('./clickup'),
  azure: () => require('./azure'),
};
const SUPPORTED = Object.keys(ADAPTERS);

function createAdapter(type, opts) {
  if (!ADAPTERS[type]) {
    throw new TrackerError('CONFIG', `no tracker adapter for "${type}" yet (available: ${SUPPORTED.join(', ')})`);
  }
  return ADAPTERS[type]().create(opts);
}

// Create-style operations honour `idempotencyKey`: look for an item already carrying the key
// and return it (deduplicated: true) instead of creating a second one.
//
// `complete(existing)` is for creates that take several calls (ClickUp: task, then checklist, then
// items). If an earlier attempt died part-way, the item exists but is half-built; returning it as
// "done" would silently accept a test case with no steps. `complete` finishes the job.
async function createOnce(adapter, input, create, complete) {
  if (input.idempotencyKey) {
    const existing = await adapter.findByKey(input.idempotencyKey);
    if (existing) return { ...(complete ? await complete(existing) : existing), deduplicated: true };
  }
  return { ...(await create()), deduplicated: false };
}

// The single entry point: validate, dispatch, return the normalized result.
async function run(adapter, op, rawInput) {
  const input = validate(op, rawInput);
  switch (op) {
    case 'fetch': return adapter.fetchTicket(String(input.id));
    case 'search': return adapter.search(input);
    case 'create-test': return createOnce(adapter, input, () => adapter.createTest(input), adapter.completeTest && ((existing) => adapter.completeTest(existing, input)));
    case 'link': return adapter.link(input);
    case 'comment': return adapter.comment(input);
    case 'create-bug': return createOnce(adapter, input, () => adapter.createBug(input));
    default: throw new TrackerError('VALIDATION', `unknown operation "${op}"`);
  }
}

module.exports = { createAdapter, run, SUPPORTED };
