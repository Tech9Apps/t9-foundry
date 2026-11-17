'use strict';

// Slice 3: a tracker write that happens ONCE, through the run ledger (scripts/tracker/lib/once.js), on every tracker's mock. The adapter's own
// idempotency marker is what makes a re-run safe without a ledger; these tests are about what the ledger adds, and about it never making a write MORE likely.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main: cliMain } = require('../../scripts/tracker/cli');
const { runOnce, ledgerKey } = require('../../scripts/tracker/lib/once');
const { TrackerError } = require('../../scripts/tracker/lib/errors');
const { connect } = require('../../scripts/tracker/lib/connect');
const { openLedger } = require('../../scripts/ledger/lib/ledger');
const { workspace: makeWorkspace, MOCKS } = require('./workspace');
const { assertValid } = require('./helpers');

const CASES_MD = path.join(__dirname, '..', '..', 'demo', 'expected', 'DEMO-101-test-cases.md');
const N = 10;
const workspace = (type) => makeWorkspace(type, { casesFile: CASES_MD });
const ledgerOf = (w) => path.join(w.dir, 'ledger');
const withLedger = (w, extra = []) => ['--ledger-dir', ledgerOf(w), '--run-id', 'run-a', ...extra];
const creates = (w, from = 0) => w.mock.calls.slice(from).filter((c) => c.method === 'POST' && new RegExp(w.mock.paths.create).test(c.path));
const searches = (w, from = 0) => w.mock.calls.slice(from).filter((c) => new RegExp(w.mock.paths.search).test(c.path));
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid; // a process that has already exited
const adapterOf = (w) => connect({ configPath: w.config, baseUrl: w.mock.baseUrl, env: { [w.mock.tokenEnv]: w.mock.token }, fetch: w.mock.fetch });
const keyOf = (w, op, key) => ledgerKey(adapterOf(w), op, key); // how the ledger holds a write: tracker, where it points, operation, key
const tcKey = (w, id) => keyOf(w, 'create-test', `${w.parent}-${id}`);

for (const type of Object.keys(MOCKS)) {
  describe(`a write happens once, through the ledger (${type})`, () => {
    test('re-running creates nothing, and the second run does not even ask the tracker to create or search: the ledger already knows', async () => {
      const w = workspace(type);
      const first = await w.post(withLedger(w));
      assert.equal(first.code, 0, first.out);
      assert.equal(first.json.created, N);
      const seen = w.mock.calls.length;
      const second = await w.post(withLedger(w));
      assert.equal(second.code, 0, second.out);
      assert.deepEqual([second.json.created, second.json.deduplicated], [0, N]);
      const ledgerRequests = w.mock.calls.length - seen;
      assert.ok(second.json.tests.every((t) => t.fromLedger === true && t.id), 'each case came from the ledger, with its id');
      assert.equal(w.mock.createdItems().length, N);
      assert.equal(creates(w, seen).length, 0, 'no create request');
      // the same re-run WITHOUT a ledger asks the tracker to look up every key; with one, those requests are not made
      const plain = workspace(type);
      await plain.post();
      const before = plain.mock.calls.length;
      await plain.post();
      assert.ok(ledgerRequests < plain.mock.calls.length - before, `${ledgerRequests} requests with the ledger, ${plain.mock.calls.length - before} without`);
      const l = openLedger({ dir: ledgerOf(w) });
      assert.equal(l.doneClaims((k) => k.startsWith(keyOf(w, 'create-test', ''))).length, N);
      assert.deepEqual(w.keys().tests.map((t) => t.id), first.json.tests.map((t) => t.id), 'the keys file still records every id');
    });

    test('with the ledger gone (or never there), the adapter\'s own marker still prevents a duplicate: the ledger only adds to it', async () => {
      const w = workspace(type);
      assert.equal((await w.post()).code, 0, 'a first run with no ledger at all');
      const second = await w.post(withLedger(w));
      assert.equal(second.code, 0, second.out);
      assert.deepEqual([second.json.created, second.json.deduplicated], [0, N]);
      assert.equal(w.mock.createdItems().length, N);
      fs.rmSync(ledgerOf(w), { recursive: true, force: true });
      const third = await w.post(withLedger(w));
      assert.equal(third.json.deduplicated, N);
      assert.equal(w.mock.createdItems().length, N);
    });

    test('a case that failed is claimable again: the re-run completes it and nothing is duplicated', async () => {
      const w = workspace(type);
      w.mock.inject({ method: 'POST', match: w.mock.paths.create, status: 500 });
      const r = await w.post(withLedger(w));
      assert.equal(r.code, 1);
      assert.equal(r.json.failed, 1);
      const l = openLedger({ dir: ledgerOf(w) });
      assert.equal(l.listKeys().filter((k) => k.state === 'failed').length, 1, 'the failure is on record');
      const retry = await w.post(withLedger(w));
      assert.equal(retry.code, 0, retry.out);
      assert.equal(w.mock.createdItems().length, N);
      assert.equal(openLedger({ dir: ledgerOf(w) }).listKeys().filter((k) => k.state === 'done').length, N);
    });

    test('a lost response (the tracker wrote, we never heard) is found by the marker on re-run, not created twice', async () => {
      const w = workspace(type);
      w.mock.inject({ method: 'POST', match: w.mock.paths.create, networkError: true, afterCommit: true });
      const r = await w.post(withLedger(w));
      assert.equal(r.code, 1);
      assert.equal(w.mock.createdItems().length, N, 'the tracker created every case');
      const retry = await w.post(withLedger(w));
      assert.equal(retry.code, 0, retry.out);
      const adopted = retry.json.tests.filter((t) => t.status === 'deduplicated' && !t.fromLedger);
      assert.equal(adopted.length, 1, 'the one whose answer was lost is adopted by its marker, not created again');
      assert.equal(retry.json.tests.filter((t) => t.fromLedger).length, N - 1, 'and the nine that were recorded come from the ledger');
      assert.equal(w.mock.createdItems().length, N);
    });

    test('a case another RUNNING process is writing is not written twice: IN_PROGRESS (retriable), the others go ahead, and it is picked up once it is done', async () => {
      const w = workspace(type);
      const l = openLedger({ dir: ledgerOf(w), pid: process.ppid }); // another process that is alive: this one's parent
      assert.equal(l.claim(tcKey(w, 'TC-003'), { runId: 'someone-else' }).won, true);
      const r = await w.post(withLedger(w));
      assert.equal(r.code, 1);
      const busy = r.json.tests.find((t) => t.tcId === 'TC-003');
      assert.deepEqual([busy.status, busy.error.code, busy.error.retriable], ['failed', 'IN_PROGRESS', true]);
      assert.equal(r.json.created, N - 1, 'every other case was created');
      // the other process finishes: its item is on the tracker and its claim is completed
      const adapter = connect({ configPath: w.config, baseUrl: w.mock.baseUrl, env: { [w.mock.tokenEnv]: w.mock.token }, fetch: w.mock.fetch });
      const tc = require('../../scripts/tracker/lib/test-cases').parseTestCases(fs.readFileSync(w.cases, 'utf8')).find((c) => c.tcId === 'TC-003');
      const theirs = await require('../../scripts/tracker/adapters').run(adapter, 'create-test', { parentId: w.parent, tcId: 'TC-003', title: tc.title, description: tc.description, priority: tc.priority, steps: tc.steps, idempotencyKey: `${w.parent}-TC-003` });
      l.complete(tcKey(w, 'TC-003'), { id: String(theirs.id) });
      const after = await w.post(withLedger(w));
      assert.equal(after.code, 0, after.out);
      const done = after.json.tests.find((t) => t.tcId === 'TC-003');
      assert.deepEqual([done.id, done.fromLedger], [String(theirs.id), true], 'it is taken as the ledger says, and is not created a second time');
      assert.equal(w.mock.createdItems().length, N, 'ten cases in all, none twice');
    });

    test('a case a DEAD run left in flight is resumed: if it had already been created the marker adopts it, otherwise it is created once', async () => {
      const w = workspace(type);
      const dead = openLedger({ dir: ledgerOf(w), pid: deadPid() });
      dead.claim(tcKey(w, 'TC-002'), { runId: 'died-before-writing' });
      dead.claim(tcKey(w, 'TC-005'), { runId: 'died-after-writing' });
      // TC-005 reached the tracker before its run died: create it the way that run would have
      const adapter = connect({ configPath: w.config, baseUrl: w.mock.baseUrl, env: { [w.mock.tokenEnv]: w.mock.token }, fetch: w.mock.fetch });
      const tc = require('../../scripts/tracker/lib/test-cases').parseTestCases(fs.readFileSync(w.cases, 'utf8')).find((c) => c.tcId === 'TC-005');
      await require('../../scripts/tracker/adapters').run(adapter, 'create-test', { parentId: w.parent, tcId: 'TC-005', title: tc.title, description: tc.description, priority: tc.priority, steps: tc.steps, idempotencyKey: `${w.parent}-TC-005` });
      assert.equal(w.mock.createdItems().length, 1);
      const r = await w.post(withLedger(w));
      assert.equal(r.code, 0, r.out);
      assert.equal(w.mock.createdItems().length, N, 'ten cases, not eleven');
      const byId = Object.fromEntries(r.json.tests.map((t) => [t.tcId, t]));
      assert.deepEqual([byId['TC-002'].status, byId['TC-002'].resumed], ['created', true]);
      assert.deepEqual([byId['TC-005'].status, byId['TC-005'].resumed], ['deduplicated', true]);
      assert.equal(openLedger({ dir: ledgerOf(w) }).readClaim(tcKey(w, 'TC-005')).state, 'done');
    });

    test('a ledger that cannot be used is a warning, and the adapter\'s marker carries the run: nothing is lost and nothing is duplicated', async () => {
      const w = workspace(type);
      fs.mkdirSync(ledgerOf(w), { recursive: true });
      fs.writeFileSync(path.join(ledgerOf(w), 'VERSION'), '9\n'); // a newer layout: every write refuses
      const r = await w.post(withLedger(w));
      assert.equal(r.code, 0, r.out);
      assert.equal(r.json.created, N);
      assert.ok(r.json.warnings.some((m) => /^ledger: /.test(m)), JSON.stringify(r.json.warnings));
      assert.equal(r.json.warnings.length, 1, 'said once, not once per case');
      const again = await w.post(withLedger(w));
      assert.equal(again.json.deduplicated, N);
      assert.equal(w.mock.createdItems().length, N);
    });
  });
}

describe('what is on record', () => {
  test('every write is in the audit log, by run: claimed, then done with its id; a failure with its code', async () => {
    const w = workspace('github');
    w.mock.inject({ method: 'POST', match: w.mock.paths.create, status: 500 });
    await w.post(withLedger(w, ['--only', 'TC-001,TC-002']));
    const audit = openLedger({ dir: ledgerOf(w) }).readAudit().events;
    assert.ok(audit.every((e) => e.runId === 'run-a'));
    assert.deepEqual(audit.map((e) => e.type), ['action.claimed', 'action.failed', 'action.claimed', 'action.done']);
    assert.deepEqual(audit.map((e) => e.key), [tcKey(w, 'TC-001'), tcKey(w, 'TC-001'), tcKey(w, 'TC-002'), tcKey(w, 'TC-002')]);
    assert.equal(audit[1].code, 'UPSTREAM_ERROR');
    assert.match(audit[3].id, /^\d+$/);
    assert.equal(audit[0].target, w.parent);
  });

  test('the claim is under "<tracker>/<operation>/<key>": one key on two trackers, or as a bug and as a comment, is not the same write', () => {
    assert.equal(ledgerKey({ source: 'github' }, 'create-bug', 'fp-abc-run1'), 'github/create-bug/fp-abc-run1');
    assert.notEqual(ledgerKey({ source: 'github' }, 'create-test', 'k'), ledgerKey({ source: 'gitlab' }, 'create-test', 'k'));
    assert.notEqual(ledgerKey({ source: 'github' }, 'create-bug', 'k'), ledgerKey({ source: 'github' }, 'comment', 'k'));
  });

  test('secrets in a failure message are masked on their way into the ledger', async () => {
    const w = workspace('github');
    w.mock.inject({ method: 'POST', match: w.mock.paths.create, status: 500, body: { message: 'boom ghp_abcdefghijklmnopqrstuvwxyz0123456789' } });
    await w.post(withLedger(w, ['--only', 'TC-001']));
    const text = fs.readdirSync(ledgerOf(w), { recursive: true }).map((f) => { try { return fs.readFileSync(path.join(ledgerOf(w), f), 'utf8'); } catch { return ''; } }).join('\n');
    assert.equal(text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), false);
  });
});

describe('the other keyed writes: create-bug and comment, through the tracker CLI', () => {
  const stream = () => { const s = { text: '', write(t) { s.text += t; } }; return s; };
  async function cli(w, op, input, extra = []) {
    const stdout = stream(); const stderr = stream();
    const code = await cliMain({ argv: [op, '--config', w.config, '--base-url', w.mock.baseUrl, '--input', JSON.stringify(input), ...extra], env: { [w.mock.tokenEnv]: w.mock.token }, fetch: w.mock.fetch, stdout, stderr });
    return { code, json: stdout.text ? JSON.parse(stdout.text) : null, err: stderr.text };
  }
  const bug = { title: 'Totals wrong with a coupon', body: 'steps...', idempotencyKey: 'fp-abc123abc123-run1' };

  test('a bug filed twice is filed once: the second answer comes from the ledger, with the first one\'s id, and the tracker is not asked', async () => {
    const w = workspace('github');
    const a = await cli(w, 'create-bug', bug, withLedger(w));
    assert.equal(a.code, 0, a.err);
    assert.equal(a.json.data.deduplicated, false);
    const seen = w.mock.calls.length;
    const b = await cli(w, 'create-bug', bug, withLedger(w));
    assert.equal(b.code, 0);
    assert.deepEqual([b.json.data.id, b.json.data.fromLedger, b.json.data.deduplicated], [a.json.data.id, true, true]);
    assert.equal(w.mock.calls.length, seen, 'not one request');
    assert.equal(w.mock.createdItems().length, 1);
  });

  test('a comment is a write too: posted once however often it is attempted', async () => {
    const w = workspace('github');
    const comment = { id: w.parent, body: 'seen again in run 2', idempotencyKey: 'fp-abc123abc123-run2-comment' };
    const a = await cli(w, 'comment', comment, withLedger(w));
    const b = await cli(w, 'comment', comment, withLedger(w));
    assert.equal(a.code, 0, a.err);
    assert.equal(b.json.data.fromLedger, true);
    assert.equal(w.mock.commentsOn(w.parent).filter((t) => /seen again in run 2/.test(t)).length, 1);
  });

  test('a bug another running process is filing right now is IN_PROGRESS (exit 1, retriable), not a second bug', async () => {
    const w = workspace('github');
    openLedger({ dir: ledgerOf(w), pid: process.ppid }).claim(keyOf(w, 'create-bug', bug.idempotencyKey), { runId: 'someone-else' }); // a live process that is not this one
    const r = await cli(w, 'create-bug', bug, withLedger(w));
    assert.equal(r.code, 1);
    assert.deepEqual([r.json.error.code, r.json.error.retriable], ['IN_PROGRESS', true]);
    assert.equal(w.mock.createdItems().length, 0);
    assert.match(r.json.error.message, /being written right now by run someone-else/);
  });

  test('without a ledger the CLI is exactly what it was: the same answer, no ledger folder, no new fields', async () => {
    const w = workspace('github');
    const a = await cli(w, 'create-bug', bug);
    const b = await cli(w, 'create-bug', bug);
    assert.deepEqual([a.json.data.deduplicated, b.json.data.deduplicated], [false, true]);
    assert.equal(b.json.data.fromLedger, undefined);
    assert.equal(w.mock.createdItems().length, 1);
    assert.equal(fs.existsSync(ledgerOf(w)), false);
  });

  test('a ledger block in qa-config.json turns it on for the CLI (the /file-bug command needs no change), beside the config', async () => {
    const w = workspace('github');
    const cfg = JSON.parse(fs.readFileSync(w.config, 'utf8'));
    fs.writeFileSync(w.config, JSON.stringify({ ...cfg, ledger: {} }));
    await cli(w, 'create-bug', bug);
    const again = await cli(w, 'create-bug', bug);
    assert.equal(again.json.data.fromLedger, true);
    assert.equal(fs.existsSync(path.join(w.dir, '.qa-ledger', 'keys')), true);
  });

  test('reads and links never touch the ledger, and a bad ledger setting is refused before any request', async () => {
    const w = workspace('github');
    const read = await cli(w, 'fetch', { id: w.parent }, withLedger(w));
    assert.equal(read.code, 0);
    assert.equal(fs.existsSync(ledgerOf(w)), false);
    const seen = w.mock.calls.length;
    const bad = await cli(w, 'create-bug', bug, ['--ledger-dir', '']);
    assert.equal(bad.code, 2);
    assert.equal(w.mock.calls.length, seen, 'the refused call made no request');
  });

  test('an ALLOWED invocation (fetch, search, post-tests --dry-run: the ones the allow rules cover) writes nothing, however --ledger-dir and --run-id are set', async () => {
    const w = workspace('github');
    const target = path.join(w.dir, 'must-not-appear');
    const fetched = await cli(w, 'fetch', { id: w.parent }, ['--ledger-dir', target, '--run-id', 'x']);
    const searched = await cli(w, 'search', { query: 'anything' }, ['--ledger-dir', target, '--run-id', 'x']);
    assert.deepEqual([fetched.code, searched.code], [0, 0]);
    const dry = await w.post(['--dry-run', '--ledger-dir', target, '--run-id', 'x']);
    assert.equal(dry.code, 0);
    assert.equal(fs.existsSync(target), false, 'no ledger folder was created');
  });

  test('a bad idempotency key is refused as VALIDATION before anything is claimed', async () => {
    const w = workspace('github');
    const r = await cli(w, 'create-bug', { ...bug, idempotencyKey: 'has spaces' }, withLedger(w));
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'VALIDATION');
    assert.equal(fs.existsSync(path.join(ledgerOf(w), 'keys')), false);
  });

  test('forget drops a claim that is wrong (the item was deleted on the tracker): the next write goes there again', async () => {
    const w = workspace('github');
    const a = await cli(w, 'create-bug', bug, withLedger(w));
    w.mock.state.issues.delete(Number(a.json.data.id)); // someone deleted it on the tracker
    const stale = await cli(w, 'create-bug', bug, withLedger(w));
    assert.equal(stale.json.data.fromLedger, true, 'the ledger still says it exists');
    const { main: ledgerCli } = require('../../scripts/ledger/cli');
    const out = stream();
    assert.equal(ledgerCli({ argv: ['forget', '--key', keyOf(w, 'create-bug', bug.idempotencyKey), '--dir', ledgerOf(w)], env: {}, stdout: out, stderr: stream() }), 0);
    assert.deepEqual(JSON.parse(out.text).data, { removed: true });
    const fresh = await cli(w, 'create-bug', bug, withLedger(w));
    assert.equal(fresh.json.data.deduplicated, false, 'it is filed again');
    assert.equal([...w.mock.state.issues.values()].filter((i) => /Totals wrong/.test(i.title)).length, 1, 'one report on the tracker now (the first was deleted)');
  });
});

describe('runOnce directly', () => {
  const adapterFor = (w) => connect({ configPath: w.config, baseUrl: w.mock.baseUrl, env: { [w.mock.tokenEnv]: w.mock.token }, fetch: w.mock.fetch });
  const input = { title: 'A bug', body: 'b', idempotencyKey: 'direct-1' };

  test('without a ledger it is exactly run(); a non-keyed or non-create operation never touches one', async () => {
    const w = workspace('github');
    const adapter = adapterFor(w);
    const l = openLedger({ dir: ledgerOf(w) });
    assert.equal((await runOnce(adapter, 'create-bug', input, {})).deduplicated, false);
    assert.equal((await runOnce(adapter, 'create-bug', { title: 'B', body: 'b' }, { ledger: l })).deduplicated, false, 'no key: nothing to claim');
    assert.equal((await runOnce(adapter, 'fetch', { id: w.parent }, { ledger: l })).id, w.parent);
    assert.deepEqual(l.listKeys(), []);
  });

  test('a claim whose resumer lost the race to another resumer is IN_PROGRESS, not a second write', async () => {
    const w = workspace('github');
    const adapter = adapterFor(w);
    const dead = openLedger({ dir: ledgerOf(w), pid: deadPid() });
    dead.claim(keyOf(w, 'create-bug', input.idempotencyKey), { runId: 'dead' });
    const l = openLedger({ dir: ledgerOf(w) });
    const realClaim = l.claim.bind(l);
    let n = 0;
    l.claim = (k, o) => { n += 1; if (n === 2) { realClaim(k, { runId: 'faster-resumer' }); } return realClaim(k, o); }; // another resumer takes it over between our fail and our claim
    await assert.rejects(() => runOnce(adapter, 'create-bug', input, { ledger: l, runId: 'slow' }), (e) => e.code === 'IN_PROGRESS' && /faster-resumer/.test(e.message));
    assert.equal(w.mock.createdItems().length, 0);
  });

  test('an invalid run id degrades to the adapter alone, with a warning (the write still happens, once)', async () => {
    const w = workspace('github');
    const warnings = [];
    const l = openLedger({ dir: ledgerOf(w) });
    const r = await runOnce(adapterFor(w), 'create-bug', input, { ledger: l, runId: `run-ghp_abcdefghijklmnopqrstuvwxyz0123456789`, warn: (m) => warnings.push(m) });
    assert.equal(r.deduplicated, false);
    assert.ok(warnings.some((m) => /^ledger: /.test(m)));
    assert.equal(w.mock.createdItems().length, 1);
    const again = await runOnce(adapterFor(w), 'create-bug', input, { ledger: l, runId: 'ok-run' });
    assert.equal(again.deduplicated, true);
    assert.equal(w.mock.createdItems().length, 1);
  });
});

describe('what the review of slice 3 found', () => {
  const { createAdapter } = require('../../scripts/tracker/adapters');
  const { createGithubMock } = require('../mocks/tracker-mock/github');
  const adapterFor = (w) => connect({ configPath: w.config, baseUrl: w.mock.baseUrl, env: { [w.mock.tokenEnv]: w.mock.token }, fetch: w.mock.fetch });
  const input = { title: 'A bug', body: 'b', idempotencyKey: 'rev-1' };
  const MIN = 60 * 1000;
  const stream = () => { const s2 = { text: '', write(t) { s2.text += t; } }; return s2; };

  test('an option can never be the VALUE of another option on post-tests.js or the tracker CLI: the allow rule matches on --dry-run appearing, so --run-id --dry-run must not run for real', async () => {
    const w = workspace('github');
    for (const bad of [['--run-id', '--dry-run'], ['--keys-file', '--dry-run'], ['--ledger-dir', '--dry-run'], ['--cases', '--dry-run'], ['--run-id', '--dry-runner'], ['--only', '--dry-run'], ['--config', '--dry-run']]) {
      const seen = w.mock.calls.length;
      const r = await w.post([...bad, ...(bad[1] === '--dry-run' ? [] : ['--dry-run'])]);
      assert.equal(r.code, 2, bad.join(' '));
      assert.match(r.err, /needs a value, but the next argument is "--dry-run[a-z]*", which looks like an option/, bad.join(' '));
      assert.equal(w.mock.calls.length, seen, `${bad.join(' ')}: nothing reached the tracker`);
      assert.equal(w.mock.createdItems().length, 0);
    }
    assert.equal(fs.existsSync(path.join(process.cwd(), '--dry-run')), false, 'and no folder named after an option appeared');
    const out = stream(); const err = stream();
    const code = await cliMain({ argv: ['fetch', '--run-id', '--dry-run', '--config', w.config], env: { [w.mock.tokenEnv]: w.mock.token }, fetch: w.mock.fetch, stdout: out, stderr: err });
    assert.equal(code, 2);
    assert.match(err.text, /looks like an option/);
  });

  test('a real --dry-run still works, and a value that merely contains dashes (not at its start) is still a value', async () => {
    const w = workspace('github');
    const dry = await w.post(['--dry-run', '--run-id', 'a--b']);
    assert.equal(dry.code, 0);
    assert.equal(dry.json.dryRun, true);
    assert.equal(w.mock.calls.length, 0);
  });

  test('two resumers that looked at the same dead claim cannot both write: the late one\'s "mark it failed" does nothing to the claim the first resumer took', async () => {
    const w = workspace('github');
    const adapter = adapterFor(w);
    const key = keyOf(w, 'create-bug', input.idempotencyKey);
    openLedger({ dir: ledgerOf(w), pid: deadPid() }).claim(key, { runId: 'dead' });
    const l1 = openLedger({ dir: ledgerOf(w) });
    const l2 = openLedger({ dir: ledgerOf(w) });
    let first;
    const realFail = l2.fail.bind(l2);
    l2.fail = (k, e, o) => { // R2 has just seen the dead claim; before it can act, R1 does the whole resume and starts writing
      if (!first) first = runOnce(adapter, 'create-bug', input, { ledger: l1, runId: 'r1' });
      return first.then(() => realFail(k, e, o)); // R1 has FINISHED by the time R2's fail lands: it must not undo anything
    };
    // runOnce calls fail synchronously, so run R2 against a ledger whose fail waits: emulate by awaiting R1 first, then letting R2 proceed with its stale view
    const r1 = await runOnce(adapter, 'create-bug', input, { ledger: l1, runId: 'r1' });
    assert.equal(r1.resumed, true);
    assert.equal(w.mock.createdItems().length, 1);
    const stale = openLedger({ dir: ledgerOf(w) });
    const view = { ...stale.readClaim(key), claimId: 'the-claim-r2-looked-at', state: 'claimed' };
    const late = stale.fail(key, { code: 'OWNER_GONE' }, { expect: view });
    assert.deepEqual([late.changed, late.mismatch], [false, true], 'a fail aimed at a claim the key no longer holds changes nothing');
    assert.equal(stale.readClaim(key).state, 'done', 'R1\'s finished claim is intact');
  });

  test('a resume racing a resume, interleaved for real: exactly one write', async () => {
    const w = workspace('github');
    const adapter = adapterFor(w);
    const key = keyOf(w, 'create-bug', input.idempotencyKey);
    openLedger({ dir: ledgerOf(w), pid: deadPid() }).claim(key, { runId: 'dead' });
    const l1 = openLedger({ dir: ledgerOf(w), pid: process.ppid }); // R1 shows up as a live process other than R2
    const l2 = openLedger({ dir: ledgerOf(w) });
    let r1;
    const realFail = l2.fail.bind(l2);
    l2.fail = (k, e, o) => { r1 = runOnce(adapter, 'create-bug', input, { ledger: l1, runId: 'r1' }); return realFail(k, e, o); }; // R1 starts the instant R2 is about to act
    const results = await Promise.allSettled([runOnce(adapter, 'create-bug', input, { ledger: l2, runId: 'r2' }), new Promise((resolve) => setImmediate(resolve)).then(() => r1)]);
    assert.equal(w.mock.createdItems().length, 1, JSON.stringify(results.map((x) => x.status === 'fulfilled' ? x.value : x.reason.code)));
    assert.ok(results.some((x) => x.status === 'fulfilled'));
  });

  test('a claim THIS process left behind (it could not record the completion) is resumed, not IN_PROGRESS forever; a claim by another live process is not', async () => {
    const w = workspace('github');
    const adapter = adapterFor(w);
    const l = openLedger({ dir: ledgerOf(w) });
    const real = l.complete.bind(l);
    l.complete = () => { throw new Error('disk full'); };
    const warnings = [];
    const first = await runOnce(adapter, 'create-bug', input, { ledger: l, runId: 'r1', warn: (m) => warnings.push(m) });
    assert.equal(first.deduplicated, false);
    assert.ok(warnings.some((m) => /disk full/.test(m)));
    l.complete = real;
    const retry = await runOnce(adapter, 'create-bug', input, { ledger: l, runId: 'r1' });
    assert.deepEqual([retry.deduplicated, retry.resumed], [true, true], 'adopted by its marker, not written again, not stuck');
    assert.equal(w.mock.createdItems().length, 1);
    const other = { ...input, idempotencyKey: 'rev-2' };
    openLedger({ dir: ledgerOf(w), pid: process.ppid }).claim(keyOf(w, 'create-bug', 'rev-2'), { runId: 'live-other' });
    await assert.rejects(() => runOnce(adapter, 'create-bug', other, { ledger: l, runId: 'r1' }), (e) => e.code === 'IN_PROGRESS');
  });

  test('a writer that was REPLACED while it wrote (its claim taken over) must not overwrite its replacement when it finishes late: its completion applies to its own claim only', async () => {
    const w = workspace('github');
    const adapter = adapterFor(w);
    const key = keyOf(w, 'create-bug', input.idempotencyKey);
    const l = openLedger({ dir: ledgerOf(w) });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const realCreate = adapter.createBug.bind(adapter);
    adapter.createBug = async (i) => { await gate; return realCreate(i); };
    const warnings = [];
    const slow = runOnce(adapter, 'create-bug', input, { ledger: l, runId: 'slow', warn: (m) => warnings.push(m) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const other = openLedger({ dir: ledgerOf(w), pid: process.ppid });
    other.forgetClaim(key, { force: true }); // somebody decided the slow one was gone, and took the key
    assert.equal(other.claim(key, { runId: 'successor' }).won, true);
    release();
    await slow; // the slow writer's write reached the tracker; it now tries to record it
    const held = l.readClaim(key);
    assert.deepEqual([held.state, held.runId], ['claimed', 'successor'], 'the successor\'s claim is untouched');
    assert.ok(warnings.some((m) => /taken over before its completion could be recorded/.test(m)), JSON.stringify(warnings));
  });

  test('…and the same when the slow writer FAILS after it was replaced: it cannot mark its replacement\'s claim failed', async () => {
    const w = workspace('github');
    const adapter = adapterFor(w);
    const key = keyOf(w, 'create-bug', input.idempotencyKey);
    const l = openLedger({ dir: ledgerOf(w) });
    let fail;
    const gate = new Promise((resolve, reject) => { fail = reject; });
    adapter.createBug = async () => { await gate; };
    const slow = runOnce(adapter, 'create-bug', input, { ledger: l, runId: 'slow' });
    const settled = slow.catch((e) => e);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const other = openLedger({ dir: ledgerOf(w), pid: process.ppid });
    other.forgetClaim(key, { force: true });
    other.claim(key, { runId: 'successor' });
    fail(new TrackerError('NETWORK', 'dropped'));
    assert.equal((await settled).code, 'NETWORK');
    const held = l.readClaim(key);
    assert.deepEqual([held.state, held.runId], ['claimed', 'successor'], 'the successor is still in flight, not failed by someone else\'s error');
  });

  test('two concurrent writes of one key in the SAME process: the second sees a live writer (this process, mid-write), not a leftover to resume', async () => {
    const w = workspace('github');
    const adapter = adapterFor(w);
    const l = openLedger({ dir: ledgerOf(w) });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const realCreate = adapter.createBug.bind(adapter);
    adapter.createBug = async (i) => { await gate; return realCreate(i); };
    const first = runOnce(adapter, 'create-bug', input, { ledger: l, runId: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 20)); // the first has claimed the key and is waiting inside its write
    await assert.rejects(() => runOnce(adapter, 'create-bug', input, { ledger: openLedger({ dir: ledgerOf(w) }), runId: 'b' }), (e) => e.code === 'IN_PROGRESS' && /run a/.test(e.message));
    release();
    const done = await first;
    assert.equal(done.deduplicated, false);
    assert.equal(w.mock.createdItems().length, 1);
    const later = await runOnce(adapter, 'create-bug', input, { ledger: l, runId: 'b' });
    assert.equal(later.fromLedger, true);
  });

  test('a claim by a process that LOOKS alive but has held it longer than any write can take is abandoned and resumed', async () => {
    const w = workspace('github');
    const adapter = adapterFor(w);
    const l = openLedger({ dir: ledgerOf(w) });
    openLedger({ dir: ledgerOf(w), pid: process.ppid }).claim(keyOf(w, 'create-bug', input.idempotencyKey), { runId: 'hung' });
    await assert.rejects(() => runOnce(adapter, 'create-bug', input, { ledger: l, runId: 'r', now: () => Date.now() + 14 * MIN }), (e) => e.code === 'IN_PROGRESS', '14 minutes: still plausibly writing');
    const r = await runOnce(adapter, 'create-bug', input, { ledger: l, runId: 'r', now: () => Date.now() + 16 * MIN });
    assert.equal(r.resumed, true, '16 minutes: no write takes that long');
    assert.equal(w.mock.createdItems().length, 1);
  });

  test('IN_PROGRESS says who holds the key, since when, and how to let go of it', async () => {
    const w = workspace('github');
    const key = keyOf(w, 'create-bug', input.idempotencyKey);
    openLedger({ dir: ledgerOf(w), pid: process.ppid }).claim(key, { runId: 'the-holder' });
    let err;
    try { await runOnce(adapterFor(w), 'create-bug', input, { ledger: openLedger({ dir: ledgerOf(w) }), runId: 'r' }); } catch (e) { err = e; }
    assert.equal(err.code, 'IN_PROGRESS');
    assert.match(err.message, /run the-holder \(process \d+, claimed \d+ minute\(s\) ago\)/);
    assert.ok(err.message.includes(`node scripts/ledger/cli.js forget --key "${key}" --force`));
    assert.deepEqual([err.details.key, err.details.runId, err.details.pid], [key, 'the-holder', process.ppid]);
    assert.ok(err.details.claimedAt);
  });

  test('a claim from ANOTHER machine cannot be checked: it is resumed at once (documented), and the adapter\'s marker adopts whatever it wrote', async () => {
    const w = workspace('github');
    const adapter = adapterFor(w);
    const l = openLedger({ dir: ledgerOf(w) });
    openLedger({ dir: ledgerOf(w), host: 'build-farm-7', pid: 4242 }).claim(keyOf(w, 'create-bug', input.idempotencyKey), { runId: 'elsewhere' });
    const r = await runOnce(adapter, 'create-bug', input, { ledger: l, runId: 'here' });
    assert.equal(r.resumed, true);
    assert.equal(l.readClaim(keyOf(w, 'create-bug', input.idempotencyKey)).previousFailure.code, 'OWNER_GONE', 'and the takeover says why it happened');
  });

  test('a key another resumer finished while we were deciding is answered from the ledger, not reported as busy', async () => {
    const w = workspace('github');
    const adapter = adapterFor(w);
    const key = keyOf(w, 'create-bug', input.idempotencyKey);
    openLedger({ dir: ledgerOf(w), pid: deadPid() }).claim(key, { runId: 'dead' });
    const l = openLedger({ dir: ledgerOf(w) });
    const realClaim = l.claim.bind(l);
    let n = 0;
    l.claim = (k, o) => { n += 1; if (n === 2) { const other = openLedger({ dir: ledgerOf(w) }); other.fail(k, { code: 'OWNER_GONE' }); other.claim(k, { runId: 'quick' }); other.complete(k, { id: '55', url: 'https://t/55' }); } return realClaim(k, o); };
    const r = await runOnce(adapter, 'create-bug', input, { ledger: l, runId: 'slow' });
    assert.deepEqual([r.id, r.url, r.fromLedger], ['55', 'https://t/55', true]);
    assert.equal(w.mock.createdItems().length, 0);
  });

  test('a failure that is not a TrackerError is recorded on the claim as UNEXPECTED, so the key can be claimed again', async () => {
    const w = workspace('github');
    const adapter = adapterFor(w);
    adapter.createBug = async () => { throw new TypeError('a bug in the adapter'); };
    const l = openLedger({ dir: ledgerOf(w) });
    await assert.rejects(() => runOnce(adapter, 'create-bug', input, { ledger: l, runId: 'r' }), TypeError);
    const claim = l.readClaim(keyOf(w, 'create-bug', input.idempotencyKey));
    assert.deepEqual([claim.state, claim.error.code], ['failed', 'UNEXPECTED']);
  });

  test('with no run id the audit records belong to "unattributed", with no warning; the url a ledger answer carries is the original\'s', async () => {
    const w = workspace('github');
    const warnings = [];
    const l = openLedger({ dir: ledgerOf(w) });
    const first = await runOnce(adapterFor(w), 'create-bug', input, { ledger: l, warn: (m) => warnings.push(m) });
    assert.deepEqual(warnings, []);
    const audit = l.readAudit().events;
    assert.ok(audit.length >= 2 && audit.every((e) => e.runId === 'unattributed'));
    assert.deepEqual(audit.map((e) => [e.type, e.step]), [['action.claimed', 'create-bug'], ['action.done', undefined]]);
    const again = await runOnce(adapterFor(w), 'create-bug', input, { ledger: l });
    assert.deepEqual([again.id, again.url, again.fromLedger], [String(first.id), first.url, true]);
  });

  test('the key says WHERE the tracker points: the same key after the repository setting changed is a different write, and is not answered from the old one', async () => {
    const mkAdapter = (repo, mock) => createAdapter('github', { settings: { repo }, env: { GITHUB_TOKEN: mock.token }, fetch: mock.fetch, baseUrl: mock.baseUrl, timeoutMs: 500, retryDelayMs: 0 });
    const a = createGithubMock({ repo: 'acme/shop' });
    const b = createGithubMock({ repo: 'acme/other' });
    const adA = mkAdapter('acme/shop', a); const adB = mkAdapter('acme/other', b);
    assert.notEqual(adA.target, adB.target);
    assert.equal(mkAdapter('acme/shop', a).target, adA.target, 'the same settings, the same target');
    assert.notEqual(ledgerKey(adA, 'create-bug', 'k'), ledgerKey(adB, 'create-bug', 'k'));
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-target-'));
    const l = openLedger({ dir });
    await runOnce(adA, 'create-bug', input, { ledger: l, runId: 'r' });
    const onB = await runOnce(adB, 'create-bug', input, { ledger: l, runId: 'r' });
    assert.equal(onB.deduplicated, false, 'the other repository gets its own bug');
    assert.equal(a.createdItems().length + b.createdItems().length, 2);
    assert.equal(Object.keys(adA).includes('target'), false, 'the target is not an enumerable property of the adapter');
  });

  test('a link failure on a case the ledger says exists says how to reset it', async () => {
    const w = workspace('gitlab');
    const first = await w.post(withLedger(w, ['--only', 'TC-001']));
    assert.equal(first.code, 0, first.out);
    const id = first.json.tests[0].id;
    w.mock.inject({ method: 'POST', match: '.*', status: 404, times: 5 });
    const again = await w.post(withLedger(w, ['--only', 'TC-001']));
    const entry = again.json.tests[0];
    assert.equal(entry.fromLedger, true);
    assert.equal(entry.id, id);
    assert.ok(entry.linkError, "the link failed (the mock answers 404)");
    assert.match(entry.hint, /scripts\/ledger\/cli\.js forget --key "gitlab~[0-9a-f]{8}\/create-test\//);
  });
});

describe('opt-in, and the shapes: adding the ledger changed nothing for a project without one', () => {
  const stream = () => { const t = { text: '', write(x) { t.text += x; } }; return t; };
  const cliRun = async (w, argv, cfg = w.config) => { const stdout = stream(); const stderr = stream(); const code = await cliMain({ argv: [...argv, '--config', cfg, '--base-url', w.mock.baseUrl], env: { [w.mock.tokenEnv]: w.mock.token }, fetch: w.mock.fetch, stdout, stderr }); return { code, out: stdout.text, err: stderr.text, json: stdout.text ? JSON.parse(stdout.text) : null }; };
  const bug = { title: 'T', body: 'b', idempotencyKey: 'fp-abc123abc123-run1' };
  const broken = (w, body) => { const f = path.join(w.dir, 'broken.json'); fs.writeFileSync(f, body); return f; };

  test('a config that cannot be read fails exactly as it did before the ledger existed: a JSON CONFIG error (exit 1) from the tracker commands (and see plan-ledger.test.js for the planner)', async () => {
    const w = workspace('github');
    const nul = await cliRun(w, ['create-bug', '--input', JSON.stringify(bug)], broken(w, 'null'));
    assert.equal(nul.code, 1, 'a config that is just null was never a clean CONFIG error; it still is not, and is still JSON on stdout');
    assert.equal(nul.json.ok, false);
    for (const body of ['{ not json', '', '[]']) {
      const cfg = broken(w, body);
      const r = await cliRun(w, ['create-bug', '--input', JSON.stringify(bug)], cfg);
      assert.equal(r.code, 1, `${JSON.stringify(body)}: ${r.err}`);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.error.code, 'CONFIG');
      assert.equal(r.err, '', 'nothing on stderr: the answer is the JSON');
    }
    assert.equal(w.mock.createdItems().length, 0);
  });

  test('a ledger block that is itself bad still stops a keyed write (someone who wrote one meant it), before any request', async () => {
    const w = workspace('github');
    const cfg = path.join(w.dir, 'bad-ledger.json');
    fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(w.config, 'utf8')), ledger: { retentionDays: 0 } }));
    const seen = w.mock.calls.length;
    const r = await cliRun(w, ['create-bug', '--input', JSON.stringify(bug)], cfg);
    assert.equal(r.code, 2);
    assert.match(r.err, /ledger.retentionDays/);
    assert.equal(w.mock.calls.length, seen);
  });

  test('no ledger: no `warnings`, no `fromLedger`, no `resumed`, no `hint` anywhere in the output of post-tests or the CLI', async () => {
    const w = workspace('github');
    const first = await w.post();
    const second = await w.post();
    for (const r of [first, second]) {
      assert.equal(r.json.warnings, undefined);
      assert.ok(r.json.tests.every((t) => t.fromLedger === undefined && t.resumed === undefined && t.hint === undefined));
    }
    const a = await cliRun(w, ['create-bug', '--input', JSON.stringify(bug)]);
    assert.equal(a.json.warnings, undefined);
    assert.deepEqual(Object.keys(a.json).sort(), ['data', 'ok']);
  });

  test('an allowed read with an empty --ledger-dir is not validated (the ledger is never opened for it), and --run-id reaches the audit record of a write that is', async () => {
    const w = workspace('github');
    const read = await cliRun(w, ['fetch', '--input', JSON.stringify({ id: w.parent }), '--ledger-dir', '']);
    assert.equal(read.code, 0, read.err);
    const wrote = await cliRun(w, ['create-bug', '--input', JSON.stringify(bug), '--ledger-dir', ledgerOf(w), '--run-id', 'run-a']);
    assert.equal(wrote.code, 0, wrote.err);
    assert.ok(openLedger({ dir: ledgerOf(w) }).readAudit().events.every((e) => e.runId === 'run-a'));
    const other = await cliRun(w, ['create-bug', '--input', JSON.stringify({ ...bug, idempotencyKey: 'another-key' }), '--ledger-dir', ledgerOf(w), '--run-id', 'run-b']);
    assert.equal(other.code, 0);
    assert.deepEqual([...new Set(openLedger({ dir: ledgerOf(w) }).readAudit().events.map((e) => e.runId))].sort(), ['run-a', 'run-b']);
  });

  test('everything the ledger adds to the output validates against the schemas: a ledger-answered create and comment, the keys file of a ledger run, the IN_PROGRESS error', async () => {
    const w = workspace('github');
    const created = await cliRun(w, ['create-bug', '--input', JSON.stringify(bug), ...withLedger(w)]);
    assertValid('tracker-create-result', created.json.data);
    const again = await cliRun(w, ['create-bug', '--input', JSON.stringify(bug), ...withLedger(w)]);
    assert.equal(again.json.data.fromLedger, true);
    assertValid('tracker-create-result', again.json.data);
    const comment = { id: w.parent, body: 'again', idempotencyKey: 'fp-abc123abc123-run2-comment' };
    await cliRun(w, ['comment', '--input', JSON.stringify(comment), ...withLedger(w)]);
    const answered = await cliRun(w, ['comment', '--input', JSON.stringify(comment), ...withLedger(w)]);
    assert.equal(answered.json.data.fromLedger, true);
    assertValid('tracker-comment-result', answered.json.data);
    const p = workspace('github');
    await p.post(withLedger(p));
    const second = await p.post(withLedger(p));
    assert.ok(second.json.tests.every((t) => t.fromLedger));
    assertValid('test-keys', p.keys());
    openLedger({ dir: ledgerOf(p), pid: process.ppid }).claim(keyOf(p, 'create-bug', 'held'), { runId: 'x' });
    const busy = await cliRun(p, ['create-bug', '--input', JSON.stringify({ ...bug, idempotencyKey: 'held' }), ...withLedger(p)]);
    assert.equal(busy.json.error.code, 'IN_PROGRESS');
    assertValid('tracker-error', busy.json.error);
    // a resumed one
    openLedger({ dir: ledgerOf(p), pid: deadPid() }).claim(keyOf(p, 'create-bug', 'resumable'), { runId: 'dead' });
    const resumed = await cliRun(p, ['create-bug', '--input', JSON.stringify({ ...bug, idempotencyKey: 'resumable' }), ...withLedger(p)]);
    assert.equal(resumed.json.data.resumed, true);
    assertValid('tracker-create-result', resumed.json.data);
  });
});
