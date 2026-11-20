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
// With a run ledger the ticket is LOCKED while its cases are posted, so two runs do not post one ticket's tests at the same time.
//
// Output: one JSON document on stdout. Exit 0 = every case created/found AND linked; 1 = something
// failed or was skipped (the keys file says exactly what); 2 = bad invocation; 4 = refused, nothing was posted: another run holds this ticket (IN_PROGRESS).

const fs = require('fs');
const path = require('path');
const { run } = require('./adapters');
const { connect, CONNECT_FLAGS } = require('./lib/connect');
const { runOnce, ledgerKey } = require('./lib/once');
const { enabledLedger } = require('../ledger/lib/enable');
const { isValidRunId } = require('../lib/ids');
const { scopesFor, acquireAll, guardSignals } = require('../ledger/lib/locks');
const { usage, parseFlags, jsonPrinter } = require('../lib/cli');
const { TrackerError } = require('./lib/errors');
const { parseTestCases, lintTestCases } = require('./lib/test-cases');

// Failing every remaining case the same way helps nobody: stop and report.
const SYSTEMIC = new Set(['UNAUTHENTICATED', 'FORBIDDEN', 'CONFIG', 'NOT_FOUND', 'RATE_LIMITED']);

const FLAGS = {
  '--parent': { key: 'parent' },
  '--cases': { key: 'cases' },
  '--keys-file': { key: 'keysFile' },
  '--only': { key: 'only', parse: (v) => v.split(',').map((s) => s.trim()).filter(Boolean) },
  '--dry-run': { key: 'dryRun', set: true },
  '--ledger-dir': { key: 'ledgerDir' },
  '--run-id': { key: 'runId', parse: (v, flag) => { if (!isValidRunId(v)) throw usage(`${flag} must be 1-128 characters with no control characters`); return v; } },
  ...CONNECT_FLAGS,
};

function parseArgs(argv) {
  const opts = parseFlags(argv, FLAGS, { strictValues: true }); // the allow rule is `post-tests.js * --dry-run*`: --dry-run must be a flag, never somebody's value
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
  const out = jsonPrinter(stdout);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write('Usage: post-tests.js --parent <id> [--cases <md>] [--keys-file <json>] [--only TC-001,..] [--dry-run] [--source T] [--config P] [--base-url U] [--timeout-ms N] [--ledger-dir D] [--run-id ID]\n');
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

    // With a run ledger (a `ledger` block in qa-config.json, or --ledger-dir) each case is also a CLAIM on the ledger: one the ledger knows is done is not sent to
    // the tracker again, one being written by a live process is not doubled, and one a dead run left half-done is resumed (scripts/tracker/lib/once.js).
    // Without one, the adapter's own idempotency key is what makes a re-run safe, as before. A bad ledger setting stops the run before anything is created.
    const led = enabledLedger({ configPath: opts.config, env, ledgerDir: opts.ledgerDir, now });
    const ledgerWarnings = [];
    // One run at a time per ticket. Taken before anything is read from or written to the tracker; given back however the run ends, including when it is killed.
    // Bookkeeping never blocks a run: a ledger that cannot take the lock is a warning, and the run goes ahead unprotected (the adapter's marker still dedupes).
    let locks = null;
    let disarm = null;
    if (led) {
      try { locks = acquireAll(led.ledger, scopesFor({ ticket: opts.parent }), { runId: opts.runId || `post-tests-${process.pid}` }); } catch (e) { ledgerWarnings.push(`ledger: could not take the ticket lock (${e.message}); this run is not protected from a concurrent one`); }
      if (locks && !locks.ok) {
        const h = locks.holder || {};
        out({ ok: false, error: new TrackerError('IN_PROGRESS', `the test cases of ${opts.parent} are being posted by run ${h.runId || '(unknown)'} since ${h.startedAt || '(unknown)'} (${locks.scope}); nothing was posted`, { details: { scope: locks.scope, runId: h.runId || null, pid: h.pid || null, startedAt: h.startedAt || null } }).toJSON() });
        return 4;
      }
      if (locks) disarm = guardSignals({ release: locks.release });
    }
    try {
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
        const created = await runOnce(adapter, 'create-test', {
          parentId: opts.parent, tcId: tc.tcId, title: tc.title, description: tc.description, priority: tc.priority, steps: tc.steps,
          idempotencyKey: `${slug(opts.parent)}-${tc.tcId}`,
        }, { ledger: led && led.ledger, runId: opts.runId, warn: (m) => { if (!ledgerWarnings.includes(m)) ledgerWarnings.push(m); } });
        entry.status = created.deduplicated ? 'deduplicated' : 'created';
        entry.id = created.id;
        if (created.url) entry.url = created.url;
        if (created.repaired) entry.repaired = true;
        if (created.fromLedger) entry.fromLedger = true; // the ledger already had it: the tracker was not asked to create it again
        if (created.resumed) entry.resumed = true; // a run that died took it over from
        try {
          const link = await run(adapter, 'link', { childId: created.id, parentId: opts.parent });
          entry.linked = link.linked;
        } catch (linkErr) {
          if (!(linkErr instanceof TrackerError)) throw linkErr;
          entry.linkError = linkErr.toJSON(); // created but not linked: a re-run links it, nothing is duplicated
          // the ledger said this case exists and the tracker disagrees: say how to let the next run create it again
          if (created.fromLedger) entry.hint = `the ledger says this case exists (${created.id}); if it was deleted on the tracker, run: node scripts/ledger/cli.js forget --key "${ledgerKey(adapter, 'create-test', `${slug(opts.parent)}-${tc.tcId}`)}" and post again`;
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
    out({ ok, parent: opts.parent, source: adapter.source, total: selected.length, ...summary, keysFile, tests: mine, ...(ledgerWarnings.length ? { warnings: ledgerWarnings } : {}) });
    return ok ? 0 : 1;
    } finally {
      if (disarm) disarm();
      if (locks && locks.ok) locks.release();
    }
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

module.exports = { main, FLAGS };
