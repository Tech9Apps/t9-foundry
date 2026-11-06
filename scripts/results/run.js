#!/usr/bin/env node
'use strict';

// Run the project's tests so they emit a structured report, then normalize it. This replaces scraping
// "5 passed, 1 failed" out of console output.
//
//   node scripts/results/run.js [--framework playwright|cypress|pytest|rspec|jest|webdriverio|node]
//                               [--test-dir D] [--config-file F] [--spec S]... [--headed]
//                               [--out qa-results] [--cwd D] [--config qa-config.json]
//                               [--timeout-ms N] [--quiet] [--allow-all-skipped] [--dry-run]
//
//   --framework / --test-dir / --config-file default to testFramework.* in qa-config.json
//   --out       the report goes to <out>/raw (cleared first, so a stale report can never pass for this run);
//               the normalized result to <out>/result.json
//   --quiet     discard the runner's own console output (it goes to stderr otherwise)
//   --allow-all-skipped   a run in which every test was skipped is exit 3 (nothing was verified); pass this if that is intended
//   --dry-run   print the command and the report location; run nothing
//
// The runner's own output goes to stderr; stdout is ONE JSON document:
//   { ok, exitCode, command, durationMs, resultPath, data?: <run result>, warnings?, error? }
// Exit: 0 every test passed · 1 tests failed · 2 bad invocation · 3 no trustworthy report (the runner
// could not start, timed out, wrote nothing, listed no tests, EVERY test was skipped, or its exit code contradicts its report).

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { plan, SUPPORTED } = require('./frameworks');
const { normalizePath } = require('./normalize');
const { findConfig } = require('../tracker/lib/connect');
const { usage, readJson, parseFlags, jsonPrinter } = require('../lib/cli');

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MARKER = '.qa-results-raw';
// Only reports this tool (or the frameworks it drives) writes. Used to refuse clearing a directory that holds anything else.
const OURS = /^(results[-\w.]*\.(xml|json|tap)|\.qa-results-raw)$/;

// These values are handed to the test runner as arguments. A value that starts with "-" would be read by the runner as one of ITS options
// (a spec of "--import=./x.js" would make node load that file), so it is refused; write ./-name for a file that really starts with "-".
const runnerArg = (v, flag) => {
  if (v.startsWith('-')) throw usage(`${flag} "${v.slice(0, 40)}" starts with "-", so the test runner would read it as an option; write it as ./${v} if it really is a path`);
  return v;
};

const FLAGS = {
  '--framework': { key: 'framework' },
  '--test-dir': { key: 'testDir', parse: runnerArg },
  '--config-file': { key: 'configFile', parse: runnerArg },
  '--spec': { key: 'specs', list: true, parse: runnerArg },
  '--headed': { key: 'headed', set: true },
  '--out': { key: 'out' },
  '--cwd': { key: 'cwd' },
  '--config': { key: 'config' },
  '--timeout-ms': { key: 'timeoutMs', parse: Number },
  '--quiet': { key: 'quiet', set: true },
  '--allow-all-skipped': { key: 'allowAllSkipped', set: true },
  '--dry-run': { key: 'dryRun', set: true },
};

function parseArgs(argv) {
  const opts = parseFlags(argv, FLAGS, { init: { specs: [] } });
  if (opts.timeoutMs !== undefined && !(opts.timeoutMs > 0)) throw usage('--timeout-ms must be a positive number');
  return opts;
}

function fromConfig(opts, env) {
  const file = findConfig(opts.config, env);
  if (!file) return {};
  return (readJson(file, { fail: usage }) || {}).testFramework || {}; // a config that is literally `null` has no testFramework: "no framework" follows
}

// The runs in flight. A caller that is itself interrupted (self-heal reverting on SIGTERM) must stop them: a runner left going keeps writing into the
// project after the caller has put everything back.
const ACTIVE = new Set();
function killActive(signal = 'SIGTERM') {
  for (const child of ACTIVE) { try { child.kill(signal); } catch { /* already gone */ } }
}

function runChild({ spawn, command, args, env, cwd, timeoutMs, quiet }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: quiet ? 'ignore' : ['ignore', 2, 2] });
    } catch (err) {
      resolve({ spawnError: err });
      return;
    }
    ACTIVE.add(child);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); ACTIVE.delete(child); resolve({ spawnError: err }); });
    child.on('close', (code, signal) => { clearTimeout(timer); ACTIVE.delete(child); resolve({ code, signal, timedOut }); });
  });
}

async function main({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr, spawn = childProcess.spawn, now = Date.now } = {}) {
  const out = jsonPrinter(stdout);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write('Usage: run.js [--framework F] [--test-dir D] [--config-file F] [--spec S]... [--headed] [--out DIR] [--cwd D] [--config P] [--timeout-ms N] [--quiet] [--allow-all-skipped] [--dry-run]\n');
      return argv.length ? 0 : 2;
    }
    const opts = parseArgs(argv);
    const cfg = fromConfig(opts, env);
    const framework = opts.framework || cfg.type;
    if (!framework) throw usage('no framework: pass --framework or set testFramework.type in qa-config.json');
    const outDir = opts.out || 'qa-results';
    const rawDir = path.join(outDir, 'raw');
    const p = plan({ framework, outDir: rawDir, testDir: opts.testDir || cfg.testDir, configPath: opts.configFile || cfg.configPath, specs: opts.specs, headed: opts.headed });
    if (!p) {
      throw usage(`no built-in structured-results recipe for "${framework}" (supported: ${SUPPORTED.join(', ')}). Run your suite however you normally do and point scripts/results/normalize.js at its JUnit/TAP/JSON report`);
    }
    const command = [p.command, ...p.args].join(' ');
    const resultPath = path.join(outDir, 'result.json');

    if (opts.dryRun) {
      out({ ok: true, dryRun: true, framework, command, cwd: path.resolve(opts.cwd || '.'), env: Object.keys(p.env), report: p.results, format: p.format, resultPath, notes: p.notes });
      return 0;
    }

    // never let a previous run's report stand in for this one — but --out is caller-controlled, so only clear a directory that holds nothing
    // except reports (ours or the frameworks'). Anything else in there is somebody's, and is not ours to delete.
    if (fs.existsSync(rawDir)) {
      const entries = fs.readdirSync(rawDir);
      // the marker means this tool made the directory (whatever a framework chose to name its report files); without it, only reports qualify
      const foreign = entries.includes(MARKER) ? [] : entries.filter((name) => !OURS.test(name));
      if (foreign.length) throw usage(`refusing to clear ${rawDir}: it holds files that are not test reports (${foreign.slice(0, 3).join(', ')}). Choose another --out, or remove it yourself.`);
    }
    fs.rmSync(rawDir, { recursive: true, force: true });
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, MARKER), 'created by scripts/results/run.js; it is cleared before every run\n');

    const started = now();
    const run = await runChild({ spawn, command: p.command, args: p.args, env: { ...env, ...p.env }, cwd: opts.cwd, timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS, quiet: opts.quiet });
    const durationMs = now() - started;
    const base = { command, durationMs, resultPath };
    const noReport = (message, extra = {}) => {
      out({ ok: false, ...base, ...extra, error: { code: 'NO_REPORT', message } });
      return 3;
    };

    if (run.spawnError) {
      return noReport(`could not start "${p.command}": ${run.spawnError.code === 'ENOENT' ? `${p.command} is not installed or not on PATH` : run.spawnError.message}`);
    }
    if (run.timedOut) {
      return noReport(`killed after ${opts.timeoutMs || DEFAULT_TIMEOUT_MS}ms — the run did not finish, so there is no complete report`, { exitCode: null });
    }

    let data;
    try {
      data = normalizePath(p.results, { format: p.format, framework });
    } catch (err) {
      return noReport(`${framework} exited ${run.code === null ? `on ${run.signal}` : run.code} but wrote no usable report at ${p.results} (${err.message}). ${p.notes.join(' ')}`.trim(), { exitCode: run.code });
    }
    if (data.totals.total === 0) {
      return noReport(`${framework} exited ${run.code} and its report lists zero tests — the run executed nothing`, { exitCode: run.code });
    }

    if (data.totals.passed === 0 && data.totals.failed === 0 && !opts.allowAllSkipped) {
      return noReport(`every one of the ${data.totals.total} test(s) was skipped, so nothing was verified — that is not a pass (pass --allow-all-skipped if it is intended)`, { exitCode: run.code });
    }

    const warnings = [];
    const failed = data.totals.failed > 0;
    if (run.code !== 0 && !failed) warnings.push(`the runner exited ${run.code} but its report shows no failures — it may have crashed after writing a partial report`);
    if (run.code === 0 && failed) warnings.push('the runner exited 0 but its report shows failures');
    const doc = { ok: run.code === 0 && !failed, exitCode: run.code, ...base, data, ...(warnings.length ? { warnings } : {}) };
    fs.writeFileSync(resultPath, `${JSON.stringify(doc, null, 2)}\n`);
    out(doc);
    if (warnings.length && !failed) return 3;
    return failed || run.code !== 0 ? 1 : 0;
  } catch (err) {
    if (err && err.isUsage) {
      stderr.write(`run.js: ${err.message}\n`);
      return 2;
    }
    out({ ok: false, error: { code: 'UNEXPECTED', message: `unexpected error: ${err && err.message}` } });
    return 3;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { main, killActive, FLAGS };
