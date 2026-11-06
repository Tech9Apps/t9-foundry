#!/usr/bin/env node
'use strict';

// Self-heal: fix a stale selector, safely. The ONLY thing here that edits a user's files, so it is deliberately narrow:
//   - one fix: rename a test-id inside locator expressions (a TST-1 verdict at `act` confidence, which carries the exact `proposal`)
//   - only inside the configured test directories; every changed line must differ from the original ONLY by the id
//     (lib/heal-core.js: verifyOnlySubstitution); the new id is validated because it comes from untrusted page HTML
//   - caps on files and lines: over the cap the heal is REFUSED, not applied
//   - on a new local branch under qa/, validated by re-running the failing specs; on ANY failure everything is reverted and
//     the repository is left exactly as it was found
//   - there is no code path here that publishes anything: a heal is a local branch until a human decides otherwise
//   - only files git TRACKS are edited (an untracked or ignored file cannot be restored from a commit); if one of those also holds the old
//     id, the heal is refused rather than left half-done
//   - the validation re-runs the failing specs AND every edited spec; if a shared helper (a page object) was edited, any spec may be
//     affected, so it re-runs the whole selection
//   - an interrupt (SIGINT/SIGTERM/SIGHUP) mid-heal stops the validation run, then runs the same revert before exiting
//   - the test directories are named, never the repository root (application code must not be in scope), and a comment line is not a locator
//   - files it did not scan (a symlink, one over 1 MB) and lines that still mention the old id are reported, even when there is nothing to edit
//   - the specs to re-run come from the report, so each must be inside the repository: a report cannot make the runner execute a file elsewhere
//   - the report is not taken on trust: a verdict must be consistent with what classify.js would have produced
//
//   node scripts/triage/heal.js --report triage.json --main main/result.json --framework F [--cwd D] [--paths a,b]
//        [--spec S]... [--apply [--enable]] [--run-id ID] [--max-files N] [--max-lines N] [--out heal.json] [--config qa-config.json]
//
// Without --apply it only PREVIEWS: the exact lines that would change, nothing written, no git change. --apply needs self-heal to be
// enabled (triage.selfHeal.enabled) or --enable on the command line: "off unless enabled" holds here, not only in the orchestrator.
// Output: { ok, data: { status: healed | preview | nothing-to-heal | refused | reverted, … } }. Exit 0 = healed / preview / nothing to heal,
// 1 = refused or reverted (the repository is unchanged), 2 = bad invocation.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');
const core = require('./lib/heal-core');
const { identity } = require('./fingerprint');
const { triageConfig } = require('./lib/config');
const { extractTestId, evidenceText } = require('./lib/text');
const { defaultRunResults, killActive } = require('./lib/run-results');

// every status a heal can end in; the prose that tells a model what to do for each is checked against this list
const HEAL_STATUSES = ['healed', 'nothing-to-heal', 'refused', 'reverted', 'preview'];

const usage = (message) => Object.assign(new Error(message), { isUsage: true });
const sanitize = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

class Refused extends Error {}

function git(cwd, args, input) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
  } catch (err) {
    const detail = String((err.stderr || err.message || '')).trim().split('\n')[0];
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

const eligible = (report) => report.verdicts.filter((v) => v.rule === 'TST-1' && v.action === 'act' && v.proposal && v.proposal.kind === 'rename-testid');

// A heal edits files, so the report that asks for it is not taken on trust. Everything here is something classify.js guarantees about a
// TST-1 verdict it acted on; a report that breaks any of it was edited, or came from somewhere else, and is refused.
function provenanceProblems(report, v) {
  const problems = [];
  const { from, to } = v.proposal || {};
  if (v.class !== 'test-bug') problems.push(`its class is "${v.class}", not test-bug`);
  if (v.cap) problems.push(`it was held at propose (${v.cap}): its runner format is not trusted`);
  if (report.trusted === false) problems.push('the report says its runner format is not trusted');
  if (!(v.confidence === 0.85)) problems.push(`TST-1 is only ever 0.85, not ${v.confidence}`);
  if (!v.error) problems.push('it records no error to take the test-id from');
  else {
    const seen = extractTestId(evidenceText(v.error));
    if (seen !== from) problems.push(`it renames "${String(from).slice(0, 60)}", but the failure it is based on is about "${seen === null ? 'no test-id' : String(seen).slice(0, 60)}"`);
  }
  const named = Array.isArray(v.evidence) && v.evidence.some((e) => typeof e === 'string' && e.includes(`"${from}"`) && e.includes(`"${to}"`));
  if (!named) problems.push('its evidence does not name both the old and the new id');
  return problems;
}

// What would change, without changing anything. Pure apart from reading files.
function planHeal({ report, cwd, paths, maxFiles, maxLines }) {
  const verdicts = eligible(report);
  if (!verdicts.length) return { renames: [], files: [], nothing: 'no test-bug verdict with an exact fix (TST-1 at act confidence)' };

  const byFrom = new Map();
  for (const v of verdicts) {
    const { from, to } = v.proposal;
    if (!core.isSafeTestId(from) || !core.isSafeTestId(to)) return { refused: `the test-id "${String(to).slice(0, 60)}" (or "${String(from).slice(0, 60)}") contains characters that could break out of a string or selector; it comes from page content and is not trusted` };
    if (byFrom.has(from) && byFrom.get(from).to !== to) return { refused: `"${from}" would be renamed to two different ids ("${byFrom.get(from).to}" and "${to}") — ambiguous` };
    if (!byFrom.has(from)) byFrom.set(from, { from, to, keys: [] });
    byFrom.get(from).keys.push(v.key);
  }
  // ids are checked above first (cheapest, and the one that stops code injection); then the verdict itself is checked against the classifier's guarantees
  for (const v of verdicts) {
    const why = provenanceProblems(report, v);
    if (why.length) return { refused: `the report is not what classify.js would have produced for ${v.key}: ${why.join('; ')}. A heal only acts on a report the classifier wrote` };
  }
  const renames = [...byFrom.values()];
  // A rename applied after another would rewrite the first one's result (step-1 -> step-2, then step-2 -> step-3 turns step-1 into step-3)
  const froms = new Set(renames.map((r) => r.from));
  const chained = renames.find((r) => froms.has(r.to));
  if (chained) return { refused: `"${chained.from}" would be renamed to "${chained.to}", which is itself being renamed in the same heal; applied in turn they would rewrite each other, so a human should decide the order` };

  let root;
  try { root = git(cwd, ['rev-parse', '--show-toplevel']); } catch { return { refused: 'the run directory is not inside a git repository, so a heal cannot be made on a branch or reverted' }; }
  if (!paths || !paths.length) return { refused: 'no test directories are configured for self-heal (triage.selfHeal.paths, or testFramework.testDir)' };
  const { files: candidates, refused: badDirs, skipped } = core.collectFiles({ root, cwd, dirs: paths });
  if (badDirs.length) return { refused: `self-heal paths not usable: ${badDirs.join('; ')}` };

  // Only files git TRACKS may be edited: a heal is committed, and undone, through git, and an untracked or ignored file can be neither.
  let tracked;
  try {
    const realRoot = fs.realpathSync(root);
    tracked = new Set(git(root, ['ls-files', '-z', '--', ...paths.map((p) => path.resolve(cwd, p))]).split('\0').filter(Boolean).map((rel) => { try { return fs.realpathSync(path.join(realRoot, rel)); } catch { return null; } }).filter(Boolean));
  } catch (err) { return { refused: err.message }; }

  const files = []; const leftover = []; const untrackedHits = [];
  for (const file of candidates) {
    const isTracked = tracked.has(file);
    const { bytes, text: original, roundTrips } = core.readText(file);
    let text = original; const changes = [];
    for (const r of renames) {
      const step = core.replaceInLocators(text, r.from, r.to);
      if (!step.changes.length) continue;
      const g = core.verifyOnlySubstitution(text, step.text, r.from, r.to);
      if (!g.ok) return { refused: `${path.relative(root, file)}: the edit would change more than the test-id (${g.reason}); nothing was written` };
      changes.push(...step.changes.map((c) => ({ ...c, rename: `${r.from} → ${r.to}` })));
      text = step.text;
    }
    // a stale reference the patterns do not cover is reported even in a file with nothing to edit: a heal that looks complete must be
    for (const r of renames) for (const l of core.leftovers(text, r.from)) leftover.push({ file: path.relative(root, file), ...l });
    if (!changes.length) continue;
    // a file git does not track would need the same rename but cannot be committed or restored: refuse, do not leave the heal half-done
    if (!isTracked) { untrackedHits.push(path.relative(root, file)); continue; }
    // decoding invalid UTF-8 and writing it back would corrupt lines the heal never meant to touch
    if (!roundTrips) return { refused: `${path.relative(root, file)} is not valid UTF-8, so editing it as text would corrupt bytes the heal does not mean to change; nothing was written` };
    files.push({ path: file, rel: path.relative(root, file), changes, before: original, after: text, bytes });
  }
  if (untrackedHits.length) return { refused: `${untrackedHits.join(', ')} ${untrackedHits.length === 1 ? 'is' : 'are'} not tracked by git (new or ignored) but would need the same rename. A heal only edits tracked files, because it is committed and undone through git, and leaving ${untrackedHits.length === 1 ? 'it' : 'them'} stale would make the heal half-done. Track ${untrackedHits.length === 1 ? 'it' : 'them'} or move ${untrackedHits.length === 1 ? 'it' : 'them'} out of the heal paths` };
  if (!files.length) return { renames, files: [], leftovers: leftover, notScanned: skipped, nothing: `no locator for ${renames.map((r) => `"${r.from}"`).join(', ')} was found in ${paths.join(', ')}` };
  const lines = files.reduce((n, f) => n + f.changes.length, 0);
  if (files.length > maxFiles) return { refused: `it would touch ${files.length} files, more than the limit of ${maxFiles} (triage.selfHeal.maxFiles); a rename that wide needs a human`, renames };
  if (lines > maxLines) return { refused: `it would change ${lines} lines, more than the limit of ${maxLines} (triage.selfHeal.maxLines); a rename that wide needs a human`, renames };
  return { renames, files, root, leftovers: leftover, notScanned: skipped, lines };
}

const diffOf = (files) => files.map((f) => ({ file: f.rel, lines: f.changes.map((c) => ({ line: c.line, rename: c.rename, before: c.before.trim(), after: c.after.trim() })) }));

async function heal({ report, cwd, runId, paths, maxFiles = 5, maxLines = 20, branchPrefix = 'qa/heal-', mainRun, validate, apply = true, proc = process }) {
  const planned = planHeal({ report, cwd, paths, maxFiles, maxLines });
  if (planned.refused) return { status: 'refused', reason: planned.refused };
  if (planned.nothing) return { status: 'nothing-to-heal', reason: planned.nothing, ...(planned.leftovers && planned.leftovers.length ? { leftovers: planned.leftovers, note: 'these lines still mention the old id and were NOT edited (a constant, a comment, or a form no pattern covers)' } : {}), ...(planned.notScanned && planned.notScanned.length ? { notScanned: planned.notScanned } : {}) };
  const healed = eligible(report);
  const summary = { renames: planned.renames.map((r) => ({ from: r.from, to: r.to, tests: r.keys })), changes: diffOf(planned.files), changedLines: planned.lines, ...(planned.leftovers.length ? { leftovers: planned.leftovers, note: 'these lines still mention the old id and were NOT edited (a constant, a comment, or a form no pattern covers); the heal may be partial' } : {}), ...(planned.notScanned.length ? { notScanned: planned.notScanned } : {}) };
  if (!apply) return { status: 'preview', ...summary };

  if (!/^qa\/[A-Za-z0-9._-]*$/.test(branchPrefix)) return { status: 'refused', reason: `the heal branch prefix "${branchPrefix}" must start with "qa/"` };
  const root = planned.root;
  // the specs to re-run come from the REPORT, which is not trusted: one outside the repository would make the runner execute a file the heal has no
  // business with. One spelling per file: through a symlink (macOS /tmp) the same file would otherwise appear twice.
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const realRoot = real(root);
  const failingSpecs = healed.map((v) => v.test.file).filter(Boolean).map((f) => real(path.resolve(cwd, f)));
  const strays = failingSpecs.filter((f) => f !== realRoot && !f.startsWith(`${realRoot}${path.sep}`));
  if (strays.length) return { status: 'refused', reason: `the report names a spec outside the repository (${strays[0].slice(0, 120)}); a heal only re-runs tests inside it` };
  let base; let baseSha; const branch = `${branchPrefix}${sanitize(runId)}`;
  try {
    if (git(root, ['status', '--porcelain', '--untracked-files=no'])) return { status: 'refused', reason: 'the working tree has uncommitted changes to tracked files; a heal never mixes its edits with yours' };
    // --show-current, not rev-parse --abbrev-ref: with a TAG named like the branch, the latter prints "heads/main", and switching back to that fails
    base = git(root, ['branch', '--show-current']);
    if (!base) return { status: 'refused', reason: 'HEAD is detached; check out a named branch first' };
    baseSha = git(root, ['rev-parse', 'HEAD']);
    let exists = true;
    try { git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); } catch { exists = false; }
    if (exists) return { status: 'refused', reason: `the branch ${branch} already exists` };
  } catch (err) {
    return { status: 'refused', reason: err.message };
  }

  // Everything needed to put the files back is kept in memory: the exact bytes of each one. Nothing about the restore depends on git being
  // in a good state, and the end of it is CHECKED rather than assumed.
  const originals = planned.files.map((f) => ({ path: f.path, rel: f.rel, bytes: f.bytes }));
  let finished = false;

  // Put everything back exactly as found. Synchronous on purpose: it also runs from a signal handler, where nothing can be awaited.
  const revert = () => {
    const problems = [];
    for (const o of originals) {
      // from the BASE COMMIT, not the index: a failed commit leaves the edit staged, and a plain checkout would restore it from there
      try { git(root, ['checkout', baseSha, '--', o.rel]); } catch (e) { problems.push(e.message); }
      // one file's failure must not stop the others, and whatever git said, the file must hold its original bytes again
      try { if (!fs.readFileSync(o.path).equals(o.bytes)) fs.writeFileSync(o.path, o.bytes); } catch (e) { problems.push(`${o.rel}: ${e.message}`); }
    }
    try { git(root, ['switch', base]); } catch (e) { problems.push(e.message); }
    try { if (git(root, ['rev-parse', `refs/heads/${branch}`]) === baseSha) git(root, ['branch', '-D', branch]); } catch (e) { problems.push(e.message); }
    try { if (git(root, ['status', '--porcelain', '--untracked-files=no'])) problems.push('the working tree is not clean after the restore'); } catch (e) { problems.push(e.message); }
    return problems;
  };

  // An interrupt mid-heal (a killed agent, a CI timeout) used to leave the user on the heal branch with edited files. Now it reverts first.
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((sig) => [sig, () => {
    if (finished) return;
    finished = true;
    try { killActive(); } catch { /* nothing running */ } // first: a runner left going would write into the project after it has been put back
    const problems = revert();
    try { (proc.stderr || process.stderr).write(`heal: interrupted by ${sig}; ${problems.length ? `the repository could NOT be fully restored (${problems.join('; ')})` : 'the repository was restored exactly as found'}\n`); } catch { /* nobody to tell */ }
    proc.exit(128 + ((os.constants.signals || {})[sig] || 0));
  }]);
  const arm = () => handlers.forEach(([sig, h]) => proc.on(sig, h));
  const disarm = () => handlers.forEach(([sig, h]) => proc.removeListener(sig, h));

  try {
    arm(); // before the first change, so there is no window in which an interrupt finds nothing to undo
    try { git(root, ['switch', '-c', branch]); } catch (err) { finished = true; disarm(); return { status: 'refused', reason: `the heal branch ${branch} could not be created (${err.message}); nothing was changed` }; }
    for (const f of planned.files) fs.writeFileSync(f.path, f.after);

    // Validate by re-running: the failing specs AND every spec file that was edited (a rename can fix one page and break another). If a
    // shared helper was edited, any spec may be affected, so the whole selection is re-run (an empty list means "the same selection as
    // the main run"). Every healed test must pass, and nothing that was not already failing may now fail.
    const editedSpecs = planned.files.filter((f) => core.isSpecFile(f.rel)).map((f) => real(f.path));
    const helperEdited = planned.files.some((f) => !core.isSpecFile(f.rel));
    const specs = helperEdited ? [] : [...new Set([...failingSpecs, ...editedSpecs])];
    const result = await validate(specs);
    if (!result || !Array.isArray(result.tests)) throw new Refused('the validation re-run produced no usable result');
    const byKey = new Map(result.tests.map((t) => [identity(t), t]));
    const stillFailing = healed.filter((v) => !byKey.has(v.key) || byKey.get(v.key).status !== 'passed');
    if (stillFailing.length) throw new Refused(`after the rename, ${stillFailing.map((v) => v.key).join(', ')} still ${stillFailing.length === 1 ? 'does' : 'do'} not pass`);
    const before = mainRun ? mainRun.tests : [];
    const passedBefore = new Set(before.filter((t) => t.status === 'passed').map(identity));
    const failedBefore = new Set(before.filter((t) => t.status === 'failed').map(identity));
    const regressed = result.tests.filter((t) => t.status === 'failed' && !failedBefore.has(identity(t)));
    if (regressed.length) throw new Refused(`the rename broke ${regressed.map((t) => `${identity(t)}, which ${passedBefore.has(identity(t)) ? 'passed' : 'had not failed'} before`).join('; ')}`);
    // root is git's own (resolved) toplevel and the specs were normalised to real paths above, so a plain relative path is already right
    const validated = { scope: helperEdited ? 'selection' : 'specs', specs: specs.map((sp) => path.relative(root, sp)), passed: result.totals.passed, failed: result.totals.failed };

    const message = [
      `qa-heal: rename test-id "${planned.renames[0].from}" -> "${planned.renames[0].to}"${planned.renames.length > 1 ? ` (+${planned.renames.length - 1} more)` : ''} (run ${runId})`, '',
      'Made by the QA triage orchestrator. A human must review this before it is merged.', '',
      ...planned.renames.map((r) => `${r.from} -> ${r.to}: ${r.keys.join(', ')}`), '',
      `Evidence: ${healed[0].evidence[0]}`,
      `Changed ${planned.lines} line(s) in ${planned.files.length} file(s); every changed line differs from the original only by the id.`,
      `Validated by re-running ${validated.scope === 'selection' ? 'the whole selection (a shared helper was edited)' : validated.specs.join(', ')}: ${validated.passed} passed, ${validated.failed} failed.`, '',
    ].join('\n');
    git(root, ['add', '--', ...planned.files.map((f) => f.rel)]);
    git(root, ['commit', '-q', '-F', '-'], message);
    const commit = git(root, ['rev-parse', 'HEAD']);
    git(root, ['switch', base]);
    finished = true; disarm();
    return { status: 'healed', base, branch, commit, ...summary, validated, review: `git diff ${base}..${branch}` };
  } catch (err) {
    // ANY failure: put everything back exactly as found
    finished = true; disarm();
    const problems = revert();
    return { status: 'reverted', reason: err.message, restored: problems.length === 0, ...(problems.length ? { problems } : {}) };
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {};
  for (let n = 0; n < argv.length; n += 1) {
    const flag = argv[n];
    const value = () => { if (n + 1 >= argv.length) throw usage(`${flag} needs a value`); n += 1; return argv[n]; };
    if (flag === '--report') opts.report = value();
    else if (flag === '--main') opts.main = value();
    else if (flag === '--framework') opts.framework = value();
    else if (flag === '--cwd') opts.cwd = value();
    else if (flag === '--paths') opts.paths = value().split(',').map((s) => s.trim()).filter(Boolean);
    else if (flag === '--spec') (opts.specs = opts.specs || []).push(value());
    else if (flag === '--apply') opts.apply = true;
    else if (flag === '--enable') opts.enable = true;
    else if (flag === '--run-id') opts.runId = value();
    else if (flag === '--max-files') opts.maxFiles = Number(value());
    else if (flag === '--max-lines') opts.maxLines = Number(value());
    else if (flag === '--out') opts.out = value();
    else if (flag === '--config') opts.config = value();
    else throw usage(`unknown option ${flag}`);
  }
  if (!opts.report) throw usage('--report <triage.json> is required');
  if (opts.apply && !(opts.main && opts.framework)) throw usage('--apply needs --main <the main run result.json> and --framework, to validate the heal by re-running');
  // the same bounds the config and the schema enforce: a flag may tighten a cap, not lift it
  const BOUNDS = { maxFiles: [20, '--max-files'], maxLines: [200, '--max-lines'] };
  for (const [k, [hi, name]] of Object.entries(BOUNDS)) if (opts[k] !== undefined && !(Number.isInteger(opts[k]) && opts[k] >= 1 && opts[k] <= hi)) throw usage(`${name} must be a whole number from 1 to ${hi}`);
  if (opts.enable && !opts.apply) throw usage('--enable only means something with --apply');
  return opts;
}

// What the project's config says a heal may rest on: the runner formats it trusts, and the confidence it demands. A flag given to the
// orchestrator that loosened these does not carry over to a later heal.js run.
function configFloorProblem(report, cfg) {
  if (report.format && !cfg.trustedFormats.includes(report.format)) return `the report is from ${report.format} output, which this project's config does not trust (triage.trustedFormats: ${cfg.trustedFormats.join(', ') || 'none'}); a heal only acts on formats the project has verified`;
  const low = eligible(report).filter((v) => v.confidence < cfg.confidenceThreshold);
  if (low.length) return `${low.map((v) => v.key).join(', ')} is at confidence ${low[0].confidence}, below the configured triage.confidenceThreshold of ${cfg.confidenceThreshold}`;
  return null;
}

const readJson = (file) => {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw Object.assign(new Error(`cannot read ${file}: ${e.message}`), { code: 'UNREADABLE' }); }
  return doc && doc.data ? doc.data : doc;
};

async function main({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr, runResults = defaultRunResults, now = Date.now } = {}) {
  const out = (obj) => stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write('Usage: heal.js --report <triage.json> [--main <result.json> --framework F] [--cwd D] [--paths a,b] [--spec S]... [--apply [--enable]] [--run-id ID] [--max-files N] [--max-lines N] [--out FILE] [--config P]\n');
      return argv.length ? 0 : 2;
    }
    const opts = parseArgs(argv);
    const cfg = triageConfig({ configPath: opts.config, env });
    const report = readJson(opts.report);
    if (!report || !Array.isArray(report.verdicts)) throw Object.assign(new Error(`${opts.report} is not a triage report (no "verdicts" array)`), { code: 'UNREADABLE' });
    const mainRun = opts.main ? readJson(opts.main) : undefined;
    const cwd = path.resolve(opts.cwd || '.');
    const runId = opts.runId || new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const validate = async (specs) => {
      // an empty list means a shared helper was edited: re-run the SAME selection as the main run (--spec), not the project's default suite, or an
      // unrelated failure outside that selection would be blamed on the rename
      const r = await runResults(['--framework', opts.framework, '--cwd', cwd, ...(specs.length ? specs : opts.specs || []).flatMap((s) => ['--spec', s]), '--quiet', '--out', path.join(path.dirname(path.resolve(opts.report)), 'heal-validate'), ...(opts.config ? ['--config', opts.config] : [])], env);
      return r.doc && r.doc.data ? r.doc.data : null;
    };
    // "off unless enabled" is a property of the heal, not just of the orchestrator: --apply needs the setting, or an explicit --enable
    if (opts.apply && !opts.enable && !cfg.selfHeal.enabled) {
      const data = { status: 'refused', reason: 'self-heal is off (triage.selfHeal.enabled in qa-config.json). Enable it there, or pass --enable to say you mean it for this run. Without --apply this only previews' };
      const doc = { ok: false, data };
      if (opts.out) { fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true }); fs.writeFileSync(opts.out, `${JSON.stringify(doc, null, 2)}\n`); }
      out(doc);
      return 1;
    }
    // The project's own limits are a FLOOR here too, not only in the orchestrator: a report written earlier (or under looser flags) must not heal
    // more than the config now allows. Flags may tighten a limit, never lift it.
    const floor = opts.apply ? configFloorProblem(report, cfg) : null;
    if (floor) {
      const doc = { ok: false, data: { status: 'refused', reason: floor } };
      if (opts.out) { fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true }); fs.writeFileSync(opts.out, `${JSON.stringify(doc, null, 2)}\n`); }
      out(doc);
      return 1;
    }
    const data = await heal({
      report, cwd, runId, paths: opts.paths || cfg.selfHeal.paths, maxFiles: Math.min(opts.maxFiles || cfg.selfHeal.maxFiles, cfg.selfHeal.maxFiles), maxLines: Math.min(opts.maxLines || cfg.selfHeal.maxLines, cfg.selfHeal.maxLines),
      branchPrefix: cfg.selfHeal.branchPrefix, mainRun, validate, apply: !!opts.apply,
    });
    const doc = { ok: data.status === 'healed' || data.status === 'preview' || data.status === 'nothing-to-heal', data };
    if (opts.out) { fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true }); fs.writeFileSync(opts.out, `${JSON.stringify(doc, null, 2)}\n`); }
    out(doc);
    return doc.ok ? 0 : 1;
  } catch (err) {
    if (err && err.isUsage) { stderr.write(`heal.js: ${err.message}\n`); return 2; }
    out({ ok: false, error: { code: err.code || 'UNEXPECTED', message: err.message } });
    return 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { main, heal, planHeal, eligible, provenanceProblems, HEAL_STATUSES };
