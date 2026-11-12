#!/usr/bin/env node
'use strict';

// Turn any supported test-run output into one normalized result ([schemas/run-result.schema.json]).
//
//   node scripts/results/normalize.js <file-or-dir> [--format auto|junit|tap|playwright-json|jest-json]
//                                     [--framework <name>] [--out <file>]
//
// A directory is read file by file (WebdriverIO writes one JUnit file per worker) and merged.
// Output: { "ok": true, "data": <run result> } on stdout (and to --out, if given).
// Exit 0 = parsed · 1 = unreadable / unrecognized / ZERO tests (a run that ran nothing is never a pass) · 2 = bad invocation.
// Test failures are data, not an error: a run with failing tests still exits 0.

const fs = require('fs');
const path = require('path');
const { usage, parseFlags, jsonPrinter, codedError, writeJson } = require('../lib/cli');

const PARSERS = {
  junit: require('./lib/junit'),
  tap: require('./lib/tap'),
  'playwright-json': require('./lib/playwright-json'),
  'jest-json': require('./lib/jest-json'),
};
const FORMATS = Object.keys(PARSERS);
const EXT = new Set(['.xml', '.json', '.tap']);

function detect(text) {
  const t = text.replace(/^﻿/, '').trimStart();
  if (t.startsWith('<')) return 'junit';
  if (/^TAP version \d+/m.test(t.slice(0, 200)) || /^(not )?ok \d+/m.test(t)) return 'tap';
  if (t.startsWith('{')) {
    let doc;
    try { doc = JSON.parse(t); } catch { throw codedError('UNPARSEABLE', 'looks like JSON but does not parse (cut off or damaged?)'); }
    if (Array.isArray(doc.suites) && (doc.config || doc.stats)) return 'playwright-json';
    if (Array.isArray(doc.testResults)) return 'jest-json';
  }
  throw codedError('UNRECOGNIZED', 'not JUnit XML, TAP, Playwright JSON or Jest JSON');
}

function parseText(text, format, opts) {
  const clean = text.replace(/^﻿/, '');
  const fmt = !format || format === 'auto' ? detect(clean) : format;
  if (!PARSERS[fmt]) throw usage(`unknown --format ${fmt} (use ${['auto', ...FORMATS].join(', ')})`);
  try { return PARSERS[fmt].parse(clean, opts); } catch (err) {
    if (err.code) throw err;
    throw codedError('UNPARSEABLE', `could not read ${fmt}: ${err.message}`);
  }
}

function listFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

function merge(results, opts) {
  if (results.length === 1) return results[0];
  const tests = results.flatMap((r) => r.tests);
  const flaky = tests.filter((t) => t.flaky).length;
  const durationMs = results.reduce((n, r) => n + (r.durationMs || 0), 0);
  const formats = [...new Set(results.map((r) => r.format))];
  // The merged result names ONE format, and triage decides what may act on it by that name. Naming the first file's format for a mix of formats
  // would let reports nobody verified ride on a trusted one.
  if (formats.length > 1) throw codedError('MIXED_FORMATS', `the reports in this directory are in different formats (${formats.join(', ')}): point at one report, or at a directory with one kind`);
  return {
    format: formats[0],
    ...(opts.framework ? { framework: opts.framework } : {}),
    ...(durationMs ? { durationMs } : {}),
    totals: {
      total: tests.length,
      passed: tests.filter((t) => t.status === 'passed').length,
      failed: tests.filter((t) => t.status === 'failed').length,
      skipped: tests.filter((t) => t.status === 'skipped').length,
      ...(flaky ? { flaky } : {}),
    },
    tests,
  };
}

// Pure entry point (also used by run.js and the tests): path or directory in, result out.
// `warnings` (an array) collects what was left out: a file in a directory that is not a test report.
function normalizePath(target, { format, framework, warnings = [] } = {}) {
  let stat;
  try { stat = fs.statSync(target); } catch { throw codedError('NOT_FOUND', `no such file or directory: ${target}`); }
  const opts = { framework };
  if (stat.isDirectory()) {
    const files = listFiles(target);
    if (!files.length) throw codedError('NOT_FOUND', `no .xml/.json/.tap files in ${target}`);
    const parsed = [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      try { parsed.push(parseText(text, format, opts)); } catch (err) {
        if (err.isUsage) throw err;
        if (text.trim() === '') throw codedError('UNPARSEABLE', `${f} is empty (a runner that crashed before it wrote its report?)`);
        // A file that is not a test report at all (a package.json, a config: detection found no format) is left out, and the result says so. A file
        // that IS a report but cannot be read fails the run: dropping it would present the rest as the whole run.
        if (err.code === 'UNRECOGNIZED') { warnings.push(`${f}: not a test report (${err.message}), ignored`); continue; }
        throw codedError(err.code || 'UNPARSEABLE', `${f}: ${err.message}`);
      }
    }
    if (!parsed.length) throw codedError('UNRECOGNIZED', `none of the ${files.length} file(s) in ${target} is a recognized test report`);
    return merge(parsed, opts);
  }
  return parseText(fs.readFileSync(target, 'utf8'), format, opts);
}

const FLAGS = {
  '--format': { key: 'format' },
  '--framework': { key: 'framework' },
  '--out': { key: 'out' },
};

function parseArgs(argv) {
  const { _: rest, ...opts } = parseFlags(argv, FLAGS, { positionals: true });
  if (rest.length !== 1) throw usage('exactly one <file-or-dir> is required');
  opts.target = rest[0];
  return opts;
}

function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  const out = jsonPrinter(stdout);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write('Usage: normalize.js <file-or-dir> [--format auto|junit|tap|playwright-json|jest-json] [--framework NAME] [--out FILE]\n');
      return argv.length ? 0 : 2;
    }
    const opts = parseArgs(argv);
    const warnings = [];
    const data = normalizePath(opts.target, { ...opts, warnings });
    if (data.totals.total === 0) throw codedError('NO_TESTS', `${opts.target} parsed as ${data.format} but contains no tests — the run executed nothing`);
    const doc = { ok: true, data, ...(warnings.length ? { warnings } : {}) };
    if (opts.out) writeJson(opts.out, doc);
    out(doc);
    return 0;
  } catch (err) {
    if (err && err.isUsage) {
      stderr.write(`normalize.js: ${err.message}\n`);
      return 2;
    }
    out({ ok: false, error: { code: err.code || 'UNPARSEABLE', message: err.message } });
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, normalizePath, parseText, detect, FORMATS, FLAGS };
