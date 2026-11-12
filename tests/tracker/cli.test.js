'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { main } = require('../../scripts/tracker/cli');
const { createGithubMock } = require('../mocks/tracker-mock/github');
const { createClickupMock } = require('../mocks/tracker-mock/clickup');
const { assertValid } = require('./helpers');

function tmpdir() {
  return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-cli-'));
}

// Run the CLI in-process with injected fetch/env/stdin; capture stdout/stderr/exit code.
async function cli(args, { env = {}, fetch, stdin } = {}) {
  let out = '';
  let err = '';
  const code = await main({
    argv: args,
    env,
    fetch,
    stdin: stdin === undefined ? Readable.from([]) : Readable.from([Buffer.from(stdin)]),
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err, json: out ? JSON.parse(out) : null };
}

describe('tracker CLI', () => {
  const dir = tmpdir();
  const config = (extra = {}) => {
    const file = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify({ ticketSource: { type: 'github', github: { repo: 'acme/shop' }, ...extra } }));
    return file;
  };

  test('fetch: reads the config, uses env credentials, prints { ok: true, data } and exits 0', async () => {
    const mock = createGithubMock();
    const id = mock.seedTicket({ title: 'Apply a discount code', description: 'd' });
    const r = await cli(['fetch', '--config', config(), '--input', JSON.stringify({ id }), '--base-url', mock.baseUrl], { env: { GITHUB_TOKEN: mock.token }, fetch: mock.fetch });
    assert.equal(r.code, 0);
    assert.equal(r.json.ok, true);
    assertValid('tracker-ticket', r.json.data);
    assert.equal(r.json.data.title, 'Apply a discount code');
  });

  test('input can come from --input-file and from --stdin', async () => {
    const mock = createGithubMock();
    const id = mock.seedTicket({ title: 'T' });
    const file = path.join(dir, 'in.json');
    fs.writeFileSync(file, JSON.stringify({ id }));
    const env = { GITHUB_TOKEN: mock.token };
    const a = await cli(['fetch', '--config', config(), '--input-file', file, '--base-url', mock.baseUrl], { env, fetch: mock.fetch });
    const b = await cli(['fetch', '--config', config(), '--stdin', '--base-url', mock.baseUrl], { env, fetch: mock.fetch, stdin: JSON.stringify({ id }) });
    assert.equal(a.json.data.id, id);
    assert.equal(b.json.data.id, id);
  });

  test('stdin is never read unless --stdin is given (no hang on an inherited pipe)', async () => {
    const hanging = new Readable({ read() {} }); // never ends
    const r = await cli(['fetch', '--config', config()], { stdin: undefined });
    assert.equal(r.code, 2);
    assert.match(r.err, /no input/);
    void hanging;
  });

  test('--source overrides the config, and a source with no adapter is a CONFIG error (exit 1)', async () => {
    const r = await cli(['fetch', '--config', config(), '--source', 'jira', '--input', '{"id":"X-1"}'], { env: {} });
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, 'CONFIG');
    assert.match(r.json.error.message, /no tracker adapter for "jira"/);
    assertValid('tracker-error', r.json.error);
  });

  test('ticketSource.type "none" says there is no tracker', async () => {
    const file = path.join(dir, 'none.json');
    fs.writeFileSync(file, JSON.stringify({ ticketSource: { type: 'none' } }));
    const r = await cli(['fetch', '--config', file, '--input', '{"id":"1"}']);
    assert.equal(r.code, 1);
    assert.match(r.json.error.message, /no tracker to talk to/);
  });

  test('a tracker failure is { ok: false, error } with exit 1 and the retriable flag', async () => {
    const mock = createGithubMock();
    const r = await cli(['fetch', '--config', config(), '--input', JSON.stringify({ id: mock.missingId }), '--base-url', mock.baseUrl], { env: { GITHUB_TOKEN: mock.token }, fetch: mock.fetch });
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'NOT_FOUND');
    assert.equal(r.json.error.retriable, false);
  });

  test('a missing token is CONFIG, and the token value never appears in output', async () => {
    const mock = createGithubMock();
    const missing = await cli(['fetch', '--config', config(), '--input', '{"id":"1"}'], { env: {}, fetch: mock.fetch });
    assert.equal(missing.json.error.code, 'CONFIG');

    const secret = 'ghp_SUPERSECRETVALUE123';
    const wrong = await cli(['fetch', '--config', config(), '--input', '{"id":"1"}', '--base-url', mock.baseUrl], { env: { GITHUB_TOKEN: secret }, fetch: mock.fetch });
    assert.equal(wrong.json.error.code, 'UNAUTHENTICATED');
    assert.ok(!wrong.out.includes(secret) && !wrong.err.includes(secret), 'the token must never be printed');
  });

  test('create-bug with an idempotencyKey is safe to run twice', async () => {
    const mock = createGithubMock();
    const args = ['create-bug', '--config', config(), '--base-url', mock.baseUrl, '--input', JSON.stringify({ title: 'Coupon stacks', body: 'details', idempotencyKey: 'run-1-bug-1' })];
    const env = { GITHUB_TOKEN: mock.token };
    const first = await cli(args, { env, fetch: mock.fetch });
    const second = await cli(args, { env, fetch: mock.fetch });
    assert.equal(first.json.data.deduplicated, false);
    assert.equal(second.json.data.deduplicated, true);
    assert.equal(second.json.data.id, first.json.data.id);
    assert.equal(mock.createdItems().length, 1);
  });

  test('the same CLI drives a different tracker purely through config', async () => {
    const mock = createClickupMock();
    const id = mock.seedTicket({ title: 'ClickUp story' });
    const file = path.join(dir, 'cu.json');
    fs.writeFileSync(file, JSON.stringify({ ticketSource: { type: 'clickup', clickup: mock.settings } }));
    const r = await cli(['fetch', '--config', file, '--input', JSON.stringify({ id }), '--base-url', mock.baseUrl], { env: { CLICKUP_TOKEN: mock.token }, fetch: mock.fetch });
    assert.equal(r.json.data.source, 'clickup');
    assert.equal(r.json.data.title, 'ClickUp story');
  });

  test('config is found via CLAUDE_PROJECT_DIR when --config is not given', async () => {
    const project = tmpdir();
    fs.writeFileSync(path.join(project, 'qa-config.json'), JSON.stringify({ ticketSource: { type: 'github', github: { repo: 'acme/shop' } } }));
    const mock = createGithubMock();
    const id = mock.seedTicket({ title: 'x' });
    const r = await cli(['fetch', '--input', JSON.stringify({ id }), '--base-url', mock.baseUrl], { env: { CLAUDE_PROJECT_DIR: project, GITHUB_TOKEN: mock.token }, fetch: mock.fetch });
    assert.equal(r.json.ok, true);
  });

  test('QA_TRACKER_BASE_URL is honoured', async () => {
    const mock = createGithubMock();
    const id = mock.seedTicket({ title: 'x' });
    const r = await cli(['fetch', '--config', config(), '--input', JSON.stringify({ id })], { env: { GITHUB_TOKEN: mock.token, QA_TRACKER_BASE_URL: mock.baseUrl }, fetch: mock.fetch });
    assert.equal(r.json.ok, true);
    assert.ok(mock.calls.length > 0);
  });

  test('fetch --context-file also writes the pipeline ticket-context JSON (creating directories)', async () => {
    const mock = createGithubMock();
    const id = mock.seedTicket({ title: 'Apply a discount code', description: 'd', acceptance: '1. a\n2. b', labels: ['bug'], comments: [{ author: 'pm', body: 'hi' }] });
    const target = path.join(tmpdir(), 'nested', '.ticket-context', 'DEMO-101.json');
    const r = await cli(['fetch', '--config', config(), '--input', JSON.stringify({ id }), '--base-url', mock.baseUrl, '--context-file', target], { env: { GITHUB_TOKEN: mock.token }, fetch: mock.fetch });
    assert.equal(r.code, 0);
    const ctx = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(ctx.ticketId, id);
    assert.equal(ctx.summary, 'Apply a discount code');
    assert.equal(ctx.issueType, 'Bug');
    assert.match(ctx.acceptanceCriteria, /1\. a/);
    assert.deepEqual(ctx.comments.map((c) => c.body), ['hi']);
    for (const key of ['ticketId', 'summary', 'issueType', 'status', 'priority', 'labels', 'description', 'acceptanceCriteria', 'attachments', 'comments', 'subtasks']) {
      assert.ok(key in ctx, `ticket context must keep the field "${key}" that the pipeline commands read`);
    }
  });

  test('a failed fetch writes no context file', async () => {
    const mock = createGithubMock();
    const target = path.join(tmpdir(), 'never.json');
    const r = await cli(['fetch', '--config', config(), '--input', JSON.stringify({ id: mock.missingId }), '--base-url', mock.baseUrl, '--context-file', target], { env: { GITHUB_TOKEN: mock.token }, fetch: mock.fetch });
    assert.equal(r.code, 1);
    assert.equal(fs.existsSync(target), false);
  });

  test('--context-file on any operation but fetch is a usage error', async () => {
    const r = await cli(['comment', '--config', config(), '--input', '{"id":"1","body":"x"}', '--context-file', '/tmp/x.json']);
    assert.equal(r.code, 2);
    assert.match(r.err, /only applies to fetch/);
  });

  test('bad invocations exit 2 with a message on stderr, not stdout', async () => {
    for (const args of [[], ['frobnicate'], ['fetch', '--bogus'], ['fetch', '--input']]) {
      const r = await cli(args);
      assert.equal(r.code, 2, `args: ${JSON.stringify(args)}`);
      assert.equal(r.out, '');
      assert.ok(r.err.length > 0);
    }
  });

  test('malformed JSON input is a usage error (exit 2)', async () => {
    const r = await cli(['fetch', '--config', config(), '--input', '{nope']);
    assert.equal(r.code, 2);
    assert.match(r.err, /not valid JSON/);
  });

  test('contract validation errors surface as { ok: false } with VALIDATION (exit 1)', async () => {
    const mock = createGithubMock();
    const r = await cli(['create-bug', '--config', config(), '--input', '{"title":"x"}'], { env: { GITHUB_TOKEN: mock.token }, fetch: mock.fetch });
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'VALIDATION');
    assert.equal(mock.calls.length, 0);
  });
});

// The flags that choose and reach a tracker are defined once (connect.js CONNECT_FLAGS). These check that each one really reaches the
// adapter — the other tests hand the mock a --base-url its fetch never looks at, so a flag that stopped working would pass them.
describe('the connection flags reach the adapter', () => {
  const dir = tmpdir();
  const config = (ticketSource) => {
    const file = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify({ ticketSource }));
    return file;
  };
  const github = config({ type: 'github', github: { repo: 'acme/shop' } });

  test('--base-url decides where the request goes', async () => {
    const mock = createGithubMock();
    const id = mock.seedTicket({ title: 'T' });
    const seen = [];
    const fetch = (url, init) => { seen.push(String(url)); return mock.fetch(String(url).replace('https://override.example.test/api', mock.baseUrl), init); };
    const r = await cli(['fetch', '--config', github, '--input', JSON.stringify({ id }), '--base-url', 'https://override.example.test/api'], { env: { GITHUB_TOKEN: mock.token }, fetch });
    assert.equal(r.code, 0, r.out);
    assert.ok(seen.length > 0 && seen.every((u) => u.startsWith('https://override.example.test/api/')), seen.join('\n'));
  });

  test('--timeout-ms is the per-request timeout', { timeout: 10000 }, async () => {
    // AbortSignal.timeout's timer does not keep the process alive (a real socket would), so this fake request does, until it is aborted
    const hangs = (url, init) => new Promise((resolve, reject) => {
      const hold = setTimeout(() => {}, 30000);
      init.signal.addEventListener('abort', () => { clearTimeout(hold); reject(init.signal.reason); });
    });
    const started = Date.now();
    const r = await cli(['fetch', '--config', github, '--input', '{"id":"1"}', '--timeout-ms', '20'], { env: { GITHUB_TOKEN: 'x'.repeat(12) }, fetch: hangs });
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'TIMEOUT');
    assert.ok(Date.now() - started < 5000, 'it gave up at 20 ms per try, not the 15 s default');
  });

  test('--source overrides the type in the config', async () => {
    const r = await cli(['fetch', '--config', github, '--input', '{"id":"1"}', '--source', 'gitlab'], { env: { GITHUB_TOKEN: 'x'.repeat(12) } });
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'CONFIG');
    assert.match(r.json.error.message, /ticketSource\.gitlab\.projectId/);
  });

  test('every script that connects takes exactly the same four flags, defined once', () => {
    const { CONNECT_FLAGS } = require('../../scripts/tracker/lib/connect');
    assert.deepEqual(Object.keys(CONNECT_FLAGS).sort(), ['--base-url', '--config', '--source', '--timeout-ms']);
    for (const script of ['tracker/cli', 'tracker/post-tests', 'tracker/smoke', 'triage/plan']) {
      const { FLAGS } = require(`../../scripts/${script}`);
      for (const [flag, spec] of Object.entries(CONNECT_FLAGS)) assert.equal(FLAGS[flag], spec, `${script} ${flag}`);
    }
  });
});
