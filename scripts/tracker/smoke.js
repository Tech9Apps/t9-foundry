#!/usr/bin/env node
'use strict';

// Real-tracker smoke test. The adapters are verified against in-process mocks; this is how a person with
// a token finds out whether the REAL tracker agrees. It creates a few scratch items in the configured
// project, exercises every operation plus the idempotent retry and two failure drills, and reports.
//
//   node scripts/tracker/smoke.js [--source T] [--config P] [--base-url U] [--timeout-ms N]
//                                 [--search-wait-ms N] [--skip-bad-token] [--yes]
//
// Without --yes it only prints what it WOULD do and where — nothing is created. Run it against a scratch
// repo / project / list, never your real one: there is no delete operation (by design), so what it creates
// is left behind, labelled "qa-harness-smoke" (GitHub, GitLab, ClickUp) or titled "[qa-harness smoke <id>]".
//
// Checks: connect · create a bug · fetch it back · search finds it · search finds a marker that is ONLY in the body ·
// create + link a test case ·
// retrying the bug and the test case with the same key returns the originals · comment, and the same
// comment again · an unknown id is NOT_FOUND · a bad token is rejected.
// Each is pass / warn / fail. Warnings are real-world behavior worth knowing about (e.g. search that lags
// behind writes), not broken adapters. Output: one JSON document on stdout, a readable table on stderr.
// Exit: 0 no failures · 1 at least one failure · 2 bad invocation or --yes missing. Tokens are never printed.

const { run } = require('./adapters');
const { connect, findConfig, CONNECT_FLAGS } = require('./lib/connect');
const { readJson, parseFlags, jsonPrinter } = require('../lib/cli');
const { TrackerError } = require('./lib/errors');

const TOKEN_VARS = ['GITHUB_TOKEN', 'GH_TOKEN', 'CLICKUP_TOKEN', 'AZURE_DEVOPS_PAT', 'GITLAB_TOKEN', 'BITBUCKET_TOKEN'];
const UNKNOWN_ID = { github: '999999999', clickup: 'zzzzzzz', azure: '999999999', gitlab: '999999999', bitbucket: '999999999' };
const LABEL = 'qa-harness-smoke';

const FLAGS = {
  ...CONNECT_FLAGS,
  '--search-wait-ms': { key: 'searchWaitMs', parse: Number },
  '--skip-bad-token': { key: 'skipBadToken', set: true },
  '--yes': { key: 'yes', set: true },
};
const parseArgs = (argv) => parseFlags(argv, FLAGS);

// Where it will write, from the config — so the person can see WHICH project before saying --yes. No secrets.
function describeTarget(type, settings) {
  const pick = {
    github: ['repo'], clickup: ['listId'], azure: ['organization', 'project'], gitlab: ['host', 'projectId'], bitbucket: ['workspace', 'repo'],
  }[type] || [];
  // a host is shown as scheme://host only: a URL in the config may carry user:password@, and this text goes to the terminal and into the result JSON
  const show = (k, v) => {
    if (v === undefined) return '(unset)';
    if (k !== 'host') return v;
    try { const u = new URL(String(v)); return `${u.protocol}//${u.host}`; } catch { return '(not a valid URL)'; }
  };
  return pick.map((k) => `${k}=${show(k, settings[k])}`).join(' ');
}

async function main({
  argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr, fetch = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, random = Math.random,
} = {}) {
  const out = jsonPrinter(stdout);
  try {
    if (argv[0] === '-h' || argv[0] === '--help') {
      stderr.write('Usage: smoke.js [--source T] [--config P] [--base-url U] [--timeout-ms N] [--search-wait-ms N] [--skip-bad-token] [--yes]\n');
      return 0;
    }
    const opts = parseArgs(argv);

    // what it would touch — read the config here so the plan can name the target without connecting
    const file = findConfig(opts.config, env);
    let config = {};
    if (file) {
      config = readJson(file, { fail: (message) => new TrackerError('CONFIG', message) });
    }
    const source = opts.source || (config.ticketSource && config.ticketSource.type);
    const settings = (config.ticketSource && source && config.ticketSource[source]) || {};
    const target = source ? describeTarget(source, settings) : '';

    if (!opts.yes) {
      stderr.write(`smoke.js would create scratch items in ${source || '(no tracker configured)'} ${target}\n`
        + 'and leave them behind (there is no delete). Use a scratch repo / project / list. Re-run with --yes to proceed.\n');
      out({ ok: false, dryRun: true, source: source || null, target, error: { code: 'NOT_CONFIRMED', message: 'nothing was created — pass --yes to run against the tracker above' } });
      return 2;
    }

    const runId = `${now().toString(36)}${Math.floor(random() * 1296).toString(36).padStart(2, '0')}`;
    const checks = [];
    const leftovers = [];
    const record = (name, status, detail, ms) => { checks.push({ name, status, detail, ms }); return status; };
    // run one check; `fn` returns a detail string, or { status: 'warn', detail }; throwing is a failure
    async function step(name, fn, { skip } = {}) {
      if (skip) return record(name, 'skipped', skip, 0);
      const t0 = now();
      try {
        const r = await fn();
        const o = typeof r === 'string' || r === undefined ? { status: 'pass', detail: r || '' } : r;
        return record(name, o.status, o.detail, now() - t0);
      } catch (err) {
        const detail = err instanceof TrackerError ? `${err.code}: ${err.message}${err.retriable ? ' (retriable)' : ''}` : `unexpected: ${err && err.message}`;
        return record(name, 'fail', detail, now() - t0);
      }
    }

    let adapter;
    const connected = await step('connect (config + credentials)', () => {
      adapter = connect({ configPath: opts.config, source: opts.source, baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs, env, fetch });
      return `${adapter.source}: ${target}`;
    }) === 'pass';

    const bugKey = `smoke-${runId}-bug`;
    const tcKey = `smoke-${runId}-tc`;
    const commentKey = `smoke-${runId}-comment`;
    const title = `[qa-harness smoke ${runId}] scratch bug — safe to close`;
    // the same kind of marker the triage planner writes into real bugs (qafp + 12 hex), derived from the run id
    const token = `qafp${Buffer.from(runId).toString('hex').slice(0, 12).padEnd(12, '0')}`;
    let bug; let tc;

    const hasBug = await step('create a bug', async () => {
      bug = await run(adapter, 'create-bug', {
        title, body: `Created by scripts/tracker/smoke.js (run ${runId}) to check the tracker adapter against the real service. Safe to close or delete.\n\nqa-harness-fingerprint: ${token}`,
        priority: 'Low', labels: [LABEL], idempotencyKey: bugKey,
      });
      leftovers.push({ kind: 'bug', id: bug.id, url: bug.url });
      if (bug.deduplicated) throw new TrackerError('UPSTREAM_ERROR', 'a brand-new key came back deduplicated — key lookup is matching something it should not');
      if (!bug.id) throw new TrackerError('UPSTREAM_ERROR', 'no id came back');
      return `#${bug.id} ${bug.url || ''}`.trim();
    }, { skip: !connected && 'not connected' }) === 'pass';

    await step('fetch it back', async () => {
      const t = await run(adapter, 'fetch', { id: bug.id });
      if (!t.title || !String(t.title).includes(runId)) throw new TrackerError('UPSTREAM_ERROR', `fetched title "${t.title}" does not contain the run id`);
      return `title round-trips (${String(t.title).length} chars)`;
    }, { skip: !hasBug && 'no bug was created' });

    // Search can lag writes (GitHub's index especially): poll for a while before calling a miss a warning.
    async function pollSearch(query) {
      const budget = opts.searchWaitMs === undefined ? 20000 : opts.searchWaitMs;
      let waited = 0;
      for (let attempt = 1; ; attempt += 1) {
        const r = await run(adapter, 'search', { query, kind: 'bug' });
        if (r.items.some((i) => String(i.id) === String(bug.id))) return { found: true, attempt, waited };
        if (waited >= budget) return { found: false, attempt, waited };
        await sleep(2000);
        waited += 2000;
      }
    }

    await step('search finds it', async () => {
      const r = await pollSearch(runId);
      if (r.found) return `found after ${r.attempt} attempt(s), ~${r.waited}ms`;
      return { status: 'warn', detail: `not in search results after ~${r.waited}ms — the search index lags writes; duplicate detection by search can miss brand-new items (key lookups do not use search)` };
    }, { skip: !hasBug && 'no bug was created' });

    await step('search finds a marker that is only in the body, and fetch returns the body', async () => {
      const t = await run(adapter, 'fetch', { id: bug.id });
      if (!String(t.description || '').includes(token)) throw new TrackerError('UPSTREAM_ERROR', 'fetch did not return the marker from the bug body — triage cannot confirm that a search hit is the same bug');
      const r = await pollSearch(token);
      if (r.found) return `found after ${r.attempt} attempt(s), ~${r.waited}ms`;
      return { status: 'warn', detail: `a token that is only in the bug body was not found by search in ~${r.waited}ms: either the index lags, or this tracker's search does not look in bodies — failure dedupe would then miss existing bugs and file duplicates` };
    }, { skip: !hasBug && 'no bug was created' });

    const hasTc = await step('create a test case under it, then link it', async () => {
      tc = await run(adapter, 'create-test', {
        parentId: String(bug.id), tcId: 'TC-001', title: `smoke ${runId}: scratch test case`, description: 'scratch', priority: 'Low',
        steps: [{ action: 'Open the page', expected: 'It loads' }, { action: 'Click the button', expected: 'Something happens' }], idempotencyKey: tcKey,
      });
      leftovers.push({ kind: 'test-case', id: tc.id, url: tc.url });
      const link = await run(adapter, 'link', { childId: String(tc.id), parentId: String(bug.id) });
      return `#${tc.id}, link method: ${link.method}`;
    }, { skip: !hasBug && 'no bug was created' }) === 'pass';

    await step('retrying the bug with the same key returns the original', async () => {
      const again = await run(adapter, 'create-bug', { title, body: 'retry', priority: 'Low', labels: [LABEL], idempotencyKey: bugKey });
      if (!again.deduplicated || String(again.id) !== String(bug.id)) throw new TrackerError('UPSTREAM_ERROR', `a retry made a second bug (#${again.id}, deduplicated: ${again.deduplicated}) — idempotency does not hold on this tracker`);
      return `same #${again.id}, deduplicated`;
    }, { skip: !hasBug && 'no bug was created' });

    await step('retrying the test case with the same key returns the original', async () => {
      const again = await run(adapter, 'create-test', { parentId: String(bug.id), tcId: 'TC-001', title: `smoke ${runId}: scratch test case`, idempotencyKey: tcKey, steps: [{ action: 'x', expected: 'y' }] });
      if (!again.deduplicated || String(again.id) !== String(tc.id)) throw new TrackerError('UPSTREAM_ERROR', `a retry made a second test case (#${again.id}, deduplicated: ${again.deduplicated})`);
      return `same #${again.id}, deduplicated`;
    }, { skip: !hasTc && 'no test case was created' });

    await step('comment, and the same comment again', async () => {
      const first = await run(adapter, 'comment', { id: String(bug.id), body: `smoke ${runId}: results comment`, idempotencyKey: commentKey });
      if (first.deduplicated) throw new TrackerError('UPSTREAM_ERROR', 'a brand-new comment key came back deduplicated');
      const again = await run(adapter, 'comment', { id: String(bug.id), body: `smoke ${runId}: results comment`, idempotencyKey: commentKey });
      if (!again.deduplicated) throw new TrackerError('UPSTREAM_ERROR', 'the same comment key posted a second comment');
      return 'posted once, the retry was deduplicated';
    }, { skip: !hasBug && 'no bug was created' });

    await step('an unknown id is NOT_FOUND', async () => {
      try {
        await run(adapter, 'fetch', { id: UNKNOWN_ID[adapter.source] || '999999999' });
      } catch (err) {
        if (!(err instanceof TrackerError)) throw err;
        if (err.code === 'NOT_FOUND') return 'NOT_FOUND';
        return { status: 'warn', detail: `this tracker answers an unknown id with ${err.code}, not NOT_FOUND: ${err.message}` };
      }
      return { status: 'warn', detail: 'fetching an id that should not exist succeeded — check the probe id for this tracker' };
    }, { skip: !connected && 'not connected' });

    await step('a bad token is rejected', async () => {
      const bad = { ...env };
      for (const k of [...TOKEN_VARS, settings.tokenEnvVar].filter(Boolean)) bad[k] = 'invalid-smoke-token';
      const rogue = connect({ configPath: opts.config, source: opts.source, baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs, env: bad, fetch });
      try {
        await run(rogue, 'fetch', { id: String(bug ? bug.id : UNKNOWN_ID[rogue.source] || '1') });
      } catch (err) {
        if (!(err instanceof TrackerError)) throw err;
        if (err.code === 'UNAUTHENTICATED' || err.code === 'FORBIDDEN') return err.code;
        return { status: 'warn', detail: `expected UNAUTHENTICATED or FORBIDDEN, got ${err.code}: ${err.message}` };
      }
      return { status: 'warn', detail: 'the tracker served a read with an invalid token — probably a public project; auth failures are covered by the mocks only' };
    }, { skip: (opts.skipBadToken && 'skipped by --skip-bad-token') || (!connected && 'not connected') });

    const count = (s) => checks.filter((c) => c.status === s).length;
    const doc = {
      ok: count('fail') === 0, source: adapter ? adapter.source : source || null, target, runId,
      summary: { pass: count('pass'), warn: count('warn'), fail: count('fail'), skipped: count('skipped') }, checks, leftovers,
      cleanup: leftovers.length ? `Left behind in ${target}: close or delete the items above. They carry the label "${LABEL}" where the tracker supports labels, and "[qa-harness smoke ${runId}]" in the title.` : undefined,
    };
    const mark = { pass: '✓', warn: '!', fail: '✗', skipped: '-' };
    stderr.write(`${checks.map((c) => `  ${mark[c.status]} ${c.name}${c.detail ? `  — ${c.detail}` : ''}`).join('\n')}\n\n`
      + `${doc.summary.pass} passed, ${doc.summary.warn} warning(s), ${doc.summary.fail} failed, ${doc.summary.skipped} skipped.\n${doc.cleanup ? `${doc.cleanup}\n` : ''}`);
    out(doc);
    return doc.ok ? 0 : 1;
  } catch (err) {
    if (err && err.isUsage) {
      stderr.write(`smoke.js: ${err.message}\n`);
      return 2;
    }
    if (err instanceof TrackerError) {
      out({ ok: false, error: err.toJSON() });
      return 1;
    }
    out({ ok: false, error: { code: 'UPSTREAM_ERROR', message: `unexpected error: ${err && err.message}`, retriable: false } });
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { main, FLAGS };
