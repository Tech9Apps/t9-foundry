#!/usr/bin/env node
'use strict';

// Post a ticket's manual test cases to the configured tracker — idempotently, resumably, and with a
// per-case record of what happened.
//
//   node scripts/tracker/post-tests.js --parent <ticket-id> [--cases <md>] [--keys-file <json>]
//                                       [--only TC-001,TC-003] [--dry-run]
//                                       [--source T] [--config P] [--base-url U] [--timeout-ms N]
//
//   --cases      default tests/cases/<parent>.md   (the format create-manual-test-cases.md writes)
//   --keys-file  default tests/cases/.ticket-context/<parent>-test-keys.json
//   --only       post just these cases (e.g. to retry the ones that failed)
//   --dry-run    parse and print the plan; no tracker, no credentials, nothing written
//
// Each case is created with idempotency key "<parent>-<TC-id>" and then linked to the parent, so:
//   * re-running is always safe — existing cases are returned, not duplicated;
//   * a case a previous run left half-built is completed;
//   * the parent ticket is fetched first: an unknown parent or bad credentials fail the whole run
//     before anything is created (no orphaned test cases);
//   * one failing case does not stop the others — but a failure that would hit every remaining case
//     the same way (credentials revoked mid-run, rate limiting) stops the run and marks the rest skipped.
//
// Output: one JSON document on stdout. Exit 0 = every case created/found AND linked; 1 = something
// failed or was skipped (the keys file says exactly what); 2 = bad invocation.

const fs = require('fs');
const path = require('path');
const { run } = require('./adapters');
const { connect } = require('./lib/connect');
const { TrackerError } = require('./lib/errors');
const { parseTestCases, lintTestCases } = require('./lib/test-cases');

// Failing every remaining case the same way helps nobody: stop and report.
const SYSTEMIC = new Set(['UNAUTHENTICATED', 'FORBIDDEN', 'CONFIG', 'NOT_FOUND', 'RATE_LIMITED']);

const usage = (message) => Object.assign(new Error(message), { isUsage: true });

function parseArgs(argv) {
  const opts = {};
  for (let n = 0; n < argv.length; n += 1) {
    const flag = argv[n];
    const value = () => {
      if (n + 1 >= argv.length) throw usage(`${flag} needs a value`);
      n += 1;
      return argv[n];
    };
    if (flag === '--parent') opts.parent = value();
    else if (flag === '--cases') opts.cases = value();
    else if (flag === '--keys-file') opts.keysFile = value();
    else if (flag === '--only') opts.only = value().split(',').map((s) => s.trim()).filter(Boolean);
    else if (flag === '--dry-run') opts.dryRun = true;
    else if (flag === '--source') opts.source = value();
    else if (flag === '--config') opts.config = value();
    else if (flag === '--base-url') opts.baseUrl = value();
    else if (flag === '--timeout-ms') opts.timeoutMs = Number(value());
    else throw usage(`unknown option ${flag}`);
  }
  if (!opts.parent) throw usage('--parent <ticket-id> is required');
  return opts;
}

const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function readKeys(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeKeysAtomically(file, doc) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file); // never leave a half-written keys file behind a crash
}

async function main({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr, fetch = globalThis.fetch, now = Date.now } = {}) {
  const out = (obj) => stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write('Usage: post-tests.js --parent <id> [--cases <md>] [--keys-file <json>] [--only TC-001,..] [--dry-run] [--source T] [--config P] [--base-url U] [--timeout-ms N]\n');
      return argv.length ? 0 : 2;
    }
    const opts = parseArgs(argv);
    const casesFile = opts.cases || path.join('tests', 'cases', `${opts.parent}.md`);
    const keysFile = opts.keysFile || path.join('tests', 'cases', '.ticket-context', `${opts.parent}-test-keys.json`);

    if (!fs.existsSync(casesFile)) {
      throw new TrackerError('VALIDATION', `no test cases at ${casesFile} — run /create-manual-test-cases ${opts.parent} first`);
    }
    const md = fs.readFileSync(casesFile, 'utf8');
    const unreadable = lintTestCases(md);
    if (unreadable.length) {
      throw new TrackerError('VALIDATION', `${casesFile} cannot be posted as it stands (nothing was created): ${unreadable.join('; ')}`);
    }
    const all = parseTestCases(md);
    if (!all.length) {
      throw new TrackerError('VALIDATION', `${casesFile} has no test cases (expected blocks that start "### TC-001: Title")`);
    }
    let selected = all;
    if (opts.only) {
      const unknown = opts.only.filter((id) => !all.some((c) => c.tcId === id));
      if (unknown.length) throw usage(`--only names cases that are not in ${casesFile}: ${unknown.join(', ')}`);
      selected = all.filter((c) => opts.only.includes(c.tcId));
    }

    if (opts.dryRun) {
      out({
        ok: true, dryRun: true, parent: opts.parent, casesFile, total: selected.length,
        tests: selected.map((c) => ({ tcId: c.tcId, summary: c.title, priority: c.priority || null, steps: c.steps.length, idempotencyKey: `${slug(opts.parent)}-${c.tcId}` })),
      });
      return 0;
    }

    const adapter = connect({ configPath: opts.config, source: opts.source, baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs, env, fetch });

    // Check the parent exists (and the credentials work) BEFORE creating anything. Some trackers only
    // reference the parent, so without this a typo'd ticket id would quietly create N orphaned test cases.
    await run(adapter, 'fetch', { id: opts.parent });

    // Entries for cases we are NOT touching this run (--only) are carried over untouched.
    const prior = readKeys(keysFile);
    const entries = new Map(((prior && prior.tests) || []).map((e) => [e.tcId, e]));
    const persist = () => writeKeysAtomically(keysFile, {
      parentTicket: opts.parent,
      source: adapter.source,
      casesFile,
      updatedAt: new Date(now()).toISOString(),
      tests: all.map((c) => entries.get(c.tcId)).filter(Boolean),
    });

    let stopped = null;
    for (const tc of selected) {
      if (stopped) {
        entries.set(tc.tcId, { tcId: tc.tcId, summary: tc.title, status: 'skipped', linked: false, reason: `run stopped after ${stopped.code}` });
        continue;
      }
      const entry = { tcId: tc.tcId, summary: tc.title, status: 'failed', linked: false };
      try {
        const created = await run(adapter, 'create-test', {
          parentId: opts.parent, tcId: tc.tcId, title: tc.title, description: tc.description, priority: tc.priority, steps: tc.steps,
          idempotencyKey: `${slug(opts.parent)}-${tc.tcId}`,
        });
        entry.status = created.deduplicated ? 'deduplicated' : 'created';
        entry.id = created.id;
        if (created.url) entry.url = created.url;
        if (created.repaired) entry.repaired = true;
        try {
          const link = await run(adapter, 'link', { childId: created.id, parentId: opts.parent });
          entry.linked = link.linked;
        } catch (linkErr) {
          if (!(linkErr instanceof TrackerError)) throw linkErr;
          entry.linkError = linkErr.toJSON(); // created but not linked: a re-run links it, nothing is duplicated
        }
      } catch (err) {
        if (!(err instanceof TrackerError)) throw err;
        entry.error = err.toJSON();
        if (err.details && err.details.partial) entry.partial = err.details.partial;
        if (SYSTEMIC.has(err.code)) stopped = err;
      }
      entries.set(tc.tcId, entry);
      persist(); // after every case: a crash loses at most the case in flight
    }
    persist();

    const mine = selected.map((c) => entries.get(c.tcId));
    const count = (pred) => mine.filter(pred).length;
    const summary = {
      created: count((e) => e.status === 'created'),
      deduplicated: count((e) => e.status === 'deduplicated'),
      linked: count((e) => e.linked === true),
      failed: count((e) => e.status === 'failed'),
      skipped: count((e) => e.status === 'skipped'),
      linkFailed: count((e) => e.linkError),
    };
    const ok = summary.failed === 0 && summary.skipped === 0 && summary.linkFailed === 0;
    out({ ok, parent: opts.parent, source: adapter.source, total: selected.length, ...summary, keysFile, tests: mine });
    return ok ? 0 : 1;
  } catch (err) {
    if (err && err.isUsage) {
      stderr.write(`post-tests.js: ${err.message}\n`);
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

module.exports = { main };
