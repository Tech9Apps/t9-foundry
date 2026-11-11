#!/usr/bin/env node
'use strict';

// Failure triage: given a run (and optional re-runs of its failing specs), say for each failing or flaky test
// whether it is a product-bug, a test-bug, flaky, or an environment problem — with the evidence, a confidence,
// and whether it is confident enough to ACT on or should only be PROPOSED.
//
//   node scripts/triage/classify.js --run qa-results/result.json [--rerun qa-results/rerun-1/result.json]...
//                                   [--preflight ok|failed] [--evidence evidence.json] [--threshold 0.8] [--trusted-formats tap] [--root <project dir>] [--out report.json]
//
// The rules are ordered; the first that matches wins and the rest are kept as `alternatives`. They implement
// .claude/memory/failure-triage-rules.md — the rule ids below are checked against it by a drift test.
// Output: { "ok": true, "data": <triage report> } (schemas/triage-report.schema.json). Exit 0 = report produced
// (failures are data), 1 = an input could not be read, 2 = bad invocation.

const fs = require('fs');
const path = require('path');
const { fingerprint, identity, pathTail } = require('./fingerprint');
const { signatureOf, evidenceText, infraSignal, infraStrong, authSignal, errorPageSignal, isLocatorError, extractTestId, testCrash, baseName } = require('./lib/text');

const DEFAULT_THRESHOLD = 0.8;
// The raw formats scripts/results/normalize.js produces. Only formats whose classification has been checked against REAL failure
// output may let a verdict ACT; for the others, product-bug and test-bug verdicts (the two that can file a bug or edit a test) are
// capped at "propose". Today that is TAP only: the Playwright/Jest/JUnit paths were built against hand-written reporter output.
// Widen it with --trusted-formats once a format has been verified on real failures. That is a decision for the person running the tools: there is
// deliberately no qa-config.json setting for it, and the agent's prose tells it to pass the flag only when the user says a format has been verified.
const FORMATS = ['junit', 'tap', 'playwright-json', 'jest-json'];
const DEFAULT_TRUSTED_FORMATS = ['tap'];
const CAPPED_CLASSES = ['product-bug', 'test-bug'];
// The single source of truth for every rule: its class and the confidences it may produce. Key order == precedence.
// .claude/memory/failure-triage-rules.md documents the same table; tests/helpers/triage-rubric-check.js fails if they differ,
// and add() below refuses to emit a confidence that is not listed here.
const RULE_TABLE = {
  'ENV-1': { class: 'environment', confidence: [0.95] },
  'ENV-2': { class: 'environment', confidence: [0.9, 0.7] },
  'FLK-1': { class: 'flaky', confidence: [0.9, 0.85] },
  'TST-1': { class: 'test-bug', confidence: [0.85] },
  'TST-2': { class: 'test-bug', confidence: [0.8, 0.65] },
  'ENV-3': { class: 'environment', confidence: [0.6] },
  'PRD-1': { class: 'product-bug', confidence: [0.85] },
  'PRD-2': { class: 'product-bug', confidence: [0.75] },
  'PRD-3': { class: 'product-bug', confidence: [0.6] },
  'UND-1': { class: 'undetermined', confidence: [0.5, 0.4, 0.3] },
};
const RULES = Object.keys(RULE_TABLE);
const CLASSES = ['product-bug', 'test-bug', 'flaky', 'environment', 'undetermined'];

const usage = (message) => Object.assign(new Error(message), { isUsage: true });
const short = (s, n = 140) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
const msgOf = (a) => (a.error && a.error.message) || '';
// what the failure SAYS: message + the reporter's diagnostics (see lib/text.js evidenceText) — every signal reads this, not just the first line
const textOf = (a) => evidenceText(a.error);

// The same test across runs. identity() (ticket/caseId, else file + title) survives renames, but it is not UNIQUE: one case runs once per
// browser project, and two files may reuse a case id. Tests that share an identity are told apart by their full title and file, or one
// failure would hide behind a passing sibling (and be dropped) or be averaged with it (and be called flaky).
// And node's TAP gives only a FAILING test a file, so the same test passing on a re-run has none: a missing file is taken from the same title
// elsewhere in the runs — but only when that title maps to ONE file, never by guessing between two.
const titleKey = (t) => `${t.suite || ''}\u0000${t.name}`;
const discriminator = (t) => `${t.suite ? `${t.suite} > ` : ''}${t.name}${t.file ? ` @ ${pathTail(t.file)}` : ''}`;
function makeKeyer(runs) {
  const files = new Map(); // title -> the one file it is seen with, or null when it is seen with several
  for (const run of runs) for (const t of run.tests) if (t.file) { const k = titleKey(t); files.set(k, files.has(k) && files.get(k) !== t.file ? null : t.file); }
  const withFile = (t) => (t.file || !files.get(titleKey(t)) ? t : { ...t, file: files.get(titleKey(t)) });
  // Two tests are different only if they appear TOGETHER in one run. The same identity under a different title in two runs is one test that was
  // reworded (that is what the ticket/case identity is for), not two.
  const shared = new Set();
  for (const run of runs) {
    const together = new Map(); // identity -> the distinct tests carrying it in THIS run
    for (const raw of run.tests) {
      if (raw.status === 'skipped') continue;
      const t = withFile(raw); const id = identity(t);
      if (!together.has(id)) together.set(id, new Set());
      together.get(id).add(discriminator(t));
    }
    for (const [id, set] of together) if (set.size > 1) shared.add(id);
  }
  const keyOf = (raw) => { const t = withFile(raw); const id = identity(t); return shared.has(id) ? `${id} [${discriminator(t)}]` : id; };
  return { keyOf, withFile };
}

function gatherAttempts(runs, keyer) {
  const map = new Map();
  runs.forEach((run, i) => {
    for (const raw of run.tests) {
      if (raw.status === 'skipped') continue;
      const key = keyer.keyOf(raw);
      const t = keyer.withFile(raw);
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
  for (const t of failed) { const s = signatureOf(t.error); counts.set(s, (counts.get(s) || 0) + 1); }
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return n >= 0.8 * failed.length ? new Set([top]) : new Set();
}

function evaluate({ key, attempts }, { runCount, preflight, blast, evidence, root }) {
  const failing = attempts.filter((a) => a.status === 'failed');
  const passing = attempts.filter((a) => a.status === 'passed');
  const main = attempts[0].test;
  const sigs = failing.map((a) => signatureOf(a.error));
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
  const infra = failing.map((a) => infraSignal(textOf(a)));
  if (failing.length && infra.every(Boolean)) {
    // a preflight that just said "ready" followed by a failure in EVERY attempt that only says an HTTP status or "failed to fetch": the check is evidence
    // too, and a CORS rule, a removed route or a regression looks the same. A network-level error (refused, not resolved, TLS) stays an outage.
    const healthy = preflight === 'ok' && !passing.length && failing.every((a) => !infraStrong(textOf(a)));
    add('ENV-2', 'environment', healthy ? 0.7 : 0.9, `every failing attempt (${failing.length}) carries an infrastructure error: "${short(msgOf(failing[0]))}"`,
      ...(healthy ? ['preflight reported the environment as ready and the error is only an HTTP status or a failed fetch, so it is proposed, not acted on, as an environment problem'] : []));
  }
  if ((failing.length && passing.length) || attempts.some((a) => a.flaky)) {
    if (failing.length && passing.length) add('FLK-1', 'flaky', 0.9, `failed in run ${runsOf(failing)} but passed in run ${runsOf(passing)} with no change`);
    else add('FLK-1', 'flaky', 0.85, `the runner retried it and it passed (retries: ${Math.max(...attempts.map((a) => a.retries))})`);
  }
  const locatorFails = failing.length > 0 && failing.every((a) => isLocatorError(textOf(a)));
  // DOM evidence is about ONE locator. If the id in this failure's error is not the evidence's target (evidence left by an earlier run, or about another
  // failure), it says nothing about this one.
  const rawLoc = evidence && evidence.locator;
  const staleLoc = locatorFails && rawLoc && !failing.every((a) => extractTestId(textOf(a)) === rawLoc.target);
  const loc = staleLoc ? undefined : rawLoc;
  if (locatorFails && loc && loc.present === false && Array.isArray(loc.candidates) && loc.candidates.length === 1) {
    const c = loc.candidates[0];
    add('TST-1', 'test-bug', 0.85, `the test looks for "${loc.target}", which is not on the page, but "${c.testid}" is (similarity ${c.similarity})`, `locator error in every failing attempt: "${short(msgOf(failing[0]))}"`);
  }
  const crashes = failing.map((a) => testCrash(a.error, { root }));
  if (failing.length > 0 && crashes.every(Boolean)) {
    const f = crashes[0];
    add('TST-2', 'test-bug', crashes.every((c) => c.strong) ? 0.8 : 0.65, `the test crashed in its own code (${baseName(f.file)}${f.line ? `:${f.line}` : ''}): "${short(msgOf(failing[0]))}"`);
  }
  if (failing.length && blast.size && failing.every((a) => blast.has(signatureOf(a.error)))) {
    add('ENV-3', 'environment', 0.6, 'most of the run failed with this one error — an outage or a single suite-wide regression; cannot tell which from the tests alone');
  }
  // An "assertion" failure is evidence about the APP. A missing element is evidence about the test or the page, and most
  // runners (node:test, Playwright, Jest) report it with the same plain kind as an assertion — so look at the wording.
  // The same goes for a login page, a 401/403 or a 404/500 page where the test expected something else: the assertion "failed", but
  // the cause is as likely the test account or the environment as the product, so it is not an assertion about the app.
  const authy = failing.length > 0 && failing.every((a) => authSignal(textOf(a)));
  const errorPage = failing.length > 0 && failing.every((a) => errorPageSignal(textOf(a)));
  const assertions = failing.length > 0 && failing.every((a) => a.error && a.error.kind === 'failure' && !isLocatorError(textOf(a)) && !authSignal(textOf(a)) && !errorPageSignal(textOf(a)));
  const sameSignature = sigs.length > 0 && sigs.every((s) => s === sigs[0]);
  if (failing.length >= 2 && !passing.length && assertions && sameSignature) {
    if (main.caseId) add('PRD-1', 'product-bug', 0.85, `failed in all ${failing.length} attempts with the same assertion ("${short(msgOf(failing[0]))}")`, `traceable to manual case ${main.ticket ? `${main.ticket}/` : ''}${main.caseId}`);
    else add('PRD-2', 'product-bug', 0.75, `failed in all ${failing.length} attempts with the same assertion ("${short(msgOf(failing[0]))}")`, 'not traceable to a documented manual case');
  }
  if (failing.length === 1 && attempts.length === 1 && assertions) {
    add('PRD-3', 'product-bug', 0.6, `an assertion failed on the only attempt${runCount === 1 ? ' (no re-run was done)' : ' (it was not re-run)'}; a flaky test cannot be ruled out`);
  }

  if (!matches.length) {
    // nothing above applied: say why, so a human knows what evidence would settle it
    let why; let conf = 0.3;
    if (staleLoc) { why = `DOM evidence was supplied for a different locator ("${rawLoc.target}") than the one in this failure, so it is ignored — capture the page and run scripts/triage/locators.js for this failure`; conf = 0.4; }
    else if (locatorFails && !loc) { why = 'a locator was not found, but no DOM evidence was supplied — capture the page and run scripts/triage/locators.js'; conf = 0.4; }
    else if (locatorFails && loc && loc.present === true) { why = `the locator "${loc.target}" IS on the page, so this is not a stale selector — look at visibility/timing`; conf = 0.4; }
    else if (locatorFails && loc && loc.candidates && loc.candidates.length > 1) { why = `the locator is not on the page and ${loc.candidates.length} elements resemble it — ambiguous`; conf = 0.5; }
    else if (locatorFails && loc) { why = 'the locator is not on the page and nothing resembles it — the app may have removed it, or the test is wrong'; conf = 0.5; }
    else if (authy) { why = 'it looks like an authentication or session problem (a 401/403, or a redirect to a login page): an expired test account and a real permission regression look the same from the test alone — check the test credentials first'; conf = 0.4; }
    else if (errorPage) { why = 'the page or API answered with an error page (404/500): a wrong base URL, a dead route and a real regression look the same from the test alone'; conf = 0.4; }
    else if (failing.length > 1 && !sameSignature) why = 'it failed every time, but with different errors';
    else if (failing.every((a) => a.error && a.error.kind === 'timeout')) why = 'it timed out every time with no infrastructure signature (slow app, wrong wait, or dead server)';
    else if (failing.every((a) => a.error && a.error.kind === 'error')) why = 'it crashed every time, but not in test code, so the cause cannot be attributed';
    else why = 'no rule has enough evidence';
    add('UND-1', 'undetermined', conf, why);
  }
  return { matches, failing, passing, key, main };
}

// the details kept in a report: enough for a later step (locators.js, the Bug-reporter) to see the diagnosis, not a whole stack trace
const evidenceDetails = (error) => evidenceText({ message: '', details: error.details }).trim().slice(0, 1000);

function classify({ runs, preflight = 'unknown', evidence = {}, threshold = DEFAULT_THRESHOLD, trustedFormats = DEFAULT_TRUSTED_FORMATS, root = process.cwd() }) {
  if (!runs.length) throw usage('at least one run is required');
  const format = runs[0].format || 'unknown'; // a result that does not say what it was parsed from cannot be trusted
  const trusted = trustedFormats.includes(format);
  const attemptsByKey = gatherAttempts(runs, makeKeyer(runs));
  const blast = blastSignatures(runs[0]);
  const verdicts = [];
  for (const entry of attemptsByKey.values()) {
    const first = entry.attempts.find((a) => a.run === 0);
    if (!first || !(first.status === 'failed' || first.flaky)) continue; // triage what failed or flaked in the MAIN run
    const ctx = { runCount: runs.length, preflight, blast, root, evidence: evidence[entry.key] || evidence[first.test.name] };
    const { matches, failing, main } = evaluate(entry, ctx);
    const [win, ...rest] = matches;
    let action = win.confidence >= threshold ? 'act' : 'propose';
    const evidenceLines = [...win.evidence];
    const capped = action === 'act' && !trusted && CAPPED_CLASSES.includes(win.class);
    if (capped) {
      action = 'propose';
      evidenceLines.push(`capped at propose: classification of ${format} output has not been verified against real failures, so a ${win.class} verdict is shown to a human, not acted on (a person widens the list with --trusted-formats once a format has been checked on real failures)`);
    }
    const fp = fingerprint(failing.length ? { ...main, error: failing[0].error } : main);
    verdicts.push({
      key: entry.key,
      test: { name: main.name, ...(main.ticket ? { ticket: main.ticket } : {}), ...(main.caseId ? { caseId: main.caseId } : {}), ...(main.file ? { file: main.file } : {}), ...(main.line ? { line: main.line } : {}) },
      class: win.class, rule: win.rule, confidence: win.confidence, action,
      ...(capped ? { cap: 'unverified-format' } : {}),
      evidence: evidenceLines,
      ...(rest.length ? { alternatives: rest.map((m) => ({ class: m.class, rule: m.rule, confidence: m.confidence })) } : {}),
      attempts: entry.attempts.map((a) => ({ run: a.run, status: a.status })),
      ...(failing.length ? { error: { kind: failing[0].error && failing[0].error.kind, message: msgOf(failing[0]), ...(failing[0].error && failing[0].error.details ? { details: evidenceDetails(failing[0].error) } : {}) } } : {}),
      fingerprint: fp.fingerprint, token: fp.token, signature: fp.signature,
    });
  }
  const byClass = Object.fromEntries(CLASSES.map((c) => [c, verdicts.filter((v) => v.class === c).length]));
  return {
    runs: runs.length, preflight, threshold, format, trustedFormats, trusted,
    summary: { tests: runs[0].tests.filter((t) => t.status !== 'skipped').length, triaged: verdicts.length, byClass, act: verdicts.filter((v) => v.action === 'act').length, propose: verdicts.filter((v) => v.action === 'propose').length },
    verdicts,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// "tap,junit" -> ['tap','junit']; "none" or "" -> [] (nothing may act). Anything else is a usage error, so a typo cannot widen trust.
function parseTrustedFormats(text) {
  const list = String(text).split(',').map((x) => x.trim()).filter(Boolean).filter((x) => x !== 'none');
  const unknown = list.filter((x) => !FORMATS.includes(x));
  if (unknown.length) throw usage(`--trusted-formats: unknown format "${unknown[0]}" (use ${FORMATS.join(', ')}, or none)`);
  return list;
}

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
    else if (flag === '--trusted-formats') opts.trustedFormats = parseTrustedFormats(value());
    else if (flag === '--root') opts.root = value();
    else if (flag === '--out') opts.out = value();
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
      stderr.write('Usage: classify.js --run <result.json> [--rerun <result.json>]... [--preflight ok|failed] [--evidence <json>] [--threshold 0.8] [--trusted-formats tap,junit|none] [--root <project dir>] [--out <file>]\n');
      return argv.length ? 0 : 2;
    }
    const opts = parseArgs(argv);
    const runs = [readResult(opts.run), ...opts.reruns.map(readResult)];
    let evidence = {};
    if (opts.evidence) {
      try { evidence = JSON.parse(fs.readFileSync(opts.evidence, 'utf8')); } catch (e) { throw Object.assign(new Error(`cannot read ${opts.evidence}: ${e.message}`), { code: 'UNREADABLE' }); }
    }
    const data = classify({ runs, preflight: opts.preflight || 'unknown', evidence, threshold: opts.threshold || DEFAULT_THRESHOLD, trustedFormats: opts.trustedFormats || DEFAULT_TRUSTED_FORMATS, ...(opts.root ? { root: path.resolve(opts.root) } : {}) });
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

module.exports = { main, classify, makeKeyer, RULES, RULE_TABLE, CLASSES, DEFAULT_THRESHOLD, DEFAULT_TRUSTED_FORMATS, FORMATS, CAPPED_CLASSES, parseTrustedFormats };
