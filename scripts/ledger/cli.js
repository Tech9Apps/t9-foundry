#!/usr/bin/env node
'use strict';

// The run ledger from the command line: for the prose commands and for a person after a crash. The design is docs/phase-3-design.md.
//
//   node scripts/ledger/cli.js status                                      what is in the ledger: runs, keys, locks, what looks unfinished
//   node scripts/ledger/cli.js show   --run-id ID                          one run's events (and warnings about anything unreadable)
//   node scripts/ledger/cli.js claim  --key K [--run-id ID]                claim an idempotency key: exactly one caller wins
//   node scripts/ledger/cli.js complete --key K [--id I] [--url U] [--deduplicated]   record that the write for K happened
//   node scripts/ledger/cli.js fail   --key K --code C [--message M]       record that it did not (the key may then be claimed again)
//   node scripts/ledger/cli.js prune  [--run-days N] [--key-days N] [--dry-run]
// Options for every operation: --dir D (default: ledger.dir in qa-config.json, else .qa-ledger) and --config P.
//
// `claim` exits 0 whether it won or not: data.won says which, and when it lost, data.state is `done` (skip it; data.claim.result is what was
// recorded) or `in-flight` (claimed and not finished; data.ownerAlive says whether the claimant is still running on this machine, null when
// it is another one). A caller that gets `in-flight` must reconcile with the tracker before retrying (docs/phase-3-design.md).
// Output: { ok, data } on stdout. Exit: 0 = done · 1 = the ledger could not do it (code in error.code) · 2 = bad invocation.

const { openLedger } = require('./lib/ledger');
const { ledgerConfig, LIMITS } = require('./lib/config');
const { usage, parseFlags, jsonPrinter } = require('../lib/cli');

const MAX_DAYS = 7300;
const OPS = ['status', 'show', 'claim', 'complete', 'fail', 'prune'];
const wholeDays = (v, flag) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < LIMITS.retentionDays[0] || n > MAX_DAYS) throw usage(`${flag} must be a whole number of days from 1`);
  return n;
};

const FLAGS = {
  '--dir': { key: 'dir' },
  '--config': { key: 'config' },
  '--run-id': { key: 'runId' },
  '--key': { key: 'key' },
  '--id': { key: 'id' },
  '--url': { key: 'url' },
  '--deduplicated': { key: 'deduplicated', set: true },
  '--code': { key: 'code' },
  '--message': { key: 'message' },
  '--run-days': { key: 'runDays', parse: wholeDays },
  '--key-days': { key: 'keyDays', parse: wholeDays },
  '--dry-run': { key: 'dryRun', set: true },
};

const need = (opts, flag, key) => { if (opts[key] === undefined) throw usage(`${opts.op} needs ${flag}`); return opts[key]; };

function main({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr, now = Date.now } = {}) {
  const out = jsonPrinter(stdout);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write(`Usage: cli.js <${OPS.join('|')}> [--dir D] [--config P] [--run-id ID] [--key K] [--id I] [--url U] [--deduplicated] [--code C] [--message M] [--run-days N] [--key-days N] [--dry-run]\n`);
      return argv.length ? 0 : 2;
    }
    const op = argv[0];
    if (!OPS.includes(op)) throw usage(`unknown operation ${JSON.stringify(op.slice(0, 40))} (known: ${OPS.join(', ')})`);
    const opts = parseFlags(argv.slice(1), FLAGS, { init: { op } });
    const cfg = ledgerConfig({ configPath: opts.config, env });
    const ledger = openLedger({ dir: opts.dir || cfg.dir, now });

    let data;
    if (op === 'status') data = ledger.status();
    else if (op === 'show') data = ledger.readRun(need(opts, '--run-id', 'runId'));
    else if (op === 'claim') data = ledger.claim(need(opts, '--key', 'key'), { runId: opts.runId });
    else if (op === 'complete') {
      const result = {};
      if (opts.id !== undefined) result.id = opts.id;
      if (opts.url !== undefined) result.url = opts.url;
      if (opts.deduplicated) result.deduplicated = true;
      data = ledger.complete(need(opts, '--key', 'key'), result);
    } else if (op === 'fail') data = ledger.fail(need(opts, '--key', 'key'), { code: need(opts, '--code', 'code'), message: opts.message });
    else data = ledger.prune({ runDays: opts.runDays === undefined ? cfg.retentionDays : opts.runDays, keyDays: opts.keyDays === undefined ? cfg.keyRetentionDays : opts.keyDays, dryRun: Boolean(opts.dryRun) });
    out({ ok: true, data });
    return 0;
  } catch (err) {
    if (err && err.isUsage) { stderr.write(`ledger: ${err.message}\n`); return 2; }
    out({ ok: false, error: { code: err.code || 'UNEXPECTED', message: err.message } });
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, FLAGS, OPS };
