'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { main } = require('../../scripts/tracker/post-tests');
const { workspace: makeWorkspace, MOCKS } = require('./workspace');
const { assertValid } = require('./helpers');

const CASES_MD = path.join(__dirname, '..', '..', 'demo', 'expected', 'DEMO-101-test-cases.md');
const N = 10; // TC-001 … TC-010 in that file

const workspace = (type) => makeWorkspace(type, { casesFile: CASES_MD });

for (const type of Object.keys(MOCKS)) {
  describe(`post-tests (${type})`, () => {
    test('posts every case, links each to the parent, and records it all in a schema-valid keys file', async () => {
      const w = workspace(type);
      const r = await w.post();
      assert.equal(r.code, 0);
      assert.equal(r.json.ok, true);
      assert.deepEqual([r.json.total, r.json.created, r.json.deduplicated, r.json.linked, r.json.failed, r.json.skipped], [N, N, 0, N, 0, 0]);
      assert.equal(w.mock.createdItems().length, N);
      const keys = w.keys();
      assertValid('test-keys', keys);
      assert.equal(keys.parentTicket, w.parent);
      assert.equal(keys.source, type);
      assert.deepEqual(keys.tests.map((t) => t.tcId), Array.from({ length: N }, (_, i) => `TC-${String(i + 1).padStart(3, '0')}`));
      assert.equal(new Set(keys.tests.map((t) => t.id)).size, N, 'every case maps to its own tracker item');
      assert.ok(keys.tests.every((t) => t.status === 'created' && t.linked === true));
      assert.equal(keys.updatedAt, '2026-01-02T00:00:00.000Z');
    });

    test('carries priority, steps and traceability across', async () => {
      const w = workspace(type);
      await w.post();
      const tc5 = w.mock.createdItems().find((i) => /^TC-005/.test(i.title));
      assert.match(tc5.title, /Applying the same code twice/);
      assert.match(tc5.text, /Apply `BREW10` again/);
      assert.match(tc5.text, /Traceability: DEMO-101 AC4/);
    });

    test('running it again creates nothing: every case is found by its idempotency key', async () => {
      const w = workspace(type);
      const first = await w.post();
      const again = await w.post();
      assert.equal(again.code, 0);
      assert.deepEqual([again.json.created, again.json.deduplicated, again.json.linked], [0, N, N]);
      assert.equal(w.mock.createdItems().length, N, 'no duplicates');
      assert.deepEqual(again.json.tests.map((t) => t.id), first.json.tests.map((t) => t.id), 'the same items come back');
      assert.ok(w.keys().tests.every((t) => t.status === 'deduplicated'));
    });

    test('a transient failure on one case fails that case only; a re-run completes it', async () => {
      const w = workspace(type);
      w.mock.inject({ method: 'POST', match: w.mock.paths.create, status: 500 });
      const r = await w.post();
      assert.equal(r.code, 1);
      assert.deepEqual([r.json.created, r.json.failed, r.json.skipped], [N - 1, 1, 0]);
      const failed = r.json.tests.find((t) => t.status === 'failed');
      assert.equal(failed.tcId, 'TC-001');
      assert.equal(failed.error.code, 'UPSTREAM_ERROR');
      assert.equal(failed.error.retriable, true);
      assert.equal(failed.id, undefined);
      assertValid('test-keys', w.keys());

      const retry = await w.post();
      assert.equal(retry.code, 0);
      assert.deepEqual([retry.json.created, retry.json.deduplicated], [1, N - 1]);
      assert.equal(w.mock.createdItems().length, N, 'exactly one item per case');
    });

    test('a lost response (the write happened, we never heard) does not become a duplicate on re-run', async () => {
      const w = workspace(type);
      w.mock.inject({ method: 'POST', match: w.mock.paths.create, networkError: true, afterCommit: true });
      const r = await w.post();
      assert.equal(r.code, 1);
      assert.equal(r.json.tests.find((t) => t.status === 'failed').error.code, 'NETWORK');
      assert.equal(w.mock.createdItems().length, N, 'the tracker did create all ten');

      const retry = await w.post();
      assert.equal(retry.code, 0);
      assert.equal(retry.json.deduplicated, N);
      assert.equal(w.mock.createdItems().length, N);
    });

    test('bad credentials fail the whole run up front, before anything is created', async () => {
      const w = workspace(type);
      const r = await w.post([], { env: { [w.mock.tokenEnv]: 'wrong-token' } });
      assert.equal(r.code, 1);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.error.code, 'UNAUTHENTICATED');
      assert.equal(w.mock.createdItems().length, 0);
      assert.equal(fs.existsSync(w.keysFile), false);
    });

    test('an unknown parent ticket fails the whole run up front: no orphaned test cases', async () => {
      const w = workspace(type);
      const r = await w.post([], { parentId: w.mock.missingId });
      assert.equal(r.code, 1);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.error.code, 'NOT_FOUND');
      assert.equal(w.mock.createdItems().length, 0);
      assert.equal(fs.existsSync(w.keysFile), false);
    });

    test('credentials revoked MID-run stop it after one attempt instead of failing every case the same way', async () => {
      const w = workspace(type);
      w.mock.inject({ method: 'POST', match: w.mock.paths.create, status: 401 });
      const r = await w.post();
      assert.equal(r.code, 1);
      assert.deepEqual([r.json.failed, r.json.skipped, r.json.created], [1, N - 1, 0]);
      assert.equal(r.json.tests[0].error.code, 'UNAUTHENTICATED');
      assert.match(r.json.tests[1].reason, /stopped after UNAUTHENTICATED/);
      assertValid('test-keys', w.keys());
    });

    test('rate limiting mid-run also stops it (retry later; nothing is lost)', async () => {
      const w = workspace(type);
      w.mock.inject({ method: 'POST', match: w.mock.paths.create, status: 429 });
      const r = await w.post();
      assert.equal(r.json.tests[0].error.code, 'RATE_LIMITED');
      assert.equal(r.json.tests[0].error.retriable, true);
      assert.equal(r.json.skipped, N - 1);
      const retry = await w.post();
      assert.equal(retry.code, 0);
      assert.equal(w.mock.createdItems().length, N);
    });

    test('--only retries just the named cases and leaves the other entries in the keys file alone', async () => {
      const w = workspace(type);
      await w.post();
      const before = w.keys().tests.find((t) => t.tcId === 'TC-002');
      const r = await w.post(['--only', 'TC-001,TC-003']);
      assert.equal(r.json.total, 2);
      assert.deepEqual(r.json.tests.map((t) => t.tcId), ['TC-001', 'TC-003']);
      const keys = w.keys();
      assert.equal(keys.tests.length, N, 'entries for cases that were not selected are preserved');
      assert.deepEqual(keys.tests.find((t) => t.tcId === 'TC-002'), before);
    });

    test('--dry-run prints the plan without credentials, requests, or writing a keys file', async () => {
      const w = workspace(type);
      const r = await w.post(['--dry-run'], { env: {} });
      assert.equal(r.code, 0);
      assert.equal(r.json.dryRun, true);
      assert.equal(r.json.total, N);
      assert.deepEqual(r.json.tests[4], { tcId: 'TC-005', summary: 'Applying the same code twice does not stack the discount', priority: 'High', steps: 3, idempotencyKey: `${w.parent}-TC-005` });
      assert.equal(w.mock.calls.length, 0);
      assert.equal(fs.existsSync(w.keysFile), false);
    });

    test('no temp files are left beside the keys file', async () => {
      const w = workspace(type);
      await w.post();
      assert.deepEqual(fs.readdirSync(path.dirname(w.keysFile)), ['DEMO-101-test-keys.json']);
    });
  });
}

describe('post-tests: link failures (trackers with a link call)', () => {
  for (const type of ['clickup', 'azure']) {
    test(`${type}: a case that was created but could not be linked says so, and a re-run links it without duplicating`, async () => {
      const w = workspace(type);
      w.mock.inject({ method: w.mock.linkMethod, match: w.mock.paths.link, status: 500 });
      const r = await w.post();
      assert.equal(r.code, 1);
      assert.equal(r.json.created, N);
      assert.equal(r.json.linkFailed, 1);
      assert.equal(r.json.linked, N - 1);
      const entry = r.json.tests.find((t) => t.linkError);
      assert.equal(entry.status, 'created');
      assert.equal(entry.linked, false);
      assert.ok(entry.id, 'the created item is recorded even though linking failed');
      assertValid('test-keys', w.keys());

      const retry = await w.post();
      assert.equal(retry.code, 0);
      assert.equal(retry.json.linked, N);
      assert.equal(w.mock.createdItems().length, N);
    });
  }
});

describe('post-tests: ClickUp half-built tasks', () => {
  test('a case whose steps failed to attach is reported as partial, then repaired on re-run', async () => {
    const w = workspace('clickup');
    w.mock.inject({ method: 'POST', match: '/checklist/.+/checklist_item', status: 500 });
    const r = await w.post();
    assert.equal(r.code, 1);
    const entry = r.json.tests.find((t) => t.status === 'failed');
    assert.ok(entry.partial && entry.partial.id, 'the half-built task is identified');
    assert.match(entry.error.message, /steps were not fully added/);

    const retry = await w.post();
    assert.equal(retry.code, 0);
    assert.equal(retry.json.tests.find((t) => t.tcId === entry.tcId).repaired, true);
    assert.equal(w.mock.createdItems().length, N);
    const items = [...w.mock.state.checklists.values()].filter((c) => c.task === entry.partial.id)[0].items;
    assert.ok(items.length >= 2, 'the steps are all there after the re-run');
  });
});

describe('post-tests: invocation', () => {
  test('a missing cases file is VALIDATION and names the command that creates it', async () => {
    const w = workspace('github');
    fs.rmSync(w.cases);
    const r = await w.post();
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'VALIDATION');
    assert.match(r.json.error.message, /run \/create-manual-test-cases/);
  });

  test('a file with no TC blocks is VALIDATION', async () => {
    const w = workspace('github');
    fs.writeFileSync(w.cases, '# Test Cases\n\nnothing here\n');
    const r = await w.post();
    assert.equal(r.json.error.code, 'VALIDATION');
    assert.match(r.json.error.message, /### TC-001: Title/);
  });

  test('--parent is required, and --only must name real cases (exit 2)', async () => {
    const w = workspace('github');
    let err = '';
    const noParent = await main({ argv: ['--cases', w.cases], env: {}, stdout: { write() {} }, stderr: { write: (s) => { err += s; } } });
    assert.equal(noParent, 2);
    assert.match(err, /--parent/);
    const bad = await w.post(['--only', 'TC-999']);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /TC-999/);
  });

  test('the tracker token never appears in output or in the keys file', async () => {
    const w = workspace('github');
    const r = await w.post();
    assert.ok(!r.out.includes(w.mock.token));
    assert.ok(!fs.readFileSync(w.keysFile, 'utf8').includes(w.mock.token));
  });
});
