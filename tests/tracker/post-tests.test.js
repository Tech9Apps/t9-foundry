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
  for (const type of ['clickup', 'azure', 'gitlab']) {
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

// A cases file that cannot be read IN FULL must be refused before anything is created. Posting "the cases it could read" reports ok:true while a case
// is silently missing, and a repeated id made the second case come back as "already existed" (both pointing at the first one's issue).
const os = require('node:os');
const { lintTestCases, parseTestCases } = require('../../scripts/tracker/lib/test-cases');
const caseBlock = (id, title = 'A title') => `### ${id}: ${title}\n- **Priority:** High\n- **Steps:** 1. do it\n- **Expected Result:** done\n\n`;
const casesFile = (text) => { const f = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-cases-')), 'cases.md'); fs.writeFileSync(f, text); return f; };

describe('lintTestCases', () => {
  test('a well-formed file has no problems', () => {
    assert.deepEqual(lintTestCases(caseBlock('TC-001') + caseBlock('TC-002') + caseBlock('TC-010')), []);
    assert.deepEqual(lintTestCases('# Title\n\nSome prose that mentions TC-001 and "### TC-002: not a header" inline.\n\n#### TC-003: a sub-heading, not a case\n'), []);
  });
  test('a repeated id is a problem, naming the id and both lines', () => {
    const problems = lintTestCases(caseBlock('TC-001') + caseBlock('TC-002') + caseBlock('TC-001', 'again'));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /TC-001/);
    assert.match(problems[0], /lines 1 and 11/);
  });
  test('a header that looks like a case but does not match "### TC-001: Title" is a problem, with its line', () => {
    for (const header of ['### TC-002 - dash instead of a colon', '### TC-003:no space after the colon', '###TC-004: no space after the hashes', '### tc-005: lower case', '### TC-6 missing colon', '### TC_007: underscore', '### TC-008:', '### TC-009: ']) {
      const problems = lintTestCases(caseBlock('TC-001') + `${header}\n- **Priority:** Low\n`);
      assert.equal(problems.length, 1, header);
      assert.match(problems[0], /line 6/);
      assert.ok(problems[0].includes(header.trim()), header);
    }
  });
  test('every problem is listed, not just the first', () => {
    assert.equal(lintTestCases(caseBlock('TC-001') + caseBlock('TC-001') + '### TC-002 - x\n' + '### TC-003:y\n').length, 3);
  });
  test('parseTestCases no longer throws on a header it cannot read: lint reports it, parse skips it', () => {
    assert.doesNotThrow(() => parseTestCases(caseBlock('TC-001') + '### TC-002:no space\n- **Priority:** Low\n'));
    assert.deepEqual(parseTestCases(caseBlock('TC-001') + '### TC-002:no space\n').map((c) => c.tcId), ['TC-001']);
  });
});

describe('post-tests refuses a cases file it cannot read in full (nothing is created)', () => {
  const BAD = caseBlock('TC-001') + caseBlock('TC-001', 'the same id again') + '### TC-002 - dash instead of a colon\n- **Priority:** Low\n';
  test('a repeated id and an unreadable header: exit 1, VALIDATION, both named, no request made', async () => {
    const w = makeWorkspace('github', { casesFile: casesFile(BAD) });
    const r = await w.post();
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, 'VALIDATION');
    assert.match(r.json.error.message, /TC-001.*twice|twice.*TC-001/);
    assert.match(r.json.error.message, /TC-002 - dash instead of a colon/);
    assert.equal(w.mock.calls.length, 0, 'no request was made');
    assert.equal(w.mock.createdItems().length, 0);
  });
  test('--dry-run refuses it too (it would otherwise show a plan that is not what is in the file)', async () => {
    const w = makeWorkspace('github', { casesFile: casesFile(BAD) });
    const r = await w.post(['--dry-run']);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'VALIDATION');
  });
  test('--only does not hide it: the file as a whole is wrong', async () => {
    const w = makeWorkspace('github', { casesFile: casesFile(BAD) });
    const r = await w.post(['--only', 'TC-001']);
    assert.equal(r.code, 1);
    assert.equal(w.mock.calls.length, 0);
  });
  test('a file that reads cleanly is posted exactly as before', async () => {
    const w = makeWorkspace('github', { casesFile: casesFile(caseBlock('TC-001') + caseBlock('TC-002')) });
    const r = await w.post();
    assert.equal(r.code, 0);
    assert.deepEqual([r.json.total, r.json.created], [2, 2]);
  });
});

describe('a cases file written with Windows line endings', () => {
  const crlf = (s) => s.replace(/\n/g, '\r\n');
  test('is read in full: every case, with its priority and steps (it used to lose the headers: "." does not match a carriage return)', () => {
    const md = crlf(caseBlock('TC-001', 'First') + caseBlock('TC-002', 'Second'));
    assert.deepEqual(lintTestCases(md), []);
    const cases = parseTestCases(md);
    assert.deepEqual(cases.map((c) => [c.tcId, c.title, c.priority, c.steps.length]), [['TC-001', 'First', 'High', 1], ['TC-002', 'Second', 'High', 1]]);
    assert.equal(cases[0].steps[0].expected, 'done');
  });
  test('and the problems in it are still found, on the right lines', () => {
    const problems = lintTestCases(crlf(caseBlock('TC-001') + caseBlock('TC-001') + '### TC-002 - x\n'));
    assert.equal(problems.length, 2);
    assert.match(problems.join(' '), /lines 1 and 6/);
    assert.match(problems.join(' '), /line 11/);
  });
  test('post-tests posts it', async () => {
    const w = makeWorkspace('github', { casesFile: casesFile(crlf(caseBlock('TC-001') + caseBlock('TC-002'))) });
    const r = await w.post();
    assert.equal(r.code, 0);
    assert.deepEqual([r.json.total, r.json.created], [2, 2]);
  });
});
