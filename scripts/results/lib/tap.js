'use strict';

const { stripAnsi, truncate, firstLine, isTimeout, finish } = require('./shared');

// TAP 13 as written by `node --test --test-reporter=tap` (and most other TAP producers): "ok N - name" /
// "not ok N - name", optionally followed by an indented YAML diagnostic block between "---" and "...".
// Nested subtests are written children-first, so a point that directly follows deeper-indented points is
// a parent: it is dropped and its children are kept, with its name as their suite.
const POINT = /^(\s*)(not ok|ok)\s+\d+\s*(?:-\s*)?(.*)$/;

// node:test reports EVERY error thrown in a test body with failureType "testCodeFailure" — a failed assertion and a `fetch failed` TypeError alike.
// Only the error's own code/name tell them apart, and the difference matters: a failed assertion is evidence about the app, a thrown
// error is not (it is a crash, a network error, a bug in the test), and triage turns "assertion about the app" into a bug report.
const isAssertion = (y) => y.code === 'ERR_ASSERTION' || y.name === 'AssertionError';

function parseYamlBlock(lines) {
  const fields = {};
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const [, indent, key, rest] = m;
    if (/^[|>][+-]?$/.test(rest)) {
      const body = [];
      while (i + 1 < lines.length && (/^\s*$/.test(lines[i + 1]) || lines[i + 1].match(/^(\s*)/)[1].length > indent.length)) {
        i += 1;
        body.push(lines[i]);
      }
      const pad = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^(\s*)/)[1].length), Infinity);
      fields[key] = body.map((l) => l.slice(Number.isFinite(pad) ? pad : 0)).join('\n').trim();
    } else {
      fields[key] = rest.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return fields;
}

function parse(src, opts) {
  const lines = String(src).split(/\r?\n/);
  const points = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(POINT);
    if (!m) continue;
    const indent = m[1].length;
    let name = m[3];
    let directive = '';
    const d = name.match(/\s+#\s*(SKIP|TODO)\b.*$/i);
    if (d) { directive = d[1].toUpperCase(); name = name.slice(0, d.index); }
    const point = { indent, ok: m[2] === 'ok', name: name.trim(), directive, yaml: {} };
    // YAML diagnostics, if any, start on the next line
    let j = i + 1;
    if (lines[j] !== undefined && /^\s*---\s*$/.test(lines[j])) {
      const body = [];
      j += 1;
      while (j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j])) { body.push(lines[j]); j += 1; }
      point.yaml = parseYamlBlock(body);
      i = j;
    }
    points.push(point);
  }

  // Children are written before their parent. A point that directly follows deeper-indented points is a
  // parent: drop it, keep the children, and name their suite after it.
  const stack = [];
  const leaves = [];
  for (const p of points) {
    const kids = [];
    while (stack.length && stack[stack.length - 1].indent > p.indent) kids.unshift(stack.pop());
    for (const k of kids) { if (!k.suite) k.suite = p.name; }
    p.isParent = kids.length > 0;
    stack.push(p);
  }
  for (const p of points) { if (!p.isParent) leaves.push(p); }
  const all = leaves;

  const tests = all.map((p) => {
    const t = { name: p.name || '(unnamed)', status: p.ok ? 'passed' : 'failed' };
    if (p.suite) t.suite = p.suite;
    if (p.directive) t.status = 'skipped';
    const y = p.yaml;
    if (y.duration_ms !== undefined && Number.isFinite(Number(y.duration_ms))) t.durationMs = Number(y.duration_ms);
    if (y.location) {
      const loc = String(y.location).match(/^(.*?):(\d+)(?::\d+)?$/);
      if (loc) { t.file = loc[1]; t.line = Number(loc[2]); }
    }
    if (t.status === 'failed') {
      const message = stripAnsi(y.error || y.message || '') || 'failed';
      t.error = { message: truncate(firstLine(message) === message ? message : message.split('\n\n')[0], 1000), kind: y.failureType === 'testTimeoutFailure' || isTimeout(message) ? 'timeout' : (isAssertion(y) ? 'failure' : 'error') };
      const full = stripAnsi([y.error, y.stack].filter(Boolean).join('\n'));
      if (full && full !== t.error.message) t.error.details = truncate(full);
      if (y.expected !== undefined) t.error.expected = String(y.expected);
      if (y.actual !== undefined) t.error.actual = String(y.actual);
    }
    return t;
  });
  return finish('tap', tests, opts);
}

module.exports = { parse };
