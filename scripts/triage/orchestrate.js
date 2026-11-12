#!/usr/bin/env node
'use strict';

// The deterministic spine of the QA-run-orchestrator: run the suite → re-run ONLY the failing specs → gather locator
// evidence → classify → plan. One command, so the agent does not have to choreograph six steps from prose; what is
// left to the agent is judgement and the human-gated actions (/file-bug, comments).
//
//   node scripts/triage/orchestrate.js --framework <f> [--spec S]... [--test-dir D] [--config-file C] [--cwd D]
//        [--reruns N] [--preflight ok|failed|unknown] [--snapshot page.html] [--out qa-results] [--run-id ID]
//        [--threshold T] [--trusted-formats tap] [--timeout-ms N] [--no-plan] [--heal | --no-heal] [--config qa-config.json] [--source T] [--base-url U]
//
// Steps (each tool is the one documented elsewhere; this only wires them):
//   1. scripts/results/run.js   the main run                       → <out>/main/
//   2. scripts/results/run.js   re-run each failing spec, N times   → <out>/rerun-<k>/   (skipped if preflight failed)
//   3. scripts/triage/locators.js  for locator failures, if --snapshot is given
//   4. scripts/triage/classify.js                                   → <out>/triage.json
//   5. scripts/triage/plan.js   (read-only tracker search)          → <out>/plan.json, <out>/flaky.json
//   6. scripts/triage/heal.js   ONLY if self-heal is enabled (triage.selfHeal.enabled / --heal): rename a stale test-id on a local
//      qa/ branch, validated by re-run, fully reverted on any failure; it never pushes   → <out>/heal.json
// --reruns (default 2, 0–5), --threshold (default 0.8) and --trusted-formats (default tap: the runner formats whose classification may
// let a product-bug or test-bug verdict ACT; every other format is held at propose) can also be set once in qa-config.json under "triage"
// (reruns, confidenceThreshold, trustedFormats); a flag overrides the config. The output says which source each setting came from.
// A green run ends after step 1. Output: { ok, data } with the verdict and step for every failure.
// Exit: 0 = completed (green, or triaged — failures are data) · 2 = bad invocation · 3 = no trustworthy main run
// (see scripts/results/run.js: could not start, hung, wrote nothing, zero tests, or exit code contradicting the report).

const fs = require('fs');
const path = require('path');
const { defaultRunResults } = require('./lib/run-results');
const { classify, makeKeyer, parseTrustedFormats } = require('./classify');
const { analyzeLocator } = require('./locators');
const { isLocatorError, extractTestId, evidenceText } = require('./lib/text');
const { plan, connectIfNeeded, writeCommentInputs, isValidRunId } = require('./plan');
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
    else if (flag === '--trusted-formats') opts.trustedFormats = parseTrustedFormats(value());
    else if (flag === '--timeout-ms') opts.timeoutMs = Number(value());
    else if (flag === '--no-plan') opts.noPlan = true;
    else if (flag === '--heal' || flag === '--no-heal') {
      // the last one used to win silently, so `--no-heal --heal` healed; two opposite instructions are a mistake, not a preference
      if (opts.heal !== undefined && opts.heal !== (flag === '--heal')) throw usage('--heal and --no-heal contradict each other; give one');
      opts.heal = flag === '--heal';
    }
    else if (flag === '--config') opts.config = value();
    else if (flag === '--source') opts.source = value();
    else if (flag === '--base-url') opts.baseUrl = value();
    else throw usage(`unknown option ${flag}`);
  }
  if (opts.reruns !== undefined && (!Number.isInteger(opts.reruns) || opts.reruns < 0 || opts.reruns > MAX_RERUNS)) throw usage(`--reruns must be a whole number from 0 to ${MAX_RERUNS}`);
  if (opts.preflight && !['ok', 'failed', 'unknown'].includes(opts.preflight)) throw usage('--preflight must be ok, failed or unknown');
  if (opts.threshold !== undefined && !(opts.threshold > 0 && opts.threshold <= 1)) throw usage('--threshold must be between 0 and 1');
  if (opts.timeoutMs !== undefined && !(Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0)) throw usage('--timeout-ms must be a positive whole number of milliseconds');
  // the run id ends up in tracker idempotency keys (an odd one is hashed there, see plan.js runPart) and in comment text
  if (opts.runId !== undefined && !isValidRunId(opts.runId)) throw usage('--run-id must be 1-128 characters with no control characters');
  return opts;
}

// What to tell the user about a heal that did not land. "Restored" is only ever said when the heal says it checked (`restored`): it used to be
// appended to every revert, including one whose own result said it had not managed to put everything back.
function healWarning(h) {
  if (h.status === 'refused') return `self-heal refused: ${h.reason}`;
  if (h.status !== 'reverted') return null;
  if (h.restored === false) return `self-heal reverted: ${h.reason} (the repository was NOT fully restored: ${(h.problems || ['unknown']).join('; ')} — run git status before doing anything else)`;
  return `self-heal reverted: ${h.reason} (the repository was restored)`;
}

// What an earlier run left in <out>, cleared by OWNERSHIP, not by name: <out> may be a directory the user also keeps things in (--out . is legal), and a
// snapshots/ or a plan.json there is not ours to delete. A file is ours when its NAME and its SHAPE are what this tool writes; a directory is removed only
// if that left it empty. (run.js protects its raw/ the same way, with a marker.)
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const OWNED_FILES = {
  'triage.json': (d) => isObj(d) && isObj(d.data) && Array.isArray(d.data.verdicts),
  'plan.json': (d) => isObj(d) && isObj(d.data) && Array.isArray(d.data.actions),
  'flaky.json': (d) => isObj(d) && Array.isArray(d.flaky) && 'runId' in d,
  'evidence.json': (d) => isObj(d) && Object.values(d).every((v) => isObj(v) && 'locator' in v),
};
function clearStale(out, warnings) {
  if (!fs.existsSync(out)) return;
  const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
  for (const e of fs.readdirSync(out, { withFileTypes: true })) {
    const p = path.join(out, e.name);
    if (OWNED_FILES[e.name]) {
      if (e.isSymbolicLink()) { fs.unlinkSync(p); warnings.push(`${e.name} in ${out} was a symlink: the link was removed (its target was not touched), so an earlier run's file cannot stand in for this one`); } // eslint-disable-line max-len
      else if (e.isFile() && OWNED_FILES[e.name](readJson(p))) rm(p);
    } else if (e.isDirectory() && /^rerun-\d+$/.test(e.name)) {
      // only what run.js writes into an --out directory (result.json, raw/); a user's file in the same directory stays, and so does the directory
      for (const name of ['result.json', 'raw']) if (fs.existsSync(path.join(p, name))) rm(path.join(p, name));
      if (!fs.readdirSync(p).length) fs.rmdirSync(p);
    } else if (e.isDirectory() && (e.name === 'snapshots' || e.name === 'comments')) {
      const mine = e.name === 'snapshots' ? /^qafp[0-9a-f]{12}\.html$/ : /^qafp[0-9a-f]{12}\.json$/;
      for (const f of fs.readdirSync(p, { withFileTypes: true })) if (f.isFile() && mine.test(f.name)) rm(path.join(p, f.name));
      if (!fs.readdirSync(p).length) fs.rmdirSync(p);
    }
  }
}

const writeJson = (file, obj) => { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`); };
const needsTriage = (t) => t.status === 'failed' || t.flaky;

async function orchestrate(opts, { env = process.env, fetch = globalThis.fetch, runResults = defaultRunResults, now = Date.now } = {}) {
  const out = opts.out || 'qa-results';
  // flag > qa-config.json "triage" block > default
  const cfg = triageConfig({ configPath: opts.config, env });
  const reruns = opts.reruns !== undefined ? opts.reruns : cfg.reruns;
  const threshold = opts.threshold !== undefined ? opts.threshold : cfg.confidenceThreshold;
  const trustedFormats = opts.trustedFormats !== undefined ? opts.trustedFormats : cfg.trustedFormats;
  const healEnabled = opts.heal !== undefined ? opts.heal : cfg.selfHeal.enabled;
  const settings = {
    reruns: { value: reruns, from: opts.reruns !== undefined ? 'flag' : cfg.explicit.reruns ? 'config' : 'default' },
    confidenceThreshold: { value: threshold, from: opts.threshold !== undefined ? 'flag' : cfg.explicit.confidenceThreshold ? 'config' : 'default' },
    trustedFormats: { value: trustedFormats, from: opts.trustedFormats !== undefined ? 'flag' : cfg.explicit.trustedFormats ? 'config' : 'default' },
    selfHeal: { value: healEnabled, from: opts.heal !== undefined ? 'flag' : cfg.explicitSelfHeal ? 'config' : 'default' },
  };
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
  clearStale(out, warnings);

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
  const rerunResults = []; const rerunNotes = [];
  if (preflight === 'failed') rerunNotes.push('re-runs skipped: preflight reported the environment as not ready');
  else if (reruns > 0) {
    const files = [...new Set(targets.map((t) => t.file).filter(Boolean))];
    const everyFileKnown = targets.every((t) => t.file);
    const scope = everyFileKnown ? files : opts.specs; // no file for some failure: re-run what the main run ran
    if (!everyFileKnown) rerunNotes.push('some failures carry no file location, so each re-run repeats the whole selection');
    for (let k = 1; k <= reruns; k += 1) {
      const r = await runResults([...base, ...specArgs(scope), '--out', path.join(out, `rerun-${k}`)], env);
      // exit 3 WITH a report = the runner's exit code contradicts its own report (a crash after a partial report). The main run stops on that; a re-run
      // that is not trusted must not count either: its "pass" would turn a consistent failure into a flaky one.
      if (r.code === 3 && r.doc && r.doc.data) warnings.push(`re-run ${k} cannot be trusted (${(r.doc.warnings && r.doc.warnings[0]) || 'its exit code contradicts its report'}); it is not counted, classifying with ${rerunResults.length + 1} run(s)`);
      else if (r.doc && r.doc.data) rerunResults.push(r.doc.data);
      else warnings.push(`re-run ${k} produced no usable report (${(r.doc && r.doc.error && r.doc.error.message) || `exit ${r.code}`}); classifying with ${rerunResults.length + 1} run(s)`);
    }
  }

  // 3. locator evidence from a DOM snapshot, for failures that look like a missing element
  const evidence = {};
  if (opts.snapshot) {
    let html = null;
    try { html = fs.readFileSync(opts.snapshot, 'utf8'); } catch (e) { warnings.push(`snapshot not readable (${e.message}): locator failures stay undetermined`); }
    if (html !== null) {
      // read the whole failure text, not just its first line: Playwright keeps "waiting for getByTestId('x')" in the details
      const { keyOf } = makeKeyer([main, ...rerunResults]); // the same key classify() looks the evidence up by
      for (const t of main.tests.filter((x) => x.status === 'failed' && x.error && isLocatorError(evidenceText(x.error)))) {
        if (!extractTestId(evidenceText(t.error))) continue;
        try { evidence[keyOf(t)] = { locator: analyzeLocator({ html, selector: evidenceText(t.error), bare: false }) }; } catch (e) {
          if (!e.code) throw e;
          warnings.push(`locator evidence unavailable for ${t.name}: ${e.message}`);
        }
      }
    }
  }

  // 4. classify
  const report = classify({ runs: [main, ...rerunResults], preflight, evidence, threshold, trustedFormats, root: path.resolve(opts.cwd || process.cwd()) });
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

  // 6. self-heal (only if enabled): rename a stale test-id on a local branch, validated by re-run, reverted on any failure. Never pushes.
  let healResult = null;
  if (healEnabled && eligible(report).length) {
    const runCwd = path.resolve(opts.cwd || '.');
    healResult = await heal({
      report, cwd: runCwd, runId, paths: cfg.selfHeal.paths, maxFiles: cfg.selfHeal.maxFiles, maxLines: cfg.selfHeal.maxLines, branchPrefix: cfg.selfHeal.branchPrefix, mainRun: main,
      // an empty list means a shared helper was edited: re-run the same selection the main run used, not nothing
      validate: async (specs) => { const r = await runResults([...base, ...specArgs(specs.length ? specs : opts.specs), '--out', path.join(out, 'heal-validate')], env); return r.doc && r.doc.data ? r.doc.data : null; },
    });
    writeJson(path.join(out, 'heal.json'), { ok: healResult.status === 'healed' || healResult.status === 'nothing-to-heal', data: healResult });
    files.heal = path.join(out, 'heal.json');
    const hw = healWarning(healResult);
    if (hw) warnings.push(hw);
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
        verdicts: report.verdicts.map((v) => ({ test: v.test.name, key: v.key, class: v.class, rule: v.rule, confidence: v.confidence, action: v.action, ...(v.cap ? { cap: v.cap } : {}), ...(v.reason ? { reason: v.reason } : {}), ...(stepOf.has(v.key) ? { step: stepOf.get(v.key) } : {}), ...(v.proposal ? { proposal: v.proposal } : {}), ...(healedKeys.has(v.key) ? { healed: true } : {}) })),
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
      stderr.write('Usage: orchestrate.js --framework F [--spec S]... [--test-dir D] [--config-file C] [--cwd D] [--reruns 2] [--preflight ok|failed|unknown] [--snapshot page.html] [--out DIR] [--run-id ID] [--threshold 0.8] [--trusted-formats tap|none] [--timeout-ms N] [--no-plan] [--heal | --no-heal] [--config P] [--source T] [--base-url U]\n');
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

module.exports = { main, orchestrate, healWarning, MAX_RERUNS };
