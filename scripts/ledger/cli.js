#!/usr/bin/env node
'use strict';

// The run ledger from the command line: for the prose commands and for a person after a crash. The design is docs/phase-3-design.md.
//
//   node scripts/ledger/cli.js status                                      what is in the ledger: runs, keys, locks, what looks unfinished
//   node scripts/ledger/cli.js show   --run-id ID                          one run's events (and warnings about anything unreadable)
//   node scripts/ledger/cli.js claim  --key K [--run-id ID]                claim an idempotency key: exactly one caller wins
//   node scripts/ledger/cli.js complete --key K [--id I] [--url U] [--deduplicated]   record that the write for K happened
//   node scripts/ledger/cli.js fail   --key K --code C [--message M]       record that it did not (the key may then be claimed again)
//   node scripts/ledger/cli.js forget --key K [--force]                    drop a claim that is wrong (the item was deleted on the tracker): the next write goes there again.
//                                                                          A claim in flight whose owner may still be running is refused without --force
//   node scripts/ledger/cli.js flake-rate [--window N] [--all]            tests that flipped between passing and failing inside a run, over their last N runs (default 20)
//   node scripts/ledger/cli.js budget-check [--ticket T] [--env-url U]    may a run start now, and with which limits? Exit 0: yes; exit 4: no (a cooldown, or a lock is held).
//                                                                          data.limits are what the launcher should pass on (claude -p --max-turns, a cost cap)
//   node scripts/ledger/cli.js budget-record --run-id ID [--turns N] [--cost-usd X] [--wall-clock-ms N]   what the launcher measured, written to the run's record
//   node scripts/ledger/cli.js prune  [--run-days N] [--key-days N] [--dry-run]
// Options for every operation: --dir D (default: ledger.dir in qa-config.json, else .qa-ledger) and --config P.
//
// `claim` exits 0 whether it won or not: data.won says which, and when it lost, data.state is `done` (skip it; data.claim.result is what was
// recorded) or `in-flight` (claimed and not finished; data.ownerAlive says whether the claimant is still running on this machine, null when
// it is another one). A caller that gets `in-flight` must reconcile with the tracker before retrying (docs/phase-3-design.md).
// Output: { ok, data } on stdout. Exit: 0 = done · 1 = the ledger could not do it (code in error.code) · 2 = bad invocation · 4 = budget-check says a run may not start.

const { openLedger } = require('./lib/ledger');
const { ledgerConfig, LIMITS } = require('./lib/config');
const { staleHeals, flakeRates, lastRunEnd } = require('./lib/views');
const { budgetConfig, tighter, longer } = require('./lib/budget');
const { scopesFor, configEnvUrl, normalizeEnvUrl, ticketProblem } = require('./lib/locks');
const { usage, parseFlags, jsonPrinter } = require('../lib/cli');

const MAX_DAYS = 7300;
const OPS = ['status', 'show', 'claim', 'complete', 'fail', 'forget', 'flake-rate', 'budget-check', 'budget-record', 'prune'];
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
  '--window': { key: 'window', parse: (v, flag) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 1000) throw usage(`${flag} must be a whole number from 1 to 1000`); return n; } },
  '--all': { key: 'all', set: true },
  '--force': { key: 'force', set: true },
  '--ticket': { key: 'ticket' },
  '--env-url': { key: 'envUrl' },
  '--turns': { key: 'turns', parse: (v, flag) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw usage(`${flag} must be a whole number, 0 or more`); return n; } },
  '--cost-usd': { key: 'costUsd', parse: (v, flag) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw usage(`${flag} must be a number, 0 or more`); return n; } },
  '--wall-clock-ms': { key: 'wallClockMs', parse: (v, flag) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw usage(`${flag} must be a number of milliseconds, 0 or more`); return n; } },
};

const need = (opts, flag, key) => { if (opts[key] === undefined) throw usage(`${opts.op} needs ${flag}`); return opts[key]; };

function main({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr, now = Date.now } = {}) {
  const out = jsonPrinter(stdout);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write(`Usage: cli.js <${OPS.join('|')}> [--dir D] [--config P] [--run-id ID] [--key K] [--id I] [--url U] [--deduplicated] [--code C] [--message M] [--run-days N] [--key-days N] [--dry-run] [--window N] [--all] [--force] [--ticket T] [--env-url U] [--turns N] [--cost-usd N] [--wall-clock-ms N]\n`);
      return argv.length ? 0 : 2;
    }
    const op = argv[0];
    if (!OPS.includes(op)) throw usage(`unknown operation ${JSON.stringify(op.slice(0, 40))} (known: ${OPS.join(', ')})`);
    const opts = parseFlags(argv.slice(1), FLAGS, { init: { op } });
    const cfg = ledgerConfig({ configPath: opts.config, env, strict: true });
    const ledger = openLedger({ dir: opts.dir || cfg.dir, now });

    let data;
    if (op === 'status') data = { ...ledger.status(), staleHeals: staleHeals(ledger) };
    else if (op === 'budget-check') {
      // Everything that would stop a run from starting, looked at without taking anything. A run that is allowed to start is still subject to the same checks
      // when it does (it takes the locks itself); this is the question a launcher asks first, so that it does not pay for a model session that would be refused.
      const b = budgetConfig({ configPath: opts.config, env });
      const limits = { maxWallClockMs: b.maxWallClockMs, maxTurns: b.maxTurns, maxCostUsd: b.maxCostUsd };
      const reasons = [];
      if (opts.ticket !== undefined && ticketProblem(opts.ticket)) throw usage(`--ticket ${ticketProblem(opts.ticket)}`);
      if (opts.envUrl !== undefined && !normalizeEnvUrl(opts.envUrl)) throw usage('--env-url must be an http(s) URL');
      if (opts.ticket && b.cooldownMinutes > 0) {
        const last = lastRunEnd(ledger, { ticket: opts.ticket, now: now() });
        const agoMs = last ? now() - Date.parse(last.endedAt) : NaN;
        if (last && agoMs >= 0 && agoMs < b.cooldownMinutes * 60000) reasons.push({ code: 'COOLDOWN', message: `ticket ${opts.ticket} was last run by ${last.runId}, which ended ${Math.floor(agoMs / 60000)} minute(s) ago; the cooldown is ${b.cooldownMinutes} minute(s)`, runId: last.runId, endedAt: last.endedAt });
      }
      const scopes = scopesFor({ envUrl: opts.envUrl || configEnvUrl({ configPath: opts.config, env }), ticket: opts.ticket });
      const held = ledger.listLocks().filter((l) => scopes.includes(l.scope) && !l.stale);
      for (const l of held) reasons.push({ code: 'LOCKED', message: `${l.scope} is held by run ${l.runId || '(unknown)'} since ${l.startedAt || '(unknown)'}`, scope: l.scope, runId: l.runId || null, startedAt: l.startedAt || null });
      data = { ok: reasons.length === 0, reasons, limits, cooldownMinutes: b.cooldownMinutes, scopes };
    } else if (op === 'budget-record') {
      const spent = {};
      if (opts.turns !== undefined) spent.turns = opts.turns;
      if (opts.costUsd !== undefined) spent.costUsd = opts.costUsd;
      if (opts.wallClockMs !== undefined) spent.wallClockMs = opts.wallClockMs;
      if (!Object.keys(spent).length) throw usage('budget-record needs at least one of --turns, --cost-usd, --wall-clock-ms');
      const runId = need(opts, '--run-id', 'runId');
      if (!ledger.readRun(runId).events.length) throw Object.assign(new Error(`no run ${JSON.stringify(String(runId).slice(0, 60))} in the ledger to record spend on`), { code: 'RUN_NOT_FOUND' });
      data = ledger.record(runId, 'budget', spent);
    } else if (op === 'forget') data = ledger.forgetClaim(need(opts, '--key', 'key'), { force: Boolean(opts.force) });
    else if (op === 'flake-rate') data = flakeRates(ledger, { window: opts.window, includeStable: Boolean(opts.all) });
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
    return op === 'budget-check' && !data.ok ? 4 : 0;
  } catch (err) {
    if (err && err.isUsage) { stderr.write(`ledger: ${err.message}\n`); return 2; }
    out({ ok: false, error: { code: err.code || 'UNEXPECTED', message: err.message } });
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, FLAGS, OPS };
