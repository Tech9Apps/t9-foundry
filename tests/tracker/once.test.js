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
const { connect } = require('../../scripts/tracker/lib/connect');
const { openLedger } = require('../../scripts/ledger/lib/ledger');
const { workspace: makeWorkspace, MOCKS } = require('./workspace');

const CASES_MD = path.join(__dirname, '..', '..', 'demo', 'expected', 'DEMO-101-test-cases.md');
const N = 10;
const workspace = (type) => makeWorkspace(type, { casesFile: CASES_MD });
const ledgerOf = (w) => path.join(w.dir, 'ledger');
const withLedger = (w, extra = []) => ['--ledger-dir', ledgerOf(w), '--run-id', 'run-a', ...extra];
const creates = (w, from = 0) => w.mock.calls.slice(from).filter((c) => c.method === 'POST' && new RegExp(w.mock.paths.create).test(c.path));
const searches = (w, from = 0) => w.mock.calls.slice(from).filter((c) => new RegExp(w.mock.paths.search).test(c.path));
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid; // a process that has already exited
const tcKey = (w, id) => `${w.type}/create-test/${w.parent}-${id}`;

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
      assert.equal(l.doneClaims((k) => k.startsWith(`${type}/create-test/`)).length, N);
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
      const l = openLedger({ dir: ledgerOf(w) });
      assert.equal(l.claim(tcKey(w, 'TC-003'), { runId: 'someone-else' }).won, true); // this very process: alive
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
    openLedger({ dir: ledgerOf(w) }).claim(`github/create-bug/${bug.idempotencyKey}`, { runId: 'someone-else' });
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
    assert.equal(ledgerCli({ argv: ['forget', '--key', `github/create-bug/${bug.idempotencyKey}`, '--dir', ledgerOf(w)], env: {}, stdout: out, stderr: stream() }), 0);
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
    dead.claim(`github/create-bug/${input.idempotencyKey}`, { runId: 'dead' });
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
