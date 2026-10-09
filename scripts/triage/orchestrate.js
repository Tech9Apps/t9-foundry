#!/usr/bin/env node
'use strict';

// The deterministic spine of the QA-run-orchestrator: run the suite → re-run ONLY the failing specs → gather locator
// evidence → classify → plan. One command, so the agent does not have to choreograph six steps from prose; what is
// left to the agent is judgement and the human-gated actions (/file-bug, comments).
//
//   node scripts/triage/orchestrate.js --framework <f> [--spec S]... [--test-dir D] [--config-file C] [--cwd D]
//        [--reruns N] [--preflight ok|failed|unknown] [--snapshot page.html] [--out qa-results] [--run-id ID]
//        [--threshold T] [--timeout-ms N] [--no-plan] [--heal | --no-heal] [--config qa-config.json] [--source T] [--base-url U]
//
// Steps (each tool is the one documented elsewhere; this only wires them):
//   1. scripts/results/run.js   the main run                       → <out>/main/
//   2. scripts/results/run.js   re-run each failing spec, N times   → <out>/rerun-<k>/   (skipped if preflight failed)
//   3. scripts/triage/locators.js  for locator failures, if --snapshot is given
//   4. scripts/triage/classify.js                                   → <out>/triage.json
//   5. scripts/triage/plan.js   (read-only tracker search)          → <out>/plan.json, <out>/flaky.json
//   6. scripts/triage/heal.js   ONLY if self-heal is enabled (triage.selfHeal.enabled / --heal): rename a stale test-id on a local
//      qa/ branch, validated by re-run, fully reverted on any failure; it never pushes   → <out>/heal.json
// --reruns (default 2, 0–5) and --threshold (default 0.8) can also be set once in qa-config.json under "triage"
// (reruns, confidenceThreshold); a flag overrides the config. The output says which source each setting came from.
// A green run ends after step 1. Output: { ok, data } with the verdict and step for every failure.
// Exit: 0 = completed (green, or triaged — failures are data) · 2 = bad invocation · 3 = no trustworthy main run
// (see scripts/results/run.js: could not start, hung, wrote nothing, zero tests, or exit code contradicting the report).

const fs = require('fs');
const path = require('path');
const { defaultRunResults } = require('./lib/run-results');
const { classify } = require('./classify');
const { analyzeLocator } = require('./locators');
const { identity } = require('./fingerprint');
const { isLocatorError, extractTestId } = require('./lib/text');
const { plan, connectIfNeeded } = require('./plan');
const { triageConfig, MAX_RERUNS } = require('./lib/config');
const { heal, eligible } = require('./heal');

const usage = (message) => Object.assign(new Error(message), { isUsage: true });
const UND_ALARM_MIN = 3; // at least this many undetermined verdicts, and at least this share of the triaged failures,
const UND_ALARM_SHARE = 0.5; // before the report says the rules lack what they need for this suite

function parseArgs(argv) {
  const opts = { specs: [] };
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
    else if (flag === '--timeout-ms') opts.timeoutMs = Number(value());
    else if (flag === '--no-plan') opts.noPlan = true;
    else if (flag === '--heal') opts.heal = true;
    else if (flag === '--no-heal') opts.heal = false;
    else if (flag === '--config') opts.config = value();
    else if (flag === '--source') opts.source = value();
    else if (flag === '--base-url') opts.baseUrl = value();
    else throw usage(`unknown option ${flag}`);
  }
  if (opts.reruns !== undefined && (!Number.isInteger(opts.reruns) || opts.reruns < 0 || opts.reruns > MAX_RERUNS)) throw usage(`--reruns must be a whole number from 0 to ${MAX_RERUNS}`);
  if (opts.preflight && !['ok', 'failed', 'unknown'].includes(opts.preflight)) throw usage('--preflight must be ok, failed or unknown');
  if (opts.threshold !== undefined && !(opts.threshold > 0 && opts.threshold <= 1)) throw usage('--threshold must be between 0 and 1');
  return opts;
}

const writeJson = (file, obj) => { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`); };
const needsTriage = (t) => t.status === 'failed' || t.flaky;

async function orchestrate(opts, { env = process.env, fetch = globalThis.fetch, runResults = defaultRunResults, now = Date.now } = {}) {
  const out = opts.out || 'qa-results';
  // flag > qa-config.json "triage" block > default
  const cfg = triageConfig({ configPath: opts.config, env });
  const reruns = opts.reruns !== undefined ? opts.reruns : cfg.reruns;
  const threshold = opts.threshold !== undefined ? opts.threshold : cfg.confidenceThreshold;
  const healEnabled = opts.heal !== undefined ? opts.heal : cfg.selfHeal.enabled;
  const settings = {
    reruns: { value: reruns, from: opts.reruns !== undefined ? 'flag' : cfg.explicit.reruns ? 'config' : 'default' },
    confidenceThreshold: { value: threshold, from: opts.threshold !== undefined ? 'flag' : cfg.explicit.confidenceThreshold ? 'config' : 'default' },
    selfHeal: { value: healEnabled, from: opts.heal !== undefined ? 'flag' : cfg.explicitSelfHeal ? 'config' : 'default' },
  };
  const runId = opts.runId || new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const preflight = opts.preflight || 'unknown';
  const warnings = [];
  const base = [...(opts.framework ? ['--framework', opts.framework] : []), ...(opts.testDir ? ['--test-dir', opts.testDir] : []), ...(opts.configFile ? ['--config-file', opts.configFile] : []),
    ...(opts.cwd ? ['--cwd', opts.cwd] : []), ...(opts.config ? ['--config', opts.config] : []), ...(opts.timeoutMs ? ['--timeout-ms', String(opts.timeoutMs)] : []), '--quiet'];
  const specArgs = (specs) => specs.flatMap((s) => ['--spec', s]);

  // 1. the main run
  const first = await runResults([...base, ...specArgs(opts.specs), '--out', path.join(out, 'main')], env);
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
  const rerunResults = []; const rerunNotes = [];
  if (preflight === 'failed') rerunNotes.push('re-runs skipped: preflight reported the environment as not ready');
  else if (reruns > 0) {
    const files = [...new Set(targets.map((t) => t.file).filter(Boolean))];
    const everyFileKnown = targets.every((t) => t.file);
    const scope = everyFileKnown ? files : opts.specs; // no file for some failure: re-run what the main run ran
    if (!everyFileKnown) rerunNotes.push('some failures carry no file location, so each re-run repeats the whole selection');
    for (let k = 1; k <= reruns; k += 1) {
      const r = await runResults([...base, ...specArgs(scope), '--out', path.join(out, `rerun-${k}`)], env);
      if (r.doc && r.doc.data) rerunResults.push(r.doc.data);
      else warnings.push(`re-run ${k} produced no usable report (${(r.doc && r.doc.error && r.doc.error.message) || `exit ${r.code}`}); classifying with ${rerunResults.length + 1} run(s)`);
    }
  }

  // 3. locator evidence from a DOM snapshot, for failures that look like a missing element
  const evidence = {};
  if (opts.snapshot) {
    let html = null;
    try { html = fs.readFileSync(opts.snapshot, 'utf8'); } catch (e) { warnings.push(`snapshot not readable (${e.message}): locator failures stay undetermined`); }
    if (html !== null) {
      for (const t of main.tests.filter((x) => x.status === 'failed' && x.error && isLocatorError(x.error.message))) {
        if (!extractTestId(t.error.message)) continue;
        evidence[identity(t)] = { locator: analyzeLocator({ html, selector: t.error.message }) };
      }
    }
  }

  // 4. classify
  const report = classify({ runs: [main, ...rerunResults], preflight, evidence, threshold });
  // Strictness needs a witness: if most failures end up undetermined the problem is the evidence (or the rules), not the failures.
  const und = report.summary.byClass.undetermined;
  if (und >= UND_ALARM_MIN && und / report.summary.triaged >= UND_ALARM_SHARE) {
    const why = Object.entries(report.summary.undeterminedReasons).map(([r, n]) => `${r} ×${n}`).join(', ');
    warnings.push(`${und} of ${report.summary.triaged} failures are undetermined (${why}): the evidence the rules need is missing for this suite — supply DOM snapshots, allow re-runs, or extend the rules. Do not treat these as findings.`);
  }
  writeJson(path.join(out, 'triage.json'), { ok: true, data: report });
  const files = { triage: path.join(out, 'triage.json') };

  // 5. plan (read-only)
  let actions = null;
  if (!opts.noPlan) {
    const { adapter, trackerWarning } = connectIfNeeded(report, { configPath: opts.config, source: opts.source, baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs, env, fetch });
    const p = await plan({ report, runId, adapter, trackerWarning });
    writeJson(path.join(out, 'plan.json'), { ok: true, data: p });
    writeJson(path.join(out, 'flaky.json'), { runId, flaky: p.flaky });
    files.plan = path.join(out, 'plan.json'); files.flaky = path.join(out, 'flaky.json');
    warnings.push(...p.warnings);
    actions = p.actions;
  }

  // 6. self-heal (only if enabled): rename a stale test-id on a local branch, validated by re-run, reverted on any failure. Never pushes.
  let healResult = null;
  if (healEnabled && eligible(report).length) {
    const runCwd = path.resolve(opts.cwd || '.');
    healResult = await heal({
      report, cwd: runCwd, runId, paths: cfg.selfHeal.paths, maxFiles: cfg.selfHeal.maxFiles, maxLines: cfg.selfHeal.maxLines, branchPrefix: cfg.selfHeal.branchPrefix, mainRun: main,
      validate: async (specs) => { const r = await runResults([...base, ...specArgs(specs), '--out', path.join(out, 'heal-validate')], env); return r.doc && r.doc.data ? r.doc.data : null; },
    });
    writeJson(path.join(out, 'heal.json'), { ok: healResult.status === 'healed' || healResult.status === 'nothing-to-heal', data: healResult });
    files.heal = path.join(out, 'heal.json');
    if (healResult.status === 'refused' || healResult.status === 'reverted') warnings.push(`self-heal ${healResult.status}: ${healResult.reason}${healResult.status === 'reverted' ? ' (the repository was restored)' : ''}`);
  } else if (!healEnabled && eligible(report).length) {
    rerunNotes.push(`${eligible(report).length} stale selector(s) have an exact fix; self-heal is off (triage.selfHeal.enabled or --heal)`);
  }
  const healedKeys = new Set(healResult && healResult.status === 'healed' ? healResult.renames.flatMap((r) => r.tests) : []);

  const stepOf = new Map((actions || []).map((a) => [a.key, a.step]));
  return {
    code: 0,
    doc: {
      ok: true,
      data: {
        status: 'triaged', runId, totals: main.totals, runs: 1 + rerunResults.length, preflight, settings, ...(rerunNotes.length ? { rerunNotes } : {}),
        summary: report.summary,
        verdicts: report.verdicts.map((v) => ({ test: v.test.name, key: v.key, class: v.class, rule: v.rule, confidence: v.confidence, action: v.action, ...(v.reason ? { reason: v.reason } : {}), ...(stepOf.has(v.key) ? { step: stepOf.get(v.key) } : {}), ...(v.proposal ? { proposal: v.proposal } : {}), ...(healedKeys.has(v.key) ? { healed: true } : {}) })),
        ...(healResult ? { heal: healResult } : {}),
        files, ...(warnings.length ? { warnings } : {}),
      },
    },
  };
}

async function main({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr, ...deps } = {}) {
  const emit = (obj) => stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write('Usage: orchestrate.js --framework F [--spec S]... [--test-dir D] [--config-file C] [--cwd D] [--reruns 2] [--preflight ok|failed|unknown] [--snapshot page.html] [--out DIR] [--run-id ID] [--threshold 0.8] [--timeout-ms N] [--no-plan] [--config P] [--source T] [--base-url U]\n');
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
