'use strict';

const { parseXml } = require('./xml');
const { stripAnsi, truncate, firstLine, isTimeout, finish } = require('./shared');

// JUnit XML is the lingua franca: pytest, Playwright, Cypress, WebdriverIO, RSpec (rspec_junit_formatter),
// Jest (jest-junit) and node:test all emit it. Be liberal in what we accept:
//   * the root may be <testsuites>, <testsuite>, or (node:test) <testsuites> with no <testsuite> inside
//   * a failure is a <failure> or <error> child; node:test also repeats it as a `failure=` attribute
//   * <flakyFailure>/<flakyError> children mean "failed, then passed on retry" (surefire / Playwright)
const textOf = (n) => stripAnsi(n.text || '').trim();

function walk(node, suiteName, out) {
  for (const child of node.children) {
    if (child.name === 'testsuite') walk(child, child.attrs.name || suiteName, out);
    else if (child.name === 'testsuites') walk(child, suiteName, out);
    else if (child.name === 'testcase') out.push({ node: child, suiteName });
  }
}

function toTest({ node, suiteName }) {
  const a = node.attrs;
  const kids = node.children;
  const failure = kids.find((k) => k.name === 'failure');
  const error = kids.find((k) => k.name === 'error');
  const skipped = kids.find((k) => k.name === 'skipped');
  const flakyKids = kids.filter((k) => k.name === 'flakyFailure' || k.name === 'flakyError');
  const reruns = kids.filter((k) => k.name === 'rerunFailure' || k.name === 'rerunError');

  const t = { name: a.name || '(unnamed)', status: 'passed' };
  const suite = a.classname && a.classname !== a.name ? a.classname : suiteName;
  if (suite) t.suite = suite;
  if (a.file) t.file = a.file;
  if (a.line && Number.isInteger(Number(a.line))) t.line = Number(a.line);
  if (a.time !== undefined && Number.isFinite(Number(a.time))) t.durationMs = Math.round(Number(a.time) * 1000000) / 1000;

  const problem = failure || error;
  if (problem) {
    t.status = 'failed';
    const details = textOf(problem);
    const message = stripAnsi(problem.attrs.message || a.failure || '') || firstLine(details) || 'failed';
    t.error = { message: truncate(message, 1000), kind: failure ? (isTimeout(`${problem.attrs.type} ${message}`) ? 'timeout' : 'failure') : 'error' };
    if (details && details !== message) t.error.details = truncate(details);
    if (reruns.length) t.retries = reruns.length;
  } else if (skipped) {
    t.status = 'skipped';
  } else if (flakyKids.length) {
    t.flaky = true;
    t.retries = flakyKids.length;
  }
  return t;
}

function parse(src, opts) {
  const root = parseXml(src);
  const found = [];
  walk(root, undefined, found);
  return finish('junit', found.map(toTest), opts);
}

module.exports = { parse };
