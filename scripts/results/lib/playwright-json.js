'use strict';

const { stripAnsi, truncate, firstLine, finish } = require('./shared');

// Playwright's JSON reporter: suites[] -> suites[] -> specs[] -> tests[] (one per project) -> results[] (one
// per attempt). `test.status` is expected | unexpected | flaky | skipped; flaky is the one only this format
// reports natively: it failed, then passed on a retry.
function collect(suite, titles, out) {
  const here = suite.title && !/\.(spec|test)\.[cm]?[jt]sx?$/.test(suite.title) ? [...titles, suite.title] : titles;
  for (const spec of suite.specs || []) {
    for (const test of spec.tests || []) out.push({ spec, test, suite: here, file: spec.file || suite.file });
  }
  for (const child of suite.suites || []) collect(child, here, out);
}

function toTest({ spec, test, suite, file }) {
  const t = { name: spec.title, status: 'passed' };
  const suiteName = [...suite, ...(test.projectName ? [] : [])].join(' › ');
  if (suiteName) t.suite = suiteName;
  if (file) t.file = file;
  if (Number.isInteger(spec.line)) t.line = spec.line;
  const results = test.results || [];
  const last = results[results.length - 1];
  const total = results.reduce((n, r) => n + (r.duration || 0), 0);
  if (results.length) t.durationMs = total;
  if (results.length > 1) t.retries = results.length - 1;

  if (test.status === 'skipped' || (last && last.status === 'skipped')) {
    t.status = 'skipped';
  } else if (test.status === 'unexpected') {
    t.status = 'failed';
    const err = (last && (last.error || (last.errors || [])[0])) || {};
    const message = stripAnsi(err.message || '') || 'failed';
    t.error = { message: truncate(firstLine(message) || message, 1000), kind: last && last.status === 'timedOut' ? 'timeout' : 'failure' };
    const details = stripAnsi([err.message, err.stack].filter(Boolean).join('\n'));
    if (details && details !== t.error.message) t.error.details = truncate(details);
  } else if (test.status === 'flaky') {
    t.flaky = true;
  }
  if (test.projectName) t.name = `${spec.title} [${test.projectName}]`;
  return t;
}

function parse(src, opts) {
  const doc = typeof src === 'string' ? JSON.parse(src) : src;
  const found = [];
  for (const s of doc.suites || []) collect(s, [], found);
  const durationMs = doc.stats && Number.isFinite(doc.stats.duration) ? doc.stats.duration : undefined;
  return finish('playwright-json', found.map(toTest), { ...opts, durationMs });
}

module.exports = { parse };
