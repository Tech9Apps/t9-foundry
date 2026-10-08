#!/usr/bin/env node
'use strict';

// Run the project's tests so they emit a structured report, then normalize it. This replaces scraping
// "5 passed, 1 failed" out of console output.
//
//   node scripts/results/run.js [--framework playwright|cypress|pytest|rspec|jest|webdriverio|node]
//                               [--test-dir D] [--config-file F] [--spec S]... [--headed]
//                               [--out qa-results] [--cwd D] [--config qa-config.json]
//                               [--timeout-ms N] [--dry-run]
//
//   --framework / --test-dir / --config-file default to testFramework.* in qa-config.json
//   --out       the report goes to <out>/raw (cleared first, so a stale report can never pass for this run);
//               the normalized result to <out>/result.json
//   --dry-run   print the command and the report location; run nothing
//
// The runner's own output goes to stderr; stdout is ONE JSON document:
//   { ok, exitCode, command, durationMs, resultPath, data?: <run result>, warnings?, error? }
// Exit: 0 every test passed · 1 tests failed · 2 bad invocation · 3 no trustworthy report (the runner
// could not start, timed out, wrote nothing, or its exit code contradicts its report).

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { plan, SUPPORTED } = require('./frameworks');
const { normalizePath } = require('./normalize');
const { findConfig } = require('../tracker/lib/connect');

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const usage = (message) => Object.assign(new Error(message), { isUsage: true });

function parseArgs(argv) {
  const opts = { specs: [] };
  for (let n = 0; n < argv.length; n += 1) {
    const flag = argv[n];
    const value = () => {
      if (n + 1 >= argv.length) throw usage(`${flag} needs a value`);
      n += 1;
      return argv[n];
    };
    if (flag === '--framework') opts.framework = value();
    else if (flag === '--test-dir') opts.testDir = value();
    else if (flag === '--config-file') opts.configFile = value();
    else if (flag === '--spec') opts.specs.push(value());
    else if (flag === '--headed') opts.headed = true;
    else if (flag === '--out') opts.out = value();
    else if (flag === '--cwd') opts.cwd = value();
    else if (flag === '--config') opts.config = value();
    else if (flag === '--timeout-ms') opts.timeoutMs = Number(value());
    else if (flag === '--dry-run') opts.dryRun = true;
    else throw usage(`unknown option ${flag}`);
  }
  if (opts.timeoutMs !== undefined && !(opts.timeoutMs > 0)) throw usage('--timeout-ms must be a positive number');
  return opts;
}

function fromConfig(opts, env) {
  const file = findConfig(opts.config, env);
  if (!file) return {};
  try { return (JSON.parse(fs.readFileSync(file, 'utf8')).testFramework) || {}; } catch (e) {
    throw usage(`cannot read ${file}: ${e.message}`);
  }
}

function runChild({ spawn, command, args, env, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 2, 2] });
    } catch (err) {
      resolve({ spawnError: err });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ spawnError: err }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut }); });
  });
}

async function main({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr, spawn = childProcess.spawn, now = Date.now } = {}) {
  const out = (obj) => stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write('Usage: run.js [--framework F] [--test-dir D] [--config-file F] [--spec S]... [--headed] [--out DIR] [--cwd D] [--config P] [--timeout-ms N] [--dry-run]\n');
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

    fs.rmSync(rawDir, { recursive: true, force: true }); // never let a previous run's report stand in for this one
    fs.mkdirSync(rawDir, { recursive: true });

    const started = now();
    const run = await runChild({ spawn, command: p.command, args: p.args, env: { ...env, ...p.env }, cwd: opts.cwd, timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS });
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

module.exports = { main };
