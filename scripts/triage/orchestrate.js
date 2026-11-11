#!/usr/bin/env node
'use strict';

// The deterministic spine of the QA-run-orchestrator: run the suite → re-run ONLY the failing specs → gather locator
// evidence → classify → plan. One command, so the agent does not have to choreograph six steps from prose; what is
// left to the agent is judgement and the human-gated actions (/file-bug, comments).
//
//   node scripts/triage/orchestrate.js --framework <f> [--spec S]... [--test-dir D] [--config-file C] [--cwd D]
//        [--reruns 2] [--preflight ok|failed|unknown] [--snapshot page.html] [--out qa-results] [--run-id ID]
//        [--threshold 0.8] [--trusted-formats tap] [--timeout-ms N] [--no-plan] [--config qa-config.json] [--source T] [--base-url U]
//
// Steps (each tool is the one documented elsewhere; this only wires them):
//   1. scripts/results/run.js   the main run                       → <out>/main/
//   2. scripts/results/run.js   re-run each failing spec, N times   → <out>/rerun-<k>/   (skipped if preflight failed)
//   3. scripts/triage/locators.js  for locator failures, if --snapshot is given
//   4. scripts/triage/classify.js                                   → <out>/triage.json
//   5. scripts/triage/plan.js   (read-only tracker search)          → <out>/plan.json, <out>/flaky.json
// A green run ends after step 1. Output: { ok, data } with the verdict and step for every failure.
// Exit: 0 = completed (green, or triaged — failures are data) · 2 = bad invocation · 3 = no trustworthy main run
// (see scripts/results/run.js: could not start, hung, wrote nothing, zero tests, or exit code contradicting the report).

const fs = require('fs');
const path = require('path');
const { main: runResultsMain } = require('../results/run');
const { classify, makeKeyer, DEFAULT_THRESHOLD, DEFAULT_TRUSTED_FORMATS, parseTrustedFormats } = require('./classify');
const { analyzeLocator } = require('./locators');
const { isLocatorError, extractTestId, evidenceText } = require('./lib/text');
const { plan, connectIfNeeded, writeCommentInputs } = require('./plan');

const usage = (message) => Object.assign(new Error(message), { isUsage: true });
const MAX_RERUNS = 5;

function parseArgs(argv) {
  const opts = { specs: [], reruns: 2 };
  for (let n = 0; n < argv.length; n += 1) {
    const flag = argv[n];
    const value = () => { if (n + 1 >= argv.length) throw usage(`${flag} needs a value`); n += 1; return argv[n]; };
    if (flag === '--framework') opts.framework = value();
    else if (flag === '--spec') opts.specs.push(value());
    else if (flag === '--test-dir') opts.testDir = value();
    else if (flag === '--config-file') opts.configFile = value();
    else if (flag === '--cwd') opts.cwd = value();
    else if (flag === '--reruns') opts.reruns = Number(value());
    else if (flag === '--preflight') opts.preflight = value();
    else if (flag === '--snapshot') opts.snapshot = value();
    else if (flag === '--out') opts.out = value();
    else if (flag === '--run-id') opts.runId = value();
    else if (flag === '--threshold') opts.threshold = Number(value());
    else if (flag === '--trusted-formats') opts.trustedFormats = parseTrustedFormats(value());
    else if (flag === '--timeout-ms') opts.timeoutMs = Number(value());
    else if (flag === '--no-plan') opts.noPlan = true;
    else if (flag === '--config') opts.config = value();
    else if (flag === '--source') opts.source = value();
    else if (flag === '--base-url') opts.baseUrl = value();
    else throw usage(`unknown option ${flag}`);
  }
  if (!Number.isInteger(opts.reruns) || opts.reruns < 0 || opts.reruns > MAX_RERUNS) throw usage(`--reruns must be a whole number from 0 to ${MAX_RERUNS}`);
  if (opts.preflight && !['ok', 'failed', 'unknown'].includes(opts.preflight)) throw usage('--preflight must be ok, failed or unknown');
  if (opts.threshold !== undefined && !(opts.threshold > 0 && opts.threshold <= 1)) throw usage('--threshold must be between 0 and 1');
  if (opts.timeoutMs !== undefined && !(Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0)) throw usage('--timeout-ms must be a positive whole number of milliseconds');
  // the run id ends up in tracker idempotency keys and in file names
  if (opts.runId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(opts.runId)) throw usage('--run-id must be 1-64 characters: letters, digits, ".", "_" or "-", starting with a letter or digit');
  return opts;
}

// The default way to run the suite: the real results runner, in this process, output captured.
async function defaultRunResults(argv, env) {
  let out = '';
  const code = await runResultsMain({ argv, env, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
  let doc = null;
  try { doc = out ? JSON.parse(out) : null; } catch { /* usage errors print nothing */ }
  return { code, doc };
}

const writeJson = (file, obj) => { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`); };
const needsTriage = (t) => t.status === 'failed' || t.flaky;

async function orchestrate(opts, { env = process.env, fetch = globalThis.fetch, runResults = defaultRunResults, now = Date.now } = {}) {
  const out = opts.out || 'qa-results';
  const runId = opts.runId || new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const preflight = opts.preflight || 'unknown';
  const warnings = [];
  const base = [...(opts.framework ? ['--framework', opts.framework] : []), ...(opts.testDir ? ['--test-dir', opts.testDir] : []), ...(opts.configFile ? ['--config-file', opts.configFile] : []),
    ...(opts.cwd ? ['--cwd', opts.cwd] : []), ...(opts.config ? ['--config', opts.config] : []), ...(opts.timeoutMs ? ['--timeout-ms', String(opts.timeoutMs)] : []), '--quiet'];
  const specArgs = (specs) => specs.flatMap((s) => ['--spec', s]);

  // What an EARLIER run left in <out> would be read as this run's: re-runs (the prose says "one --rerun per rerun-<k> directory that exists"), locator
  // evidence and snapshots (a failure's token is stable across runs, so a stale snapshot would be applied to this run's failure with the same token),
  // and the previous triage/plan/flaky/comments (a green or --no-plan run would otherwise leave a failing run's files looking current). Clear exactly
  // those, by name. Nothing else in <out> is touched.
  if (fs.existsSync(out)) {
    for (const e of fs.readdirSync(out, { withFileTypes: true })) {
      const stale = (e.isDirectory() && (/^rerun-\d+$/.test(e.name) || e.name === 'snapshots' || e.name === 'comments')) || (e.isFile() && ['evidence.json', 'triage.json', 'plan.json', 'flaky.json'].includes(e.name));
      if (stale) fs.rmSync(path.join(out, e.name), { recursive: true, force: true });
    }
  }

  // 1. the main run
  const first = await runResults([...base, ...specArgs(opts.specs), '--out', path.join(out, 'main')], env);
  // code 3 is "no trustworthy main run" (see scripts/results/run.js) — including a runner whose exit code contradicts its own report, which still
  // comes back WITH a report. A report that may be partial is not a pass: stop here instead of declaring the run green.
  if (first.code === 3 && first.doc && first.doc.data) {
    return { code: 3, doc: { ok: false, stage: 'run', error: first.doc.error || { code: 'CONTRADICTORY_RUN', message: (first.doc.warnings && first.doc.warnings[0]) || 'the runner\'s exit code contradicts its report, so this run cannot be trusted' }, ...(first.doc.warnings ? { warnings: first.doc.warnings } : {}) } };
  }
  if (!first.doc || !first.doc.data) {
    return { code: first.code === 2 ? 2 : 3, doc: { ok: false, stage: 'run', error: (first.doc && first.doc.error) || { code: 'NO_REPORT', message: 'the run produced no result' }, ...(first.doc && first.doc.warnings ? { warnings: first.doc.warnings } : {}) } };
  }
  const main = first.doc.data;
  if (first.doc.warnings && first.doc.warnings.length) warnings.push(...first.doc.warnings.map((w) => `main run: ${w}`));
  const targets = main.tests.filter(needsTriage);
  if (!targets.length) {
    return { code: 0, doc: { ok: true, data: { status: 'green', runId, totals: main.totals, ...(warnings.length ? { warnings } : {}) } } };
  }

  // 2. re-run only the failing specs (a failed preflight makes every failure an environment failure: don't bother)
  const reruns = []; const rerunNotes = [];
  if (preflight === 'failed') rerunNotes.push('re-runs skipped: preflight reported the environment as not ready');
  else if (opts.reruns > 0) {
    const files = [...new Set(targets.map((t) => t.file).filter(Boolean))];
    const everyFileKnown = targets.every((t) => t.file);
    const scope = everyFileKnown ? files : opts.specs; // no file for some failure: re-run what the main run ran
    if (!everyFileKnown) rerunNotes.push('some failures carry no file location, so each re-run repeats the whole selection');
    for (let k = 1; k <= opts.reruns; k += 1) {
      const r = await runResults([...base, ...specArgs(scope), '--out', path.join(out, `rerun-${k}`)], env);
      // exit 3 WITH a report = the runner's exit code contradicts its own report (a crash after a partial report). The main run stops on that; a re-run
      // that is not trusted must not count either: its "pass" would turn a consistent failure into a flaky one.
      if (r.code === 3 && r.doc && r.doc.data) warnings.push(`re-run ${k} cannot be trusted (${(r.doc.warnings && r.doc.warnings[0]) || 'its exit code contradicts its report'}); it is not counted, classifying with ${reruns.length + 1} run(s)`);
      else if (r.doc && r.doc.data) reruns.push(r.doc.data);
      else warnings.push(`re-run ${k} produced no usable report (${(r.doc && r.doc.error && r.doc.error.message) || `exit ${r.code}`}); classifying with ${reruns.length + 1} run(s)`);
    }
  }

  // 3. locator evidence from a DOM snapshot, for failures that look like a missing element
  const evidence = {};
  if (opts.snapshot) {
    let html = null;
    try { html = fs.readFileSync(opts.snapshot, 'utf8'); } catch (e) { warnings.push(`snapshot not readable (${e.message}): locator failures stay undetermined`); }
    if (html !== null) {
      // read the whole failure text, not just its first line: Playwright keeps "waiting for getByTestId('x')" in the details
      const { keyOf } = makeKeyer([main, ...reruns]); // the same key classify() looks the evidence up by
      for (const t of main.tests.filter((x) => x.status === 'failed' && x.error && isLocatorError(evidenceText(x.error)))) {
        if (!extractTestId(evidenceText(t.error))) continue;
        evidence[keyOf(t)] = { locator: analyzeLocator({ html, selector: evidenceText(t.error), bare: false }) };
      }
    }
  }

  // 4. classify
  const report = classify({ runs: [main, ...reruns], preflight, evidence, threshold: opts.threshold || DEFAULT_THRESHOLD, trustedFormats: opts.trustedFormats || DEFAULT_TRUSTED_FORMATS, root: path.resolve(opts.cwd || process.cwd()) });
  writeJson(path.join(out, 'triage.json'), { ok: true, data: report });
  const files = { triage: path.join(out, 'triage.json') };

  // 5. plan (read-only)
  let actions = null;
  if (!opts.noPlan) {
    const { adapter, trackerWarning } = connectIfNeeded(report, { configPath: opts.config, source: opts.source, baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs, env, fetch });
    const commentsDir = path.join(out, 'comments');
    const p = await plan({ report, runId, adapter, trackerWarning, commentsDir });
    const commentFiles = writeCommentInputs(p.actions);
    writeJson(path.join(out, 'plan.json'), { ok: true, data: p });
    writeJson(path.join(out, 'flaky.json'), { runId, flaky: p.flaky });
    files.plan = path.join(out, 'plan.json'); files.flaky = path.join(out, 'flaky.json');
    if (commentFiles.length) files.comments = commentFiles;
    warnings.push(...p.warnings);
    actions = p.actions;
  }

  const stepOf = new Map((actions || []).map((a) => [a.key, a.step]));
  return {
    code: 0,
    doc: {
      ok: true,
      data: {
        status: 'triaged', runId, totals: main.totals, runs: 1 + reruns.length, preflight, ...(rerunNotes.length ? { rerunNotes } : {}),
        summary: report.summary,
        verdicts: report.verdicts.map((v) => ({ test: v.test.name, key: v.key, class: v.class, rule: v.rule, confidence: v.confidence, action: v.action, ...(v.cap ? { cap: v.cap } : {}), ...(stepOf.has(v.key) ? { step: stepOf.get(v.key) } : {}) })),
        files, ...(warnings.length ? { warnings } : {}),
      },
    },
  };
}

async function main({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr, ...deps } = {}) {
  const emit = (obj) => stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write('Usage: orchestrate.js --framework F [--spec S]... [--test-dir D] [--config-file C] [--cwd D] [--reruns 2] [--preflight ok|failed|unknown] [--snapshot page.html] [--out DIR] [--run-id ID] [--threshold 0.8] [--trusted-formats tap|none] [--timeout-ms N] [--no-plan] [--config P] [--source T] [--base-url U]\n');
      return argv.length ? 0 : 2;
    }
    const opts = parseArgs(argv);
    const { code, doc } = await orchestrate(opts, { env, ...deps });
    emit(doc);
    return code;
  } catch (err) {
    if (err && err.isUsage) { stderr.write(`orchestrate.js: ${err.message}\n`); return 2; }
    emit({ ok: false, error: { code: 'UNEXPECTED', message: `unexpected error: ${err && err.message}` } });
    return 3;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { main, orchestrate, MAX_RERUNS };
