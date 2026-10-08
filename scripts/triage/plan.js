#!/usr/bin/env node
'use strict';

// Turn a triage report into concrete next steps — and, for product bugs, check the tracker first so the same
// defect is not filed twice. READ-ONLY: it searches and fetches, it never writes to the tracker. Filing and
// commenting stay with the existing, human-gated commands (/file-bug, tracker cli.js comment); the plan hands them
// ready-made inputs.
//
//   node scripts/triage/plan.js --report triage.json [--run-id <id>] [--flaky-out flaky.json] [--out plan.json]
//                               [--source T] [--config P] [--base-url U] [--timeout-ms N]
//
// Per verdict (class + action → step):
//   product-bug, act     → comment-existing   an OPEN report with this fingerprint exists: comment, don't file
//                          file-regression    only CLOSED reports match: the defect came back — file a NEW bug linking the old
//                          file-bug           nothing matches
//   product-bug, propose → propose            (with what was found, so the human can decide)
//   test-bug             → propose-test-fix   self-heal is not enabled: name the cause, edit nothing
//   flaky                → report-flaky       never filed
//   environment          → report-environment never filed
//   undetermined         → propose
// A hit only counts if the fingerprint token is really in the item's body (search is fuzzy; a lagging index misses
// brand-new items — a known limit, see docs/phase-2-design.md). Idempotency keys always include the run id so that a
// retry of THIS run is safe but a later run is never swallowed by an old, closed report.
// Output: { ok, data: { runId, actions[], flaky[], warnings[] } }. Exit 0 = planned, 1 = unreadable input, 2 = usage.

const fs = require('fs');
const path = require('path');
const { run } = require('../tracker/adapters');
const { connect } = require('../tracker/lib/connect');
const { TrackerError } = require('../tracker/lib/errors');

const usage = (message) => Object.assign(new Error(message), { isUsage: true });
const MAX_CANDIDATES = 5;
const sanitize = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function parseArgs(argv) {
  const opts = {};
  for (let n = 0; n < argv.length; n += 1) {
    const flag = argv[n];
    const value = () => { if (n + 1 >= argv.length) throw usage(`${flag} needs a value`); n += 1; return argv[n]; };
    if (flag === '--report') opts.report = value();
    else if (flag === '--run-id') opts.runId = value();
    else if (flag === '--flaky-out') opts.flakyOut = value();
    else if (flag === '--out') opts.out = value();
    else if (flag === '--source') opts.source = value();
    else if (flag === '--config') opts.config = value();
    else if (flag === '--base-url') opts.baseUrl = value();
    else if (flag === '--timeout-ms') opts.timeoutMs = Number(value());
    else throw usage(`unknown option ${flag}`);
  }
  if (!opts.report) throw usage('--report <triage report json> is required');
  if (opts.runId !== undefined && !sanitize(opts.runId)) throw usage('--run-id must contain letters or digits');
  return opts;
}

// Reports with this fingerprint, split into open / closed. Never throws on a tracker problem: the plan degrades to
// "could not check" and says so.
async function lookup(adapter, token) {
  const { items } = await run(adapter, 'search', { query: token, kind: 'bug', limit: MAX_CANDIDATES });
  const open = []; const closed = [];
  for (const item of items.slice(0, MAX_CANDIDATES)) {
    const ticket = await run(adapter, 'fetch', { id: item.id }); // confirm the token is really in it — search is fuzzy
    if (!String(ticket.description || '').includes(token)) continue;
    (item.open ? open : closed).push({ id: item.id, url: item.url, title: item.title, status: item.status });
  }
  return { open, closed };
}

function commentBody(v, runId) {
  return [
    `Run ${runId}: this failure occurred again.`, '',
    `Test: ${v.test.name}${v.test.file ? ` (${path.basename(v.test.file)})` : ''}`,
    `Error: ${(v.error && v.error.message) || '(none recorded)'}`,
    `Triage: ${v.class} by rule ${v.rule}, confidence ${v.confidence} — ${v.attempts.length} attempt(s), ${v.attempts.filter((a) => a.status === 'failed').length} failed`,
    '', `qa-harness-fingerprint: ${v.token}`,
  ].join('\n');
}

async function plan({ report, runId, adapter, trackerWarning }) {
  const warnings = trackerWarning ? [trackerWarning] : [];
  const actions = [];
  const seen = new Map(); // fingerprint -> first test key, for same-run dedupe
  for (const v of report.verdicts) {
    const base = { key: v.key, test: v.test.name, class: v.class, rule: v.rule, confidence: v.confidence, fingerprint: v.fingerprint, token: v.token };
    if (v.class === 'flaky') { actions.push({ ...base, step: v.action === 'act' ? 'report-flaky' : 'propose', reason: 'a flaky test is reported, never filed' }); continue; }
    if (v.class === 'environment') { actions.push({ ...base, step: v.action === 'act' ? 'report-environment' : 'propose', reason: 'environment problems are reported with a re-run advice, never filed' }); continue; }
    if (v.class === 'test-bug') { actions.push({ ...base, step: v.action === 'act' ? 'propose-test-fix' : 'propose', reason: 'self-heal is not enabled: the cause is named, nothing is edited', evidence: v.evidence }); continue; }
    if (v.class === 'undetermined') { actions.push({ ...base, step: 'propose', reason: 'no rule has enough evidence', evidence: v.evidence }); continue; }

    // product-bug
    if (seen.has(v.fingerprint)) { actions.push({ ...base, step: 'duplicate-in-run', duplicateOf: seen.get(v.fingerprint), reason: 'same fingerprint as another failure in this run: one report covers both' }); continue; }
    seen.set(v.fingerprint, v.key);

    let found = null; let lookupNote;
    if (!adapter) lookupNote = 'skipped: no tracker to search';
    else {
      try { found = await lookup(adapter, v.token); } catch (err) {
        if (!(err instanceof TrackerError)) throw err;
        lookupNote = `failed: ${err.code}`;
        warnings.push(`tracker search failed for ${v.key} (${err.code}: ${err.message}) — an existing report could not be ruled out`);
      }
    }
    const key = `fp-${v.fingerprint}-${sanitize(runId)}`;
    const lookupInfo = found ? { open: found.open, closed: found.closed } : { skipped: lookupNote };
    if (v.action === 'propose') { actions.push({ ...base, step: 'propose', reason: 'low confidence: shown to the human, not acted on', evidence: v.evidence, lookup: lookupInfo }); continue; }
    if (found && found.open.length) {
      const existing = found.open[0];
      actions.push({ ...base, step: 'comment-existing', existing, lookup: lookupInfo,
        commentInput: { id: existing.id, body: commentBody(v, runId), idempotencyKey: `${key}-comment` } });
    } else if (found && found.closed.length) {
      actions.push({ ...base, step: 'file-regression', regressionOf: found.closed[0], lookup: lookupInfo, idempotencyKey: key, marker: `qa-harness-fingerprint: ${v.token}`,
        note: `report #${found.closed[0].id} with this fingerprint is closed, so this is a regression: file a new bug that links it` });
    } else {
      actions.push({ ...base, step: 'file-bug', lookup: lookupInfo, idempotencyKey: key, marker: `qa-harness-fingerprint: ${v.token}`,
        ...(lookupNote ? { note: `existing reports were not checked (${lookupNote})` } : {}) });
    }
  }
  const flaky = report.verdicts.filter((v) => v.class === 'flaky').map((v) => ({ key: v.key, test: v.test.name, rule: v.rule, confidence: v.confidence, attempts: v.attempts }));
  return { runId, actions, flaky, warnings };
}

// Only product-bug verdicts need the tracker, so credentials are not demanded otherwise. A tracker that cannot be
// reached or configured degrades the plan with a warning (existing reports could not be checked); it never stops it.
function connectIfNeeded(report, { configPath, source, baseUrl, timeoutMs, env, fetch }) {
  if (!report.verdicts.some((v) => v.class === 'product-bug')) return { adapter: null };
  try {
    return { adapter: connect({ configPath, source, baseUrl, timeoutMs, env, fetch }) };
  } catch (err) {
    if (!(err instanceof TrackerError)) throw err;
    return { adapter: null, trackerWarning: `no tracker lookup: ${err.message} — existing reports could not be checked, so filing may duplicate` };
  }
}

async function main({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr, fetch = globalThis.fetch, now = Date.now } = {}) {
  const out = (obj) => stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write('Usage: plan.js --report <triage.json> [--run-id ID] [--flaky-out FILE] [--out FILE] [--source T] [--config P] [--base-url U] [--timeout-ms N]\n');
      return argv.length ? 0 : 2;
    }
    const opts = parseArgs(argv);
    let doc;
    try { doc = JSON.parse(fs.readFileSync(opts.report, 'utf8')); } catch (e) { throw Object.assign(new Error(`cannot read ${opts.report}: ${e.message}`), { code: 'UNREADABLE' }); }
    const report = doc && doc.data ? doc.data : doc;
    if (!report || !Array.isArray(report.verdicts)) throw Object.assign(new Error(`${opts.report} is not a triage report (no "verdicts" array)`), { code: 'UNREADABLE' });
    const runId = opts.runId || new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

    const { adapter, trackerWarning } = connectIfNeeded(report, { configPath: opts.config, source: opts.source, baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs, env, fetch });
    const data = await plan({ report, runId, adapter, trackerWarning });
    for (const f of [opts.out && [opts.out, { ok: true, data }], opts.flakyOut && [opts.flakyOut, { runId, flaky: data.flaky }]].filter(Boolean)) {
      fs.mkdirSync(path.dirname(path.resolve(f[0])), { recursive: true });
      fs.writeFileSync(f[0], `${JSON.stringify(f[1], null, 2)}\n`);
    }
    out({ ok: true, data });
    return 0;
  } catch (err) {
    if (err && err.isUsage) { stderr.write(`plan.js: ${err.message}\n`); return 2; }
    out({ ok: false, error: { code: err.code || 'UNEXPECTED', message: err.message } });
    return 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { main, plan, connectIfNeeded, sanitize };
