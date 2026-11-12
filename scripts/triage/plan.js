#!/usr/bin/env node
'use strict';

// Turn a triage report into concrete next steps — and, for product bugs, check the tracker first so the same
// defect is not filed twice. READ-ONLY: it searches and fetches, it never writes to the tracker. Filing and
// commenting stay with the existing, human-gated commands (/file-bug, tracker cli.js comment); the plan hands them
// ready-made inputs.
//
//   node scripts/triage/plan.js --report triage.json [--run-id <id>] [--flaky-out flaky.json] [--out plan.json]
//                               [--comments-dir DIR] [--source T] [--config P] [--base-url U] [--timeout-ms N]
//
// Per verdict (class + action → step):
//   product-bug, act     → comment-existing   an OPEN report with this fingerprint exists: comment, don't file
//                          file-regression    only CLOSED (fixed) reports match: the defect came back — file a NEW bug linking the old
//                          report-dismissed   only reports closed WITHOUT a fix match (won't fix, not planned, duplicate…), or one was created after the last
//                                             fixed one (the team already decided about the recurrence): say so, file nothing
//                          file-bug           nothing matches
//   product-bug, propose → propose            (with what was found, so the human can decide)
//   test-bug             → propose-test-fix   self-heal is not enabled: name the cause, edit nothing
//   flaky                → report-flaky       never filed
//   environment          → report-environment never filed
//   undetermined         → propose
// A hit only counts if the fingerprint token is really in the item's body (search is fuzzy; a lagging index misses
// brand-new items — a known limit, see docs/phase-2-design.md). Idempotency keys always include the run id so that a
// retry of THIS run is safe but a later run is never swallowed by an old, closed report.
// A comment-existing step comes with its input already written to <comments-dir>/<fingerprint token>.json, so nobody has to assemble
// JSON from text that came out of a failing test. Output: { ok, data: { runId, actions[], flaky[], warnings[] } }. Exit 0 = planned, 1 = unreadable input, 2 = usage.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { run } = require('../tracker/adapters');
const { connect } = require('../tracker/lib/connect');
const { TrackerError } = require('../tracker/lib/errors');
const { redactSecrets } = require('./lib/text');

// Every step a plan can contain. The prose that tells a model what to do for each one is checked against this list
// (tests/helpers/orchestrator-drift-check.js), so a step cannot be added here without telling the model about it.
const STEPS = ['file-bug', 'file-regression', 'report-dismissed', 'comment-existing', 'duplicate-in-run', 'propose-test-fix', 'report-flaky', 'report-environment', 'propose'];

const usage = (message) => Object.assign(new Error(message), { isUsage: true });
const MAX_CANDIDATES = 5;
const CAP_REASON = 'held at propose: classification of this runner format has not been verified on real failures (a person widens the trusted formats, with triage.trustedFormats or --trusted-formats), so a person decides';
const sanitize = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
// The run's part of an idempotency key. A short id made of safe characters is used as it is (readable, and what an operator would type). Anything else
// (long, or with characters that would fold together: "a/b" and "a-b") keeps a readable prefix and adds a hash of the WHOLE id, so two different run
// ids never share a key, which would silently deduplicate the second run's bug into the first. At most 24 + 1 + 8 characters, so the key stays under 80.
// An id that already ENDS like a hashed one ("-" and 12 hex digits) is hashed too, so a run literally named like another run's hashed form cannot share its key:
// every key part ending that way was produced by hashing the whole id.
const runPart = (runId) => {
  const id = String(runId);
  return /^[A-Za-z0-9._-]{1,40}$/.test(id) && !/-[0-9a-f]{12}$/.test(id) ? id : `${sanitize(id).slice(0, 24)}-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
};
// Any 1-128 printable characters: an odd id (refs/heads/main, build#42) is hashed into the key above, so there is nothing to protect by refusing it.
const isValidRunId = (id) => typeof id === 'string' && /^[^\u0000-\u001f\u007f]{1,128}$/u.test(id);
const TOKEN = /^qafp[0-9a-f]{12}$/;

function parseArgs(argv) {
  const opts = {};
  for (let n = 0; n < argv.length; n += 1) {
    const flag = argv[n];
    const value = () => { if (n + 1 >= argv.length) throw usage(`${flag} needs a value`); n += 1; return argv[n]; };
    if (flag === '--report') opts.report = value();
    else if (flag === '--run-id') opts.runId = value();
    else if (flag === '--flaky-out') opts.flakyOut = value();
    else if (flag === '--out') opts.out = value();
    else if (flag === '--comments-dir') opts.commentsDir = value();
    else if (flag === '--source') opts.source = value();
    else if (flag === '--config') opts.config = value();
    else if (flag === '--base-url') opts.baseUrl = value();
    else if (flag === '--timeout-ms') opts.timeoutMs = Number(value());
    else throw usage(`unknown option ${flag}`);
  }
  if (!opts.report) throw usage('--report <triage report json> is required');
  if (opts.runId !== undefined && !isValidRunId(opts.runId)) throw usage('--run-id must be 1-128 characters with no control characters');
  return opts;
}

// Reports with this fingerprint, split into open / closed. Never throws on a tracker problem: the plan degrades to
// "could not check" and says so.
async function lookup(adapter, token) {
  const { items } = await run(adapter, 'search', { query: token, kind: 'bug', limit: MAX_CANDIDATES });
  // A search that returns as many as it was allowed to may have more behind them; a candidate that cannot be read is skipped (not allowed to hide the
  // ones that could be), and both are reported so "nothing found" is never taken for "nothing exists".
  const truncated = items.length >= MAX_CANDIDATES;
  const unread = [];
  // open: still being worked · closed: closed because it was FIXED · dismissed: closed WITHOUT a fix (won't fix, not planned, duplicate…)
  const open = []; const closed = []; const dismissed = [];
  for (const item of items.slice(0, MAX_CANDIDATES)) {
    let ticket;
    try { ticket = await run(adapter, 'fetch', { id: item.id }); } catch (err) { // confirm the token is really in it — search is fuzzy
      if (!(err instanceof TrackerError)) throw err;
      unread.push({ id: item.id, code: err.code });
      continue;
    }
    if (!String(ticket.description || '').includes(token)) continue;
    (item.open ? open : item.dismissed ? dismissed : closed).push({ id: item.id, url: item.url, title: item.title, status: item.status, ...(item.createdAt ? { createdAt: item.createdAt } : {}) });
  }
  return { open, closed, dismissed, unread, truncated };
}

// When a defect matches BOTH a report closed as fixed and one closed WITHOUT a fix, the later one is the team's last word. Fixed, then back,
// then the regression report dismissed: filing another regression would repeat that forever. Dismissed, then (later) fixed, then back: it IS
// a regression of that fix. Reports are ordered by when they were created; if either side has no date, the order is unknown.
const newest = (list) => { const times = list.map((i) => Date.parse(i.createdAt)).filter(Number.isFinite); return times.length ? Math.max(...times) : NaN; };
const dismissedAfterFix = (found) => newest(found.dismissed) > newest(found.closed); // NaN (no date) compares false: an unknown order is never "later"

function commentBody(v, runId) {
  return [
    `Run ${runId}: this failure occurred again.`, '',
    `Test: ${redactSecrets(v.test.name)}${v.test.file ? ` (${path.basename(v.test.file)})` : ''}`,
    `Error: ${redactSecrets((v.error && v.error.message) || '') || '(none recorded)'}`, // masked again here: the report may have been edited or come from elsewhere
    `Triage: ${v.class} by rule ${v.rule}, confidence ${v.confidence} — ${v.attempts.length} attempt(s), ${v.attempts.filter((a) => a.status === 'failed').length} failed`,
    '', `qa-harness-fingerprint: ${v.token}`,
  ].join('\n');
}

async function plan({ report, runId, adapter, trackerWarning, commentsDir }) {
  // the token names a FILE (comments/<token>.json): a report with anything else in it is not one of ours, and nothing is written for it
  const badToken = report.verdicts.find((v) => !TOKEN.test(String(v.token)));
  if (badToken) throw usage(`a verdict has a token that is not a fingerprint token (qafp + 12 hex digits): ${JSON.stringify(String(badToken.token).slice(0, 40))}`);
  const warnings = trackerWarning ? [trackerWarning] : [];
  const actions = [];
  const seen = new Map(); // fingerprint -> first test key, for same-run dedupe
  for (const v of report.verdicts) {
    const base = { key: v.key, test: v.test.name, class: v.class, rule: v.rule, confidence: v.confidence, fingerprint: v.fingerprint, token: v.token };
    if (v.class === 'flaky') { actions.push({ ...base, step: v.action === 'act' ? 'report-flaky' : 'propose', reason: 'a flaky test is reported, never filed' }); continue; }
    if (v.class === 'environment') { actions.push({ ...base, step: v.action === 'act' ? 'report-environment' : 'propose', reason: 'environment problems are reported with a re-run advice, never filed' }); continue; }
    if (v.class === 'test-bug') { actions.push({ ...base, step: v.action === 'act' ? 'propose-test-fix' : 'propose', reason: v.cap ? CAP_REASON : 'the cause is named and, unless self-heal is enabled and succeeds, nothing is edited', evidence: v.evidence, ...(v.proposal ? { proposal: v.proposal } : {}) }); continue; }
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
    const key = `fp-${v.fingerprint}-${runPart(runId)}`;
    const lookupInfo = found ? { open: found.open, closed: found.closed, dismissed: found.dismissed, ...(found.unread.length ? { partial: found.unread } : {}), ...(found.truncated ? { truncated: true } : {}) } : { skipped: lookupNote };
    if (found && found.unread.length) warnings.push(`${v.key}: ${found.unread.length} report(s) with a matching search result could not be read (${found.unread.map((u) => `#${u.id}: ${u.code}`).join(', ')}), so the lookup is partial — an existing report may exist`);
    // the same caveat goes on whatever step the lookup led to: a regression or a dismissal decided from a partial lookup must say so too
    const caveats = [];
    if (found && found.unread.length) caveats.push(`report(s) ${found.unread.map((u) => `#${u.id}`).join(', ')} could not be read, so an existing (possibly open) report may exist: check before filing`);
    if (found && found.truncated) caveats.push(`only the first ${MAX_CANDIDATES} search results were checked, so an older matching report may exist`);
    const caveat = caveats.join('; ');
    if (found && found.truncated) warnings.push(`${v.key}: the search returned ${MAX_CANDIDATES} results, the most it is asked for: only the first ${MAX_CANDIDATES} were checked, so an older matching report may exist`);
    if (v.action === 'propose') { actions.push({ ...base, step: 'propose', reason: v.cap ? CAP_REASON : 'low confidence: shown to the human, not acted on', evidence: v.evidence, lookup: lookupInfo }); continue; }
    if (found && found.open.length) {
      const existing = found.open[0];
      actions.push({ ...base, step: 'comment-existing', existing, lookup: lookupInfo,
        commentInput: { id: existing.id, body: commentBody(v, runId), idempotencyKey: `${key}-comment` },
        ...(commentsDir ? { commentInputFile: path.join(commentsDir, `${v.token}.json`) } : {}) });
    } else if (found && found.closed.length && !(found.dismissed.length && dismissedAfterFix(found))) {
      actions.push({ ...base, step: 'file-regression', regressionOf: found.closed[0], lookup: lookupInfo, idempotencyKey: key, marker: `qa-harness-fingerprint: ${v.token}`,
        note: `report #${found.closed[0].id} with this fingerprint was closed as fixed, so this is a regression: file a new bug that links it${found.dismissed.length ? ` (a report closed without a fix also matches, but it is not newer than the fixed one — or the tracker gave no dates to tell: if it is the later decision, do not file)` : ''}${caveat ? ` — CAVEAT: ${caveat}` : ''}` });
    } else if (found && found.dismissed.length) {
      // The team decided NOT to fix this. It is not a regression of a fix, and a comment on a dismissed report is noise: say so, file nothing.
      actions.push({ ...base, step: 'report-dismissed', dismissedAs: found.dismissed[0], lookup: lookupInfo,
        reason: `report #${found.dismissed[0].id} with this fingerprint was closed WITHOUT a fix (${found.dismissed[0].status}): nothing is filed or commented. If that decision should be revisited, re-open it yourself`,
        ...(caveat ? { note: caveat } : {}) });
    } else {
      actions.push({ ...base, step: 'file-bug', lookup: lookupInfo, idempotencyKey: key, marker: `qa-harness-fingerprint: ${v.token}`,
        ...(lookupNote || caveat ? { note: lookupNote ? `existing reports were not checked (${lookupNote})` : caveat } : {}) });
    }
  }
  const flaky = report.verdicts.filter((v) => v.class === 'flaky').map((v) => ({ key: v.key, test: v.test.name, rule: v.rule, confidence: v.confidence, attempts: v.attempts }));
  return { runId, actions, flaky, warnings };
}

// The input for each comment-existing step, written where the step says (named by the fingerprint token — one alphanumeric word — never by
// the test's key, which is free text from a test title and can hold a slash, a quote or a space).
function writeCommentInputs(actions) {
  const written = [];
  for (const a of actions) {
    if (a.step !== 'comment-existing' || !a.commentInputFile) continue;
    fs.mkdirSync(path.dirname(path.resolve(a.commentInputFile)), { recursive: true });
    fs.writeFileSync(a.commentInputFile, `${JSON.stringify(a.commentInput, null, 2)}\n`);
    written.push(a.commentInputFile);
  }
  return written;
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
      stderr.write('Usage: plan.js --report <triage.json> [--run-id ID] [--flaky-out FILE] [--out FILE] [--comments-dir DIR] [--source T] [--config P] [--base-url U] [--timeout-ms N]\n');
      return argv.length ? 0 : 2;
    }
    const opts = parseArgs(argv);
    let doc;
    try { doc = JSON.parse(fs.readFileSync(opts.report, 'utf8')); } catch (e) { throw Object.assign(new Error(`cannot read ${opts.report}: ${e.message}`), { code: 'UNREADABLE' }); }
    const report = doc && doc.data ? doc.data : doc;
    if (!report || !Array.isArray(report.verdicts)) throw Object.assign(new Error(`${opts.report} is not a triage report (no "verdicts" array)`), { code: 'UNREADABLE' });
    const runId = opts.runId || new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

    const { adapter, trackerWarning } = connectIfNeeded(report, { configPath: opts.config, source: opts.source, baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs, env, fetch });
    const commentsDir = opts.commentsDir || (opts.out ? path.join(path.dirname(opts.out), 'comments') : undefined);
    const data = await plan({ report, runId, adapter, trackerWarning, commentsDir });
    writeCommentInputs(data.actions);
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

module.exports = { main, plan, connectIfNeeded, writeCommentInputs, sanitize, isValidRunId, STEPS };
