'use strict';

// "Closed WITHOUT a fix" is read from each tracker's own vocabulary, and the review found words real workspaces use that were not on the list:
// ClickUp "Not Planned" / "Will not fix" / WONTFIX / a curly-apostrophe "Won’t fix" / "Abandoned" / "Out of scope" / "Works as designed", and Azure
// "Rejected" / "Out of scope"; GitHub's "Close as duplicate". A miss is expensive in one direction (the bug reads as OPEN and is commented on for
// ever) and so is a false hit in the other ("Cancel pending" still has work in it). Every search result also says when the item was created, which is
// how the planner tells which of two matching reports is the later decision.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter, run } = require('../../scripts/tracker/adapters');
const { MOCKS } = require('./workspace');

async function seeded(type) {
  const mock = MOCKS[type]();
  const adapter = createAdapter(type, { settings: mock.settings, env: { [mock.tokenEnv]: mock.token }, fetch: mock.fetch, baseUrl: mock.baseUrl, timeoutMs: 500, retryDelayMs: 0 });
  const make = async (n) => (await run(adapter, 'create-bug', { title: `[BUG] ${n}`, body: `Steps.\n\nqa-harness-fingerprint: qafp00000000000${n}`, priority: 'High' })).id;
  const find = async (id) => (await run(adapter, 'search', { query: '[BUG]', kind: 'bug', limit: 20 })).items.find((i) => i.id === String(id));
  return { mock, make, find };
}

describe('clickup: statuses that mean "closed without a fix"', () => {
  for (const status of ['Not Planned', 'Will not fix', 'WONTFIX', 'Won’t fix', "Won't fix", 'Abandoned', 'Out of scope', 'Works as designed', 'Cancelled', 'Canceled', 'Rejected', 'Duplicate']) {
    test(`"${status}" is dismissed, and not open`, async () => {
      const { mock, make, find } = await seeded('clickup');
      const id = await make(1);
      mock.setStatus(id, status);
      const item = await find(id);
      assert.equal(item.dismissed, true);
      assert.equal(item.open, false);
    });
  }
  for (const status of ['Cancel pending', 'In Progress', 'Blocked', 'Needs design', 'Ready for QA']) {
    test(`"${status}" still has work in it: open, not dismissed`, async () => {
      const { mock, make, find } = await seeded('clickup');
      const id = await make(1);
      mock.setStatus(id, status);
      const item = await find(id);
      assert.equal(item.dismissed, undefined);
      assert.equal(item.open, true);
    });
  }
});

describe('azure: reasons that mean "closed without a fix"', () => {
  for (const reason of ['Rejected', 'Out of scope', 'Will not Fix', 'As Designed', 'Duplicate', 'Obsolete']) {
    test(`Closed / "${reason}" is dismissed`, async () => {
      const { mock, make, find } = await seeded('azure');
      const id = await make(1);
      mock.setState(id, 'Closed', reason);
      assert.equal((await find(id)).dismissed, true);
    });
  }
  for (const reason of ['Fixed', 'Cannot Reproduce', 'Deferred']) {
    test(`Closed / "${reason}" is NOT dismissed (a recurrence is worth a new report)`, async () => {
      const { mock, make, find } = await seeded('azure');
      const id = await make(1);
      mock.setState(id, 'Closed', reason);
      assert.equal((await find(id)).dismissed, undefined);
    });
  }
});

describe('github: close reasons', () => {
  for (const [reason, dismissed] of [['not_planned', true], ['duplicate', true], ['completed', false]]) {
    test(`state_reason "${reason}" ${dismissed ? 'is' : 'is not'} dismissed`, async () => {
      const { mock, make, find } = await seeded('github');
      const id = await make(1);
      mock.closeAs(id, reason);
      assert.equal((await find(id)).dismissed, dismissed ? true : undefined);
    });
  }
});

describe('every tracker says when a search result was created', () => {
  for (const type of Object.keys(MOCKS)) {
    test(`${type}: createdAt is an ISO time, and a later item has a later one`, async () => {
      const { make, find } = await seeded(type);
      const first = await make(1); const second = await make(2);
      const a = await find(first); const b = await find(second);
      assert.ok(Number.isFinite(Date.parse(a.createdAt)), `${type}: first item has no usable createdAt (${a.createdAt})`);
      assert.ok(Date.parse(b.createdAt) > Date.parse(a.createdAt), `${type}: the second item must be later`);
    });
  }
});
