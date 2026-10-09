#!/usr/bin/env node
'use strict';

// Failure triage: given a run (and optional re-runs of its failing specs), say for each failing or flaky test
// whether it is a product-bug, a test-bug, flaky, or an environment problem — with the evidence, a confidence,
// and whether it is confident enough to ACT on or should only be PROPOSED.
//
//   node scripts/triage/classify.js --run qa-results/result.json [--rerun qa-results/rerun-1/result.json]...
//                                   [--preflight ok|failed] [--evidence evidence.json] [--threshold T] [--out report.json]
//                                   [--config qa-config.json]    (--threshold defaults to triage.confidenceThreshold there, else 0.8)
//
// The rules are ordered; the first that matches wins and the rest are kept as `alternatives`. They implement
// .claude/memory/failure-triage-rules.md — the rule ids below are checked against it by a drift test.
// Output: { "ok": true, "data": <triage report> } (schemas/triage-report.schema.json). Exit 0 = report produced
// (failures are data), 1 = an input could not be read, 2 = bad invocation.

const fs = require('fs');
const path = require('path');
const { fingerprint, identity } = require('./fingerprint');
const { normalizeSignature, infraSignal, isLocatorError, testCrash, appCrash, baseName } = require('./lib/text');
const { triageConfig } = require('./lib/config');

const DEFAULT_THRESHOLD = 0.8;
// The single source of truth for every rule: its class and the confidences it may produce. Key order == precedence.
// .claude/memory/failure-triage-rules.md documents the same table; tests/helpers/triage-rubric-check.js fails if they differ,
// and add() below refuses to emit a confidence that is not listed here.
const RULE_TABLE = {
  'ENV-1': { class: 'environment', confidence: [0.95] },
  'ENV-2': { class: 'environment', confidence: [0.9] },
  'FLK-1': { class: 'flaky', confidence: [0.9, 0.85] },
  'TST-1': { class: 'test-bug', confidence: [0.85] },
  'TST-2': { class: 'test-bug', confidence: [0.8] },
  'TST-3': { class: 'test-bug', confidence: [0.55] },
  'ENV-3': { class: 'environment', confidence: [0.6] },
  'PRD-1': { class: 'product-bug', confidence: [0.85] },
  'PRD-2': { class: 'product-bug', confidence: [0.75] },
  'PRD-3': { class: 'product-bug', confidence: [0.6] },
  'PRD-4': { class: 'product-bug', confidence: [0.55] },
  'UND-1': { class: 'undetermined', confidence: [0.5, 0.4, 0.3] },
};
// `undetermined` is a LAST RESORT, strictly: it is only emitted when no rule above produced any positive evidence, always
// for one of these named reasons, and it never acts, whatever the threshold. A failure that is merely "different" gets the
// class its evidence leans towards (TST-3, PRD-4 are the weak, always-proposed rules for that), not this.
const UND_REASONS = {
  LOCATOR_NO_EVIDENCE: { confidence: 0.4, means: 'a locator was not found and no DOM snapshot was supplied: capture the page, run scripts/triage/locators.js on it, and re-classify before reporting this' },
  LOCATOR_PRESENT: { confidence: 0.5, means: 'the locator IS on the page, so this is not a stale selector (visibility, timing, or a real defect)' },
  LOCATOR_GONE: { confidence: 0.5, means: 'the locator is not on the page and nothing resembles it: the app removed it, or the test is wrong' },
  CONSISTENT_TIMEOUT: { confidence: 0.5, means: 'it timed out every time with no infrastructure signature (slow app, wrong wait, or dead server)' },
  NOT_RERUN: { confidence: 0.4, means: 'it failed once and was not re-run, and nothing else decides it' },
  UNSTABLE_ERRORS: { confidence: 0.3, means: 'it failed every time, but with a different error each time' },
  UNATTRIBUTED_CRASH: { confidence: 0.3, means: 'it crashed, but there is no stack location to say whether the test or the app is at fault' },
  UNCLASSIFIED: { confidence: 0.3, means: 'no rule applies (the catch-all: if this is frequent, the rules do not cover this suite)' },
};
const RULES = Object.keys(RULE_TABLE);
const CLASSES = ['product-bug', 'test-bug', 'flaky', 'environment', 'undetermined'];

const usage = (message) => Object.assign(new Error(message), { isUsage: true });
const short = (s, n = 140) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
const msgOf = (a) => (a.error && a.error.message) || '';

// The same test across runs: ticket/caseId when the name has them, else file + title.
const keyOf = (t) => identity(t);

function gatherAttempts(runs) {
  const map = new Map();
  runs.forEach((run, i) => {
    for (const t of run.tests) {
      if (t.status === 'skipped') continue;
      const key = keyOf(t);
      if (!map.has(key)) map.set(key, { key, attempts: [] });
      map.get(key).attempts.push({ run: i, status: t.status, flaky: !!t.flaky, retries: t.retries || 0, error: t.error, test: t });
    }
  });
  return map;
}

// Many tests failing with the SAME error: an outage, or one real regression that everything trips on. Only the
// signatures that account for most of a mostly-failed run qualify.
function blastSignatures(run) {
  const real = run.tests.filter((t) => t.status !== 'skipped');
  const failed = real.filter((t) => t.status === 'failed');
  if (failed.length < 3 || failed.length / real.length < 0.5) return new Set();
  const counts = new Map();
  for (const t of failed) { const s = normalizeSignature(t.error && t.error.message); counts.set(s, (counts.get(s) || 0) + 1); }
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return n >= 0.8 * failed.length ? new Set([top]) : new Set();
}

function evaluate({ key, attempts }, { runCount, preflight, blast, evidence }) {
  const failing = attempts.filter((a) => a.status === 'failed');
  const passing = attempts.filter((a) => a.status === 'passed');
  const main = attempts[0].test;
  const sigs = failing.map((a) => normalizeSignature(msgOf(a)));
  const matches = [];
  const add = (rule, klass, confidence, ...why) => {
    const spec = RULE_TABLE[rule];
    if (!spec || spec.class !== klass || !spec.confidence.includes(confidence)) throw new Error(`internal: ${rule} may not produce ${klass} at ${confidence} (see RULE_TABLE)`);
    matches.push({ rule, class: klass, confidence, evidence: why });
  };
  const runsOf = (list) => list.map((a) => a.run).join(', ');

  if (preflight === 'failed' && failing.length) {
    add('ENV-1', 'environment', 0.95, 'preflight reported the environment as not ready, so this failure cannot be attributed to the app or the test');
  }
  const infra = failing.map((a) => infraSignal(msgOf(a)));
  if (failing.length && infra.every(Boolean)) {
    add('ENV-2', 'environment', 0.9, `every failing attempt (${failing.length}) carries an infrastructure error: "${short(msgOf(failing[0]))}"`);
  }
  if ((failing.length && passing.length) || attempts.some((a) => a.flaky)) {
    if (failing.length && passing.length) add('FLK-1', 'flaky', 0.9, `failed in run ${runsOf(failing)} but passed in run ${runsOf(passing)} with no change`);
    else add('FLK-1', 'flaky', 0.85, `the runner retried it and it passed (retries: ${Math.max(...attempts.map((a) => a.retries))})`);
  }
  const locatorFails = failing.length > 0 && failing.every((a) => isLocatorError(msgOf(a)));
  const loc = evidence && evidence.locator;
  if (locatorFails && loc && loc.present === false && Array.isArray(loc.candidates) && loc.candidates.length === 1) {
    const c = loc.candidates[0];
    add('TST-1', 'test-bug', 0.85, `the test looks for "${loc.target}", which is not on the page, but "${c.testid}" is (similarity ${c.similarity})`, `locator error in every failing attempt: "${short(msgOf(failing[0]))}"`);
    // the concrete fix, so even with self-heal off the report says exactly what would change
    matches[matches.length - 1].proposal = { kind: 'rename-testid', from: loc.target, to: c.testid, similarity: c.similarity };
  }
  const crash = failing.length > 0 && failing.every((a) => testCrash(a.error));
  if (crash) {
    const f = testCrash(failing[0].error);
    add('TST-2', 'test-bug', 0.8, `the test crashed in its own code (${baseName(f.file)}${f.line ? `:${f.line}` : ''}): "${short(msgOf(failing[0]))}"`);
  }
  if (locatorFails && loc && loc.present === false && Array.isArray(loc.candidates) && loc.candidates.length >= 2) {
    const names = loc.candidates.slice(0, 3).map((c) => `"${c.testid}"`).join(', ');
    add('TST-3', 'test-bug', 0.55, `the test looks for "${loc.target}", which is not on the page, and ${loc.candidates.length} elements resemble it (${names}${loc.candidates.length > 3 ? ', …' : ''}) — probably renamed, but which one?`);
  }
  if (failing.length && blast.size && failing.every((a) => blast.has(normalizeSignature(msgOf(a))))) {
    add('ENV-3', 'environment', 0.6, 'most of the run failed with this one error — an outage or a single suite-wide regression; cannot tell which from the tests alone');
  }
  // An "assertion" failure is evidence about the APP. A missing element is evidence about the test or the page, and most
  // runners (node:test, Playwright, Jest) report it with the same plain kind as an assertion — so look at the wording.
  const assertions = failing.length > 0 && failing.every((a) => a.error && a.error.kind === 'failure' && !isLocatorError(msgOf(a)));
  const sameSignature = sigs.length > 0 && sigs.every((s) => s === sigs[0]);
  if (failing.length >= 2 && !passing.length && assertions && sameSignature) {
    if (main.caseId) add('PRD-1', 'product-bug', 0.85, `failed in all ${failing.length} attempts with the same assertion ("${short(msgOf(failing[0]))}")`, `traceable to manual case ${main.ticket ? `${main.ticket}/` : ''}${main.caseId}`);
    else add('PRD-2', 'product-bug', 0.75, `failed in all ${failing.length} attempts with the same assertion ("${short(msgOf(failing[0]))}")`, 'not traceable to a documented manual case');
  }
  if (failing.length === 1 && attempts.length === 1 && assertions) {
    add('PRD-3', 'product-bug', 0.6, `an assertion failed on the only attempt${runCount === 1 ? ' (no re-run was done)' : ' (it was not re-run)'}; a flaky test cannot be ruled out`);
  }

  const crashes = failing.length > 0 && failing.every((a) => appCrash(a.error));
  if (crashes && !passing.length && (failing.length === 1 || sameSignature)) {
    const f = appCrash(failing[0].error);
    add('PRD-4', 'product-bug', 0.55, `the application threw (${baseName(f.file)}${f.line ? `:${f.line}` : ''}): "${short(msgOf(failing[0]))}" — an exception in application code, not an assertion; ${failing.length > 1 ? `the same in all ${failing.length} attempts` : 'seen once, so a flake cannot be ruled out'}`);
  }

  let reason = null;
  if (!matches.length) {
    // STRICT: reached only when nothing above found positive evidence. Name the one reason, from the closed list.
    if (locatorFails && !loc) reason = 'LOCATOR_NO_EVIDENCE';
    else if (locatorFails && loc && loc.present === true) reason = 'LOCATOR_PRESENT';
    else if (locatorFails) reason = 'LOCATOR_GONE';
    else if (attempts.length === 1) reason = 'NOT_RERUN';
    else if (failing.every((a) => a.error && a.error.kind === 'timeout')) reason = 'CONSISTENT_TIMEOUT';
    else if (failing.length > 1 && !sameSignature) reason = 'UNSTABLE_ERRORS';
    else if (failing.every((a) => a.error && a.error.kind === 'error')) reason = 'UNATTRIBUTED_CRASH';
    else reason = 'UNCLASSIFIED';
    const detail = reason === 'LOCATOR_PRESENT' ? ` ("${loc.target}")` : '';
    const spec = UND_REASONS[reason];
    if (!RULE_TABLE['UND-1'].confidence.includes(spec.confidence)) throw new Error(`internal: UND_REASONS.${reason} uses a confidence that RULE_TABLE does not list`);
    matches.push({ rule: 'UND-1', class: 'undetermined', confidence: spec.confidence, evidence: [`${reason}: ${spec.means}${detail}`], reason });
  }
  return { matches, failing, passing, key, main, reason };
}

const countBy = (list, key) => list.reduce((o, x) => ({ ...o, [x[key]]: (o[x[key]] || 0) + 1 }), {});

function classify({ runs, preflight = 'unknown', evidence = {}, threshold = DEFAULT_THRESHOLD }) {
  if (!runs.length) throw usage('at least one run is required');
  const attemptsByKey = gatherAttempts(runs);
  const blast = blastSignatures(runs[0]);
  const verdicts = [];
  for (const entry of attemptsByKey.values()) {
    const first = entry.attempts.find((a) => a.run === 0);
    if (!first || !(first.status === 'failed' || first.flaky)) continue; // triage what failed or flaked in the MAIN run
    const ctx = { runCount: runs.length, preflight, blast, evidence: evidence[entry.key] || evidence[first.test.name] };
    const { matches, failing, main } = evaluate(entry, ctx);
    const [win, ...rest] = matches;
    const fp = fingerprint(failing.length ? { ...main, error: failing[0].error } : main);
    verdicts.push({
      key: entry.key,
      test: { name: main.name, ...(main.ticket ? { ticket: main.ticket } : {}), ...(main.caseId ? { caseId: main.caseId } : {}), ...(main.file ? { file: main.file } : {}), ...(main.line ? { line: main.line } : {}) },
      class: win.class, rule: win.rule, confidence: win.confidence,
      // an undetermined verdict NEVER acts, even if the threshold is set below its confidence: "unsure" is not a basis for action
      action: win.class !== 'undetermined' && win.confidence >= threshold ? 'act' : 'propose',
      ...(win.reason ? { reason: win.reason } : {}),
      ...(win.proposal ? { proposal: win.proposal } : {}),
      evidence: win.evidence,
      ...(rest.length ? { alternatives: rest.map((m) => ({ class: m.class, rule: m.rule, confidence: m.confidence })) } : {}),
      attempts: entry.attempts.map((a) => ({ run: a.run, status: a.status })),
      ...(failing.length ? { error: { kind: failing[0].error && failing[0].error.kind, message: msgOf(failing[0]) } } : {}),
      fingerprint: fp.fingerprint, token: fp.token, signature: fp.signature,
    });
  }
  const byClass = Object.fromEntries(CLASSES.map((c) => [c, verdicts.filter((v) => v.class === c).length]));
  return {
    runs: runs.length, preflight, threshold,
    summary: { tests: runs[0].tests.filter((t) => t.status !== 'skipped').length, triaged: verdicts.length, byClass, undeterminedReasons: countBy(verdicts.filter((v) => v.reason), 'reason'), act: verdicts.filter((v) => v.action === 'act').length, propose: verdicts.filter((v) => v.action === 'propose').length },
    verdicts,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { reruns: [] };
  for (let n = 0; n < argv.length; n += 1) {
    const flag = argv[n];
    const value = () => { if (n + 1 >= argv.length) throw usage(`${flag} needs a value`); n += 1; return argv[n]; };
    if (flag === '--run') opts.run = value();
    else if (flag === '--rerun') opts.reruns.push(value());
    else if (flag === '--preflight') opts.preflight = value();
    else if (flag === '--evidence') opts.evidence = value();
    else if (flag === '--threshold') opts.threshold = Number(value());
    else if (flag === '--out') opts.out = value();
    else if (flag === '--config') opts.config = value();
    else throw usage(`unknown option ${flag}`);
  }
  if (!opts.run) throw usage('--run <result.json> is required');
  if (opts.preflight && !['ok', 'failed', 'unknown'].includes(opts.preflight)) throw usage('--preflight must be ok, failed or unknown');
  if (opts.threshold !== undefined && !(opts.threshold > 0 && opts.threshold <= 1)) throw usage('--threshold must be between 0 and 1');
  return opts;
}

function readResult(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw Object.assign(new Error(`cannot read ${file}: ${e.message}`), { code: 'UNREADABLE' }); }
  const data = doc && doc.data ? doc.data : doc; // run.js / normalize.js wrap it in { ok, data }
  if (!data || !Array.isArray(data.tests)) throw Object.assign(new Error(`${file} is not a normalized run result (no "tests" array)`), { code: 'UNREADABLE' });
  return data;
}

function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  const out = (obj) => stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write('Usage: classify.js --run <result.json> [--rerun <result.json>]... [--preflight ok|failed] [--evidence <json>] [--threshold T] [--config <qa-config.json>] [--out <file>]\n');
      return argv.length ? 0 : 2;
    }
    const opts = parseArgs(argv);
    const runs = [readResult(opts.run), ...opts.reruns.map(readResult)];
    let evidence = {};
    if (opts.evidence) {
      try { evidence = JSON.parse(fs.readFileSync(opts.evidence, 'utf8')); } catch (e) { throw Object.assign(new Error(`cannot read ${opts.evidence}: ${e.message}`), { code: 'UNREADABLE' }); }
    }
    const threshold = opts.threshold !== undefined ? opts.threshold : triageConfig({ configPath: opts.config }).confidenceThreshold;
    const data = classify({ runs, preflight: opts.preflight || 'unknown', evidence, threshold });
    const doc = { ok: true, data };
    if (opts.out) { fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true }); fs.writeFileSync(opts.out, `${JSON.stringify(doc, null, 2)}\n`); }
    out(doc);
    return 0;
  } catch (err) {
    if (err && err.isUsage) { stderr.write(`classify.js: ${err.message}\n`); return 2; }
    out({ ok: false, error: { code: err.code || 'UNEXPECTED', message: err.message } });
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, classify, RULES, RULE_TABLE, CLASSES, UND_REASONS, DEFAULT_THRESHOLD };
