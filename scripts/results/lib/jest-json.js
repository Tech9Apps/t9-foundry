'use strict';

const { stripAnsi, truncate, firstLine, isTimeout, finish } = require('./shared');

// `jest --json` (also Vitest's --reporter=json, which uses the same shape): testResults[] (one per file) ->
// assertionResults[] with status passed | failed | pending | skipped | todo | disabled. No retry info.
function parse(src, opts) {
  const doc = typeof src === 'string' ? JSON.parse(src) : src;
  const tests = [];
  for (const file of doc.testResults || []) {
    const fileFailure = (file.assertionResults || []).length === 0 && file.status === 'failed';
    if (fileFailure) {
      // the file itself failed to run (syntax error, bad import): count it, never lose it
      tests.push({ name: file.name, file: file.name, status: 'failed', error: { message: truncate(firstLine(stripAnsi(file.message || '')) || 'test file failed to run', 1000), kind: 'error', ...(file.message ? { details: truncate(stripAnsi(file.message)) } : {}) } });
      continue;
    }
    for (const a of file.assertionResults || []) {
      const t = { name: a.title || a.fullName, status: a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped', file: file.name };
      if (a.ancestorTitles && a.ancestorTitles.length) t.suite = a.ancestorTitles.join(' › ');
      if (Number.isFinite(a.duration)) t.durationMs = a.duration;
      if (a.location && Number.isInteger(a.location.line)) t.line = a.location.line;
      if (t.status === 'failed') {
        const msgs = (a.failureMessages || []).map(stripAnsi);
        const full = msgs.join('\n');
        t.error = { message: truncate(firstLine(full) || 'failed', 1000), kind: isTimeout(full) ? 'timeout' : 'failure' };
        if (full && full !== t.error.message) t.error.details = truncate(full);
      }
      tests.push(t);
    }
  }
  return finish('jest-json', tests, opts);
}

module.exports = { parse };
