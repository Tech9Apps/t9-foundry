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

const PARSERS = {
  junit: require('./lib/junit'),
  tap: require('./lib/tap'),
  'playwright-json': require('./lib/playwright-json'),
  'jest-json': require('./lib/jest-json'),
};
const FORMATS = Object.keys(PARSERS);
const EXT = new Set(['.xml', '.json', '.tap']);

const usage = (message) => Object.assign(new Error(message), { isUsage: true });
const fail = (code, message) => Object.assign(new Error(message), { code });

function detect(text) {
  const t = text.replace(/^﻿/, '').trimStart();
  if (t.startsWith('<')) return 'junit';
  if (/^TAP version \d+/m.test(t.slice(0, 200)) || /^(not )?ok \d+/m.test(t)) return 'tap';
  if (t.startsWith('{')) {
    let doc;
    try { doc = JSON.parse(t); } catch { throw fail('UNRECOGNIZED', 'looks like JSON but does not parse'); }
    if (Array.isArray(doc.suites) && (doc.config || doc.stats)) return 'playwright-json';
    if (Array.isArray(doc.testResults)) return 'jest-json';
  }
  throw fail('UNRECOGNIZED', 'not JUnit XML, TAP, Playwright JSON or Jest JSON');
}

function parseText(text, format, opts) {
  const clean = text.replace(/^﻿/, '');
  const fmt = !format || format === 'auto' ? detect(clean) : format;
  if (!PARSERS[fmt]) throw usage(`unknown --format ${fmt} (use ${['auto', ...FORMATS].join(', ')})`);
  try { return PARSERS[fmt].parse(clean, opts); } catch (err) {
    if (err.code) throw err;
    throw fail('UNPARSEABLE', `could not read ${fmt}: ${err.message}`);
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
  if (formats.length > 1) throw fail('MIXED_FORMATS', `the reports in this directory are in different formats (${formats.join(', ')}): point at one report, or at a directory with one kind`);
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
function normalizePath(target, { format, framework } = {}) {
  let stat;
  try { stat = fs.statSync(target); } catch { throw fail('NOT_FOUND', `no such file or directory: ${target}`); }
  const opts = { framework };
  if (stat.isDirectory()) {
    const files = listFiles(target);
    if (!files.length) throw fail('NOT_FOUND', `no .xml/.json/.tap files in ${target}`);
    const parsed = [];
    for (const f of files) {
      try { parsed.push(parseText(fs.readFileSync(f, 'utf8'), format, opts)); } catch (err) {
        // a stray non-report JSON in the directory should not sink the rest; only fail if nothing parses
        if (err.isUsage) throw err;
      }
    }
    if (!parsed.length) throw fail('UNRECOGNIZED', `none of the ${files.length} file(s) in ${target} is a recognized test report`);
    return merge(parsed, opts);
  }
  return parseText(fs.readFileSync(target, 'utf8'), format, opts);
}

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let n = 0; n < argv.length; n += 1) {
    const flag = argv[n];
    const value = () => {
      if (n + 1 >= argv.length) throw usage(`${flag} needs a value`);
      n += 1;
      return argv[n];
    };
    if (flag === '--format') opts.format = value();
    else if (flag === '--framework') opts.framework = value();
    else if (flag === '--out') opts.out = value();
    else if (flag.startsWith('--')) throw usage(`unknown option ${flag}`);
    else rest.push(flag);
  }
  if (rest.length !== 1) throw usage('exactly one <file-or-dir> is required');
  opts.target = rest[0];
  return opts;
}

function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  const out = (obj) => stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write('Usage: normalize.js <file-or-dir> [--format auto|junit|tap|playwright-json|jest-json] [--framework NAME] [--out FILE]\n');
      return argv.length ? 0 : 2;
    }
    const opts = parseArgs(argv);
    const data = normalizePath(opts.target, opts);
    if (data.totals.total === 0) throw fail('NO_TESTS', `${opts.target} parsed as ${data.format} but contains no tests — the run executed nothing`);
    const doc = { ok: true, data };
    if (opts.out) {
      fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
      fs.writeFileSync(opts.out, `${JSON.stringify(doc, null, 2)}\n`);
    }
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

module.exports = { main, normalizePath, parseText, detect, FORMATS };
